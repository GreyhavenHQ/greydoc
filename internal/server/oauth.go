package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html/template"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/greyhavenhq/greydoc/internal/secrets"
	"github.com/greyhavenhq/greydoc/internal/store"
)

// OAuth 2.1 authorization server for MCP clients: metadata (RFC 8414, RFC 9728), dynamic client
// registration (RFC 7591), authorization code with PKCE S256, refresh token rotation, revocation.
// People sign in through OIDC. The tokens act with that person's rights, capped by each note's agent policy.

func (s *Server) handleResourceMetadata(w http.ResponseWriter, r *http.Request) {
	base := s.baseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 base + "/mcp",
		"authorization_servers":    []string{base},
		"scopes_supported":         allScopes,
		"bearer_methods_supported": []string{"header"},
		"resource_name":            "greydoc",
	})
}

func (s *Server) handleASMetadata(w http.ResponseWriter, r *http.Request) {
	base := s.baseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                base,
		"authorization_endpoint":                base + "/oauth/authorize",
		"token_endpoint":                        base + "/oauth/token",
		"registration_endpoint":                 base + "/oauth/register",
		"revocation_endpoint":                   base + "/oauth/revoke",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none", "client_secret_post", "client_secret_basic"},
		"scopes_supported":                      allScopes,
	})
}

func oauthError(w http.ResponseWriter, status int, code, desc string) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, map[string]string{"error": code, "error_description": desc})
}

func validRedirectURI(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() || u.Fragment != "" {
		return false
	}
	switch u.Scheme {
	case "https":
		return true
	case "http":
		h := u.Hostname()
		return h == "localhost" || h == "127.0.0.1" || h == "::1"
	case "javascript", "data", "file", "vbscript":
		return false
	}
	// Native apps use private-use schemes such as com.example.app:/callback.
	return strings.Contains(u.Scheme, ".") || u.Scheme == "cursor" || u.Scheme == "vscode"
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClientName   string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
		AuthMethod   string   `json:"token_endpoint_auth_method"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "invalid JSON")
		return
	}
	if len(req.RedirectURIs) == 0 || len(req.RedirectURIs) > 10 {
		oauthError(w, http.StatusBadRequest, "invalid_redirect_uri", "one to ten redirect_uris are required")
		return
	}
	for _, u := range req.RedirectURIs {
		if !validRedirectURI(u) {
			oauthError(w, http.StatusBadRequest, "invalid_redirect_uri", "redirect URI not allowed: "+u)
			return
		}
	}
	if req.AuthMethod == "" {
		req.AuthMethod = "client_secret_basic"
	}
	if !slices.Contains([]string{"none", "client_secret_post", "client_secret_basic"}, req.AuthMethod) {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "unsupported token_endpoint_auth_method")
		return
	}
	name := strings.TrimSpace(req.ClientName)
	if name == "" {
		name = "MCP client"
	}
	if len(name) > 100 {
		name = name[:100]
	}
	c := &store.OAuthClient{ID: "gd_client_" + secrets.NewID(), Name: name, RedirectURIs: req.RedirectURIs, AuthMethod: req.AuthMethod}
	resp := map[string]any{
		"client_id":                  c.ID,
		"client_name":                c.Name,
		"redirect_uris":              c.RedirectURIs,
		"token_endpoint_auth_method": c.AuthMethod,
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"client_id_issued_at":        time.Now().Unix(),
	}
	if c.AuthMethod != "none" {
		secret := secrets.NewToken("")
		c.SecretHash = secrets.Hash(s.secret, secret)
		resp["client_secret"] = secret
		resp["client_secret_expires_at"] = 0
	}
	if err := s.store.CreateOAuthClient(r.Context(), c); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, resp)
}

// authzRequest is what the consent form carries, signed, between GET and POST /oauth/authorize.
type authzRequest struct {
	ClientID    string `json:"c"`
	RedirectURI string `json:"r"`
	Challenge   string `json:"p"`
	Scope       string `json:"s"`
	State       string `json:"t"`
	Resource    string `json:"x"`
	UserID      string `json:"u"`
}

func normalizeScope(raw string) string {
	var out []string
	for _, s := range strings.Fields(raw) {
		if slices.Contains(allScopes, s) && !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		out = allScopes
	}
	return strings.Join(out, " ")
}

func (s *Server) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	client, err := s.store.OAuthClient(r.Context(), q.Get("client_id"))
	if err != nil {
		http.Error(w, "unknown client_id", http.StatusBadRequest)
		return
	}
	redirect := q.Get("redirect_uri")
	if redirect == "" && len(client.RedirectURIs) == 1 {
		redirect = client.RedirectURIs[0]
	}
	if !slices.Contains(client.RedirectURIs, redirect) {
		http.Error(w, "redirect_uri is not registered for this client", http.StatusBadRequest)
		return
	}
	fail := func(code, desc string) {
		u, _ := url.Parse(redirect)
		v := u.Query()
		v.Set("error", code)
		v.Set("error_description", desc)
		if st := q.Get("state"); st != "" {
			v.Set("state", st)
		}
		u.RawQuery = v.Encode()
		http.Redirect(w, r, u.String(), http.StatusFound)
	}
	if q.Get("response_type") != "code" {
		fail("unsupported_response_type", "only response_type=code is supported")
		return
	}
	if q.Get("code_challenge") == "" || q.Get("code_challenge_method") != "S256" {
		fail("invalid_request", "PKCE with S256 is required")
		return
	}
	id := identityFrom(r.Context())
	if id == nil || id.isAgent() {
		http.Redirect(w, r, "/auth/login?next="+url.QueryEscape(r.URL.RequestURI()), http.StatusFound)
		return
	}
	req := authzRequest{ClientID: client.ID, RedirectURI: redirect, Challenge: q.Get("code_challenge"),
		Scope: normalizeScope(q.Get("scope")), State: q.Get("state"), Resource: q.Get("resource"), UserID: id.UserID()}
	b, _ := json.Marshal(req)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self' "+formTarget(redirect))
	_ = consentPage.Execute(w, map[string]any{
		"Client": client.Name, "User": id.displayName(), "Consent": s.makeToken(string(b), 10*time.Minute),
		"Write": strings.Contains(req.Scope, scopeWrite), "Local": id.Local, "Logo": template.HTML(logoSVG),
	})
}

func formTarget(redirect string) string {
	u, err := url.Parse(redirect)
	if err != nil {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

func (s *Server) handleAuthorizeDecision(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil || id.isAgent() {
		http.Error(w, "sign in first", http.StatusUnauthorized)
		return
	}
	raw, ok := s.verifyToken(r.FormValue("consent"))
	var req authzRequest
	if !ok || json.Unmarshal([]byte(raw), &req) != nil || req.UserID != id.UserID() {
		http.Error(w, "the consent form expired; start again from your MCP client", http.StatusBadRequest)
		return
	}
	u, _ := url.Parse(req.RedirectURI)
	v := u.Query()
	if req.State != "" {
		v.Set("state", req.State)
	}
	if r.FormValue("approve") != "1" {
		v.Set("error", "access_denied")
		u.RawQuery = v.Encode()
		http.Redirect(w, r, u.String(), http.StatusFound)
		return
	}
	code := secrets.NewToken("gd_code_")
	if err := s.store.CreateOAuthCode(r.Context(), secrets.Hash(s.secret, code), store.OAuthCode{
		ClientID: req.ClientID, UserID: req.UserID, RedirectURI: req.RedirectURI, Challenge: req.Challenge,
		Scope: req.Scope, Resource: req.Resource, ExpiresAt: store.FormatTime(time.Now().Add(5 * time.Minute)),
	}); err != nil {
		internalError(w, err)
		return
	}
	v.Set("code", code)
	v.Set("iss", s.baseURL(r))
	u.RawQuery = v.Encode()
	http.Redirect(w, r, u.String(), http.StatusFound)
}

// authenticateClient checks client credentials for confidential clients. Public clients send only client_id.
func (s *Server) authenticateClient(r *http.Request) (*store.OAuthClient, error) {
	id, secret, basic := r.BasicAuth()
	if !basic {
		id, secret = r.PostFormValue("client_id"), r.PostFormValue("client_secret")
	}
	c, err := s.store.OAuthClient(r.Context(), id)
	if err != nil {
		return nil, errors.New("unknown client")
	}
	if c.AuthMethod != "none" {
		if subtle.ConstantTimeCompare([]byte(secrets.Hash(s.secret, secret)), []byte(c.SecretHash)) != 1 {
			return nil, errors.New("bad client secret")
		}
	}
	return c, nil
}

func (s *Server) issueTokens(w http.ResponseWriter, r *http.Request, c *store.OAuthClient, userID, scope, family string) {
	access := secrets.NewToken(accessPrefix)
	refresh := secrets.NewToken(refreshPrefix)
	if family == "" {
		family = secrets.NewID()
	}
	label := c.Name
	for _, t := range []struct {
		kind, tok string
		ttl       time.Duration
	}{{store.TokenAccess, access, accessTTL}, {store.TokenRefresh, refresh, refreshTTL}} {
		if err := s.store.CreateToken(r.Context(), &store.Token{UserID: userID, Kind: t.kind, Label: label, ClientID: c.ID, Scope: scope,
			Family: family, ExpiresAt: store.FormatTime(time.Now().Add(t.ttl))}, secrets.Hash(s.secret, t.tok)); err != nil {
			internalError(w, err)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": access, "token_type": "Bearer", "expires_in": int(accessTTL.Seconds()),
		"refresh_token": refresh, "scope": scope,
	})
}

func pkceMatches(verifier, challenge string) bool {
	sum := sha256.Sum256([]byte(verifier))
	return subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(challenge)) == 1
}

func (s *Server) handleToken(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	c, err := s.authenticateClient(r)
	if err != nil {
		oauthError(w, http.StatusUnauthorized, "invalid_client", err.Error())
		return
	}
	switch r.PostFormValue("grant_type") {
	case "authorization_code":
		code, err := s.store.ConsumeOAuthCode(r.Context(), secrets.Hash(s.secret, r.PostFormValue("code")))
		if err != nil || code.ClientID != c.ID {
			oauthError(w, http.StatusBadRequest, "invalid_grant", "the code is invalid, expired or already used")
			return
		}
		if code.RedirectURI != r.PostFormValue("redirect_uri") {
			oauthError(w, http.StatusBadRequest, "invalid_grant", "redirect_uri does not match")
			return
		}
		if !pkceMatches(r.PostFormValue("code_verifier"), code.Challenge) {
			oauthError(w, http.StatusBadRequest, "invalid_grant", "PKCE verification failed")
			return
		}
		if u, err := s.store.UserByID(r.Context(), code.UserID); err == nil {
			_ = s.store.AddEvent(r.Context(), &store.Event{ActorID: u.ID, ActorName: u.DisplayName, Kind: "oauth.connect", Client: c.Name,
				Data: map[string]any{"client": c.Name, "scope": code.Scope}})
		}
		s.issueTokens(w, r, c, code.UserID, code.Scope, "")
	case "refresh_token":
		hash := secrets.Hash(s.secret, r.PostFormValue("refresh_token"))
		old, err := s.store.TokenByHash(r.Context(), store.TokenRefresh, hash)
		if errors.Is(err, store.ErrNotFound) {
			// A rotated token presented again means it leaked. Every token of the family goes.
			if known, err := s.store.RevokeFamilyByHash(r.Context(), hash); err == nil && known {
				slog.Warn("refresh token reused, family revoked", "client", c.Name)
			}
			oauthError(w, http.StatusBadRequest, "invalid_grant", "the refresh token is invalid or expired")
			return
		}
		if err != nil || old.ClientID != c.ID {
			oauthError(w, http.StatusBadRequest, "invalid_grant", "the refresh token is invalid or expired")
			return
		}
		scope := old.Scope
		if req := r.PostFormValue("scope"); req != "" {
			granted := strings.Fields(old.Scope)
			for _, sc := range strings.Fields(req) {
				if !slices.Contains(granted, sc) {
					oauthError(w, http.StatusBadRequest, "invalid_scope", "a refresh cannot add the scope "+sc)
					return
				}
			}
			scope = normalizeScope(req)
		}
		if _, err := s.store.RotateRefreshToken(r.Context(), hash); err != nil {
			oauthError(w, http.StatusBadRequest, "invalid_grant", "the refresh token is invalid or expired")
			return
		}
		s.issueTokens(w, r, c, old.UserID, scope, old.Family)
	default:
		oauthError(w, http.StatusBadRequest, "unsupported_grant_type", "use authorization_code or refresh_token")
	}
}

func (s *Server) handleRevoke(w http.ResponseWriter, r *http.Request) {
	if _, err := s.authenticateClient(r); err != nil {
		oauthError(w, http.StatusUnauthorized, "invalid_client", err.Error())
		return
	}
	if err := s.store.DeleteTokenByHash(r.Context(), secrets.Hash(s.secret, r.PostFormValue("token"))); err != nil {
		slog.Warn("token revoke failed", "error", err)
	}
	w.WriteHeader(http.StatusOK)
}

// logoSVG is the Greyhaven symbol of the sign-in card, drawn in the text color.
const logoSVG = `<svg class="logo" viewBox="0 0 151.08 184" aria-hidden="true" fill="currentColor"><path d="M131.08,52.32l-18.67-10.96h-1.01l-16.68,9.79v-20.19s-18.67-10.96-18.67-10.96h-1.01l-18.67,10.96v20.19s-16.68-9.79-16.68-9.79h-1.01l-18.67,10.96v.72s0,78.5,0,78.5l18.67,11.12h1.02l16.67-9.92v20.16s18.67,11.12,18.67,11.12h1.02l18.67-11.12v-20.16s16.67,9.92,16.67,9.92h1.02l18.67-11.12V52.32ZM39.18,43.38l16.7,9.81-16.7,9.94-16.7-9.94,16.7-9.81ZM22,55.23l16.18,9.63v54.28l-16.18,9.5V55.23ZM38.18,121.46v18.57l-15.7-9.35,15.7-9.22ZM40.18,140.03v-18.57l15.7,9.22-15.7,9.35ZM56.36,128.64l-16.18-9.5v-54.28l16.18-9.63v73.41ZM92.72,53.04v19.46l-16.18-9.5v-19.49l16.18-9.63v19.16ZM75.54,84.48l-16.7-9.94,16.7-9.81,16.7,9.81-16.7,9.94ZM76.54,41.18v-18.57l15.7,9.22-15.7,9.35ZM74.54,22.61v18.57l-15.7-9.35,15.7-9.22ZM58.36,33.87l16.18,9.63v19.49l-16.18,9.5v-38.63ZM58.36,76.58l16.18,9.63v54.28l-16.18,9.5v-73.41ZM74.54,142.81v18.57l-15.7-9.35,15.7-9.22ZM76.54,161.38v-18.57l15.7,9.22-15.7,9.35ZM92.72,149.99l-16.18-9.5v-54.28l16.18-9.63v73.41ZM112.9,43.97l15.7,9.22-15.7,9.35v-18.57ZM110.9,43.97v18.57l-15.7-9.35,15.7-9.22ZM94.72,55.23l16.18,9.63v54.28l-16.18,9.5V55.23ZM111.9,140.63l-16.7-9.95,16.7-9.81,16.7,9.81-16.7,9.95ZM129.08,128.64l-16.18-9.5v-54.28l16.18-9.63v73.41Z"/></svg>`

var consentPage = template.Must(template.New("consent").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect {{.Client}} to greydoc</title>
<style>
@font-face{font-family:Aspekta;font-weight:400;src:url(/fonts/Aspekta-400.woff2) format("woff2")}
@font-face{font-family:Aspekta;font-weight:600;src:url(/fonts/Aspekta-600.woff2) format("woff2")}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f0f0ec;color:#161614;
font:15px/1.5 Aspekta,ui-sans-serif,system-ui,sans-serif}
@media (prefers-color-scheme:dark){body{background:#161614;color:#f9f9f7}.card{background:#2f2f2c!important;border-color:#575753!important}.muted{color:#c4c4bd!important}button{border-color:#575753!important}}
.card{width:100%;max-width:384px;margin:16px;padding:32px 24px 24px;background:#f9f9f7;border:1px solid #c4c4bd;border-radius:12px;box-sizing:border-box}
.head{text-align:center;margin-bottom:20px}.logo{height:40px;width:auto;display:block;margin:0 auto 8px}
.name{font:600 24px/1.2 "Source Serif 4","Source Serif Pro",Georgia,serif}
.muted{color:#575753}ul{padding-left:20px;margin:12px 0}li{margin:4px 0}p{margin:0}
.row{display:flex;gap:8px;margin-top:20px}.row button{flex:1}
button{font:inherit;font-weight:600;padding:9px 16px;border-radius:6px;border:1px solid #c4c4bd;background:transparent;color:inherit;cursor:pointer}
button.primary{background:#d95e2a;border-color:#d95e2a!important;color:#f9f9f7}
</style></head><body><form class="card" method="post" action="/oauth/authorize">
<div class="head">{{.Logo}}<div class="name">greydoc</div></div>
<p><strong>{{.Client}}</strong> wants to use greydoc as <strong>{{.User}}</strong>.</p>
<ul>
<li>Read notes you can read</li>
{{if .Write}}<li>Comment, suggest changes, and edit notes whose agent policy allows it</li>{{end}}
</ul>
<p class="muted">Its changes are marked as made by an agent. You can disconnect it in Settings.</p>
<input type="hidden" name="consent" value="{{.Consent}}">
<div class="row"><button type="submit" name="approve" value="0">Deny</button>
<button class="primary" type="submit" name="approve" value="1">Allow</button></div>
</form></body></html>`))
