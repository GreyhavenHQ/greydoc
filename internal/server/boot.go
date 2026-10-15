package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
)

// The first page of a visit needs /api/me, and the view and slide pages need the note. The server inlines
// these answers in the HTML, so the browser saves two or three round trips. Each answer comes from the
// API handler itself, with the same access checks.

type recorder struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (r *recorder) Header() http.Header { return r.header }
func (r *recorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.body.Write(b)
}
func (r *recorder) WriteHeader(status int) { r.status = status }

// internalGet runs an API handler for the page request r and returns its JSON when it answers 200.
func (s *Server) internalGet(r *http.Request, path, query string, header map[string]string) json.RawMessage {
	req := r.Clone(r.Context())
	req.Method = http.MethodGet
	req.URL = &url.URL{Path: path, RawQuery: query}
	req.RequestURI = ""
	req.Body = http.NoBody
	for _, h := range []string{"If-None-Match", "If-Modified-Since", "Range"} {
		req.Header.Del(h)
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := &recorder{header: http.Header{}}
	s.mux.ServeHTTP(rec, req)
	if rec.status != http.StatusOK || !json.Valid(rec.body.Bytes()) {
		return nil
	}
	return bytes.TrimSpace(rec.body.Bytes())
}

type bootNote struct {
	Alias string          `json:"alias"`
	Data  json.RawMessage `json:"data"`
}

type bootData struct {
	Me    json.RawMessage `json:"me,omitempty"`
	Note  *bootNote       `json:"note,omitempty"`
	Share *struct {
		Token string `json:"token"`
		Alias string `json:"alias"`
	} `json:"share,omitempty"`
}

// pageSegment returns the one path segment after prefix, as in /s/<alias>.
func pageSegment(path, prefix string) string {
	rest, ok := strings.CutPrefix(path, prefix)
	if !ok || rest == "" || strings.Contains(rest, "/") {
		return ""
	}
	return rest
}

func (s *Server) bootFor(r *http.Request) bootData {
	b := bootData{Me: s.internalGet(r, "/api/me", "", nil)}
	noteQuery := url.Values{"visit": {"1"}}
	if share := r.URL.Query().Get("share"); share != "" {
		noteQuery.Set("share", share)
	}
	alias := pageSegment(r.URL.Path, "/s/")
	if alias == "" {
		alias = pageSegment(r.URL.Path, "/p/")
	}
	var header map[string]string
	if token := pageSegment(r.URL.Path, "/v/"); token != "" {
		var res struct {
			Alias string `json:"alias"`
		}
		if raw := s.internalGet(r, "/api/share/"+url.PathEscape(token), "", nil); raw == nil || json.Unmarshal(raw, &res) != nil {
			return b
		}
		alias, header = res.Alias, map[string]string{"X-Share-Token": token}
		b.Share = &struct {
			Token string `json:"token"`
			Alias string `json:"alias"`
		}{token, alias}
	}
	if alias != "" {
		if raw := s.internalGet(r, "/api/notes/"+url.PathEscape(alias), noteQuery.Encode(), header); raw != nil {
			b.Note = &bootNote{Alias: alias, Data: raw}
		}
	}
	return b
}

// serveIndex writes index.html with the boot data before </head>.
func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request, index []byte) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Vary", "Cookie")
	if r.Method == http.MethodHead {
		return
	}
	// json.Marshal escapes <, > and &, so note text cannot close the script element.
	data, err := json.Marshal(s.bootFor(r))
	if err != nil {
		_, _ = w.Write(index)
		return
	}
	out := bytes.Replace(index, []byte("</head>"),
		append(append([]byte(`<script id="greydoc-boot" type="application/json">`), data...), []byte("</script></head>")...), 1)
	_, _ = w.Write(out)
}
