package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/greyhavenhq/greydoc/internal/collab"
	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

const mcpInstructions = `greydoc is a shared Markdown notes server.
Every note has an agent policy set by its owner: none, read, suggest or edit.
Under "suggest", edit_note creates a suggestion that a person accepts or rejects; the text does not change until then.
Quote text exactly (old_text, quote) to target a range. If the quote is not unique, quote more context or pass occurrence.
Everything you do is recorded in the note timeline as done by an agent on behalf of the signed-in user.`

// mcpHandler serves the MCP Streamable HTTP endpoint. In OIDC mode it needs a bearer token.
func (s *Server) mcpHandler() http.Handler {
	srv := mcp.NewServer(&mcp.Implementation{Name: "greydoc", Version: "1"}, &mcp.ServerOptions{Instructions: mcpInstructions})
	s.registerTools(srv)
	var h http.Handler = mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, &mcp.StreamableHTTPOptions{
		SessionTimeout:             30 * time.Minute,
		DisableLocalhostProtection: !s.cfg.LocalMode(),
	})
	if s.cfg.LocalMode() {
		return localOnlyOrigin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			s.seenBase.Store(s.baseURL(r))
			h.ServeHTTP(w, r)
		}))
	}
	h0 := h
	h = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.seenBase.Store(s.baseURL(r))
		h0.ServeHTTP(w, r)
	})
	verifier := func(ctx context.Context, token string, r *http.Request) (*auth.TokenInfo, error) {
		id := identityFrom(r.Context())
		if id == nil || !id.isAgent() {
			return nil, auth.ErrInvalidToken
		}
		return &auth.TokenInfo{UserID: id.UserID(), Scopes: id.Scopes, Expiration: id.expiry(), Extra: map[string]any{"identity": id}}, nil
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth.RequireBearerToken(verifier, &auth.RequireBearerTokenOptions{
			ResourceMetadataURL: s.baseURL(r) + "/.well-known/oauth-protected-resource/mcp",
		})(h).ServeHTTP(w, r)
	})
}

func (id *Identity) expiry() time.Time {
	if id.tokenExpiry.IsZero() {
		return time.Now().Add(time.Hour)
	}
	return id.tokenExpiry
}

// localOnlyOrigin refuses browser pages from other origins, so a website cannot drive a local server.
func localOnlyOrigin(h http.Handler) http.Handler {
	cop := http.NewCrossOriginProtection()
	return cop.Handler(h)
}

// mcpIdentity is the caller of a tool call: the token's user, or the local user. Tools always act as an agent.
func (s *Server) mcpIdentity(req *mcp.CallToolRequest) (*Identity, error) {
	var id *Identity
	if req.Extra != nil && req.Extra.TokenInfo != nil {
		id, _ = req.Extra.TokenInfo.Extra["identity"].(*Identity)
	}
	if id == nil {
		if !s.cfg.LocalMode() {
			return nil, errors.New("not authenticated")
		}
		id = &Identity{User: s.localUser, Local: true}
	}
	cp := *id
	if cp.Via != "oauth" {
		cp.Via = "mcp"
		if p := req.Session.InitializeParams(); p != nil && p.ClientInfo != nil && p.ClientInfo.Name != "" {
			cp.Client = p.ClientInfo.Name
		}
	}
	if cp.Client == "" {
		cp.Client = "MCP client"
	}
	return &cp, nil
}

// noteRef accepts an alias, a path such as /n/alias, or a full note URL.
func noteRef(ref string) (alias, share string) {
	ref = strings.TrimSpace(ref)
	if u, err := url.Parse(ref); err == nil && (u.Scheme != "" || strings.HasPrefix(ref, "/")) {
		share = u.Query().Get("share")
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		return parts[len(parts)-1], share
	}
	return ref, ""
}

func (s *Server) mcpNote(ctx context.Context, id *Identity, ref string, need permission.Level) (*store.Note, permission.Level, error) {
	alias, share := noteRef(ref)
	n, err := s.store.NoteByAlias(ctx, alias)
	if errors.Is(err, store.ErrNotFound) {
		return nil, 0, fmt.Errorf("no note %q", alias)
	}
	if err != nil {
		return nil, 0, err
	}
	if n.DeletedAt != "" {
		return nil, 0, fmt.Errorf("note %q is in the trash; restore_note brings it back", alias)
	}
	l, err := s.noteLevel(ctx, id, n, share)
	if err != nil {
		return nil, 0, err
	}
	if l < need {
		if l == permission.Deny {
			return nil, l, fmt.Errorf("no access to note %q (agent policy %q)", alias, n.AgentPolicy)
		}
		return nil, l, fmt.Errorf("this needs %s access; you have %s on %q (agent policy %q)", need, l, alias, n.AgentPolicy)
	}
	return n, l, nil
}

func jsonResult(v any) (*mcp.CallToolResult, any, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(b)}}}, nil, nil
}

func textResult(s string) (*mcp.CallToolResult, any, error) {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: s}}}, nil, nil
}

type listNotesIn struct {
	Scope string `json:"scope,omitempty" jsonschema:"recent, mine, shared or all (default all)"`
	Tag   string `json:"tag,omitempty" jsonschema:"only notes with this tag"`
	Limit int    `json:"limit,omitempty" jsonschema:"maximum number of notes (default 50)"`
}

type searchIn struct {
	Query string `json:"query" jsonschema:"words to find in titles, tags and text"`
	Limit int    `json:"limit,omitempty" jsonschema:"maximum number of notes (default 20)"`
}

type noteIn struct {
	Note string `json:"note" jsonschema:"note alias or URL"`
}

type createNoteIn struct {
	Content string `json:"content" jsonschema:"Markdown text. Front matter tags: [a, b] sets tags."`
	Alias   string `json:"alias,omitempty" jsonschema:"optional readable address, lowercase letters, digits and dashes"`
}

type commentsIn struct {
	Note            string `json:"note" jsonschema:"note alias or URL"`
	IncludeResolved bool   `json:"include_resolved,omitempty" jsonschema:"also list resolved threads"`
}

type addCommentIn struct {
	Note       string `json:"note" jsonschema:"note alias or URL"`
	Quote      string `json:"quote" jsonschema:"exact text in the note the comment is about"`
	Occurrence int    `json:"occurrence,omitempty" jsonschema:"which match of quote, from 1, when it appears more than once"`
	Body       string `json:"body" jsonschema:"the comment, Markdown allowed"`
}

type replyIn struct {
	Note     string `json:"note" jsonschema:"note alias or URL"`
	ThreadID string `json:"thread_id" jsonschema:"thread id from list_comments"`
	Body     string `json:"body" jsonschema:"the reply"`
}

type resolveIn struct {
	Note     string `json:"note" jsonschema:"note alias or URL"`
	ThreadID string `json:"thread_id" jsonschema:"thread id from list_comments"`
	Reopen   bool   `json:"reopen,omitempty" jsonschema:"reopen instead of resolve"`
}

type editIn struct {
	Note       string `json:"note" jsonschema:"note alias or URL"`
	OldText    string `json:"old_text,omitempty" jsonschema:"exact text to replace. Leave empty with content to replace the whole note."`
	NewText    string `json:"new_text,omitempty" jsonschema:"replacement text"`
	Occurrence int    `json:"occurrence,omitempty" jsonschema:"which match of old_text, from 1, when it appears more than once"`
	Content    string `json:"content,omitempty" jsonschema:"full new text of the note, used when old_text is empty"`
	Reason     string `json:"reason,omitempty" jsonschema:"why, shown to the people reviewing"`
}

type historyIn struct {
	Note       string `json:"note" jsonschema:"note alias or URL"`
	Limit      int    `json:"limit,omitempty" jsonschema:"maximum number of entries (default 30)"`
	RevisionID int64  `json:"revision_id,omitempty" jsonschema:"return the full text and diff of this revision"`
}

func (s *Server) registerTools(srv *mcp.Server) {
	ro := &mcp.ToolAnnotations{ReadOnlyHint: true}
	mcp.AddTool(srv, &mcp.Tool{Name: "list_notes", Description: "List notes you can read, newest first.", Annotations: ro},
		func(ctx context.Context, req *mcp.CallToolRequest, in listNotesIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			scope := store.Scope(in.Scope)
			if scope == "" {
				scope = store.ScopeAll
			}
			return s.mcpList(ctx, id, store.ListFilter{Viewer: s.viewer(id), Scope: scope, Tag: in.Tag, Limit: defaultLimit(in.Limit, 50)})
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "search_notes", Description: "Search notes by words in title, tags and text.", Annotations: ro},
		func(ctx context.Context, req *mcp.CallToolRequest, in searchIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			ids, err := s.store.SearchNoteIDs(ctx, in.Query, 200)
			if err != nil {
				return nil, nil, err
			}
			return s.mcpList(ctx, id, store.ListFilter{Viewer: s.viewer(id), Scope: store.ScopeAll, IDs: ids, Limit: defaultLimit(in.Limit, 20)})
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "read_note", Description: "Read a note: Markdown text, title, tags, your access level and the agent policy.", Annotations: ro},
		func(ctx context.Context, req *mcp.CallToolRequest, in noteIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			n, l, err := s.mcpNote(ctx, id, in.Note, permission.Read)
			if err != nil {
				return nil, nil, err
			}
			text, err := s.hub.Text(ctx, n.ID)
			if err != nil {
				return nil, nil, err
			}
			ths, _ := s.store.Threads(ctx, n.ID)
			open := 0
			for _, th := range ths {
				if th.Status == "open" {
					open++
				}
			}
			sgs, _ := s.store.Suggestions(ctx, n.ID, false)
			return jsonResult(map[string]any{
				"alias": n.PrimaryAlias, "title": n.Title, "tags": n.Tags, "updated_at": n.UpdatedAt,
				"your_level": l, "agent_policy": n.AgentPolicy, "open_comments": open, "pending_suggestions": len(sgs),
				"url": s.publicURL() + "/n/" + n.PrimaryAlias, "content": text,
			})
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "create_note", Description: "Create a note owned by the signed-in user."},
		func(ctx context.Context, req *mcp.CallToolRequest, in createNoteIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			if !id.canWriteScope() {
				return nil, nil, errors.New("this token can only read")
			}
			r, _ := http.NewRequestWithContext(ctx, http.MethodPost, "/", nil)
			n, err := s.createNote(r, id, in.Content, in.Alias)
			if err != nil {
				return nil, nil, err
			}
			return jsonResult(map[string]any{"alias": n.PrimaryAlias, "title": n.Title, "url": s.publicURL() + "/n/" + n.PrimaryAlias})
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "list_comments", Description: "List comment threads with the text they point at. detached means the text was deleted.", Annotations: ro},
		func(ctx context.Context, req *mcp.CallToolRequest, in commentsIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			n, _, err := s.mcpNote(ctx, id, in.Note, permission.Read)
			if err != nil {
				return nil, nil, err
			}
			ths, err := s.store.Threads(ctx, n.ID)
			if err != nil {
				return nil, nil, err
			}
			out, err := s.resolveThreads(ctx, n.ID, ths)
			if err != nil {
				return nil, nil, err
			}
			type comment struct {
				Author string `json:"author"`
				Source string `json:"source"`
				Body   string `json:"body"`
				At     string `json:"at"`
			}
			type thread struct {
				ID       string    `json:"id"`
				Status   string    `json:"status"`
				Quote    string    `json:"quote"`
				QuoteNow string    `json:"quote_now,omitempty"`
				Detached bool      `json:"detached"`
				Comments []comment `json:"comments"`
			}
			list := []thread{}
			for _, th := range out {
				if th.Status != "open" && !in.IncludeResolved {
					continue
				}
				t := thread{ID: th.ID, Status: th.Status, Quote: th.Quote, QuoteNow: th.QuoteNow, Detached: th.Detached}
				for _, c := range th.Comments {
					t.Comments = append(t.Comments, comment{Author: c.AuthorName, Source: string(c.Source), Body: c.Body, At: c.CreatedAt})
				}
				list = append(list, t)
			}
			return jsonResult(map[string]any{"threads": list})
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "add_comment", Description: "Start a comment thread on a quoted part of a note."},
		func(ctx context.Context, req *mcp.CallToolRequest, in addCommentIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			n, _, err := s.mcpNote(ctx, id, in.Note, permission.Comment)
			if err != nil {
				return nil, nil, err
			}
			out, _, err := s.createThread(ctx, id, n, createThreadRequest{Body: in.Body, Quote: in.Quote, Occurrence: in.Occurrence})
			if err != nil {
				return nil, nil, err
			}
			return jsonResult(map[string]any{"id": out.ID, "quote": out.Quote})
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "reply_comment", Description: "Reply in a comment thread."},
		func(ctx context.Context, req *mcp.CallToolRequest, in replyIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			n, _, err := s.mcpNote(ctx, id, in.Note, permission.Comment)
			if err != nil {
				return nil, nil, err
			}
			if strings.TrimSpace(in.Body) == "" {
				return nil, nil, errors.New("body is empty")
			}
			c := &store.Comment{ThreadID: in.ThreadID, AuthorID: id.UserID(), AuthorName: id.displayName(), Source: id.source(), Client: id.Client, Body: in.Body}
			if err := s.store.AddComment(ctx, n.ID, c, id.event(n.ID, "comment.reply", map[string]any{"thread": in.ThreadID, "excerpt": excerpt(in.Body)})); err != nil {
				return nil, nil, err
			}
			s.commentsChanged(n.ID)
			return textResult("replied")
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "resolve_comment", Description: "Resolve a comment thread, or reopen it."},
		func(ctx context.Context, req *mcp.CallToolRequest, in resolveIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			n, _, err := s.mcpNote(ctx, id, in.Note, permission.Comment)
			if err != nil {
				return nil, nil, err
			}
			status, kind := "resolved", "comment.resolve"
			if in.Reopen {
				status, kind = "open", "comment.reopen"
			}
			if err := s.store.SetThreadStatus(ctx, n.ID, in.ThreadID, status, id.displayName(), id.event(n.ID, kind, map[string]any{"thread": in.ThreadID})); err != nil {
				return nil, nil, err
			}
			s.commentsChanged(n.ID)
			return textResult(status)
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "suggest_edit", Description: "Propose replacing old_text with new_text. People review it in the editor; the note does not change until accepted."},
		func(ctx context.Context, req *mcp.CallToolRequest, in editIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			n, _, err := s.mcpNote(ctx, id, in.Note, permission.Comment)
			if err != nil {
				return nil, nil, err
			}
			return s.mcpSuggest(ctx, id, n, in)
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "edit_note", Description: "Replace old_text with new_text, or the whole note with content. " +
		"Applies directly when the note's agent policy is edit; under suggest it creates a suggestion instead."},
		func(ctx context.Context, req *mcp.CallToolRequest, in editIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			n, l, err := s.mcpNote(ctx, id, in.Note, permission.Comment)
			if err != nil {
				return nil, nil, err
			}
			if l < permission.Write {
				return s.mcpSuggest(ctx, id, n, in)
			}
			a := collab.Author{UserID: id.UserID(), Name: id.displayName(), Source: string(store.SourceAgent)}
			var text string
			if in.OldText == "" {
				if in.Content == "" {
					return nil, nil, errors.New("give old_text and new_text, or content")
				}
				text, err = s.hub.Edit(ctx, n.ID, a, func(collab.EditView) (string, error) { return in.Content, nil })
			} else {
				text, err = s.hub.Replace(ctx, n.ID, a, func(v collab.EditView) (int, int, string, error) {
					start, end, err := findQuote(v.Text, in.OldText, in.Occurrence)
					return start, end, in.NewText, err
				})
			}
			if err != nil {
				return nil, nil, err
			}
			return jsonResult(map[string]any{"applied": true, "length": len(text)})
		})
	trash := func(restore bool) func(ctx context.Context, req *mcp.CallToolRequest, in noteIn) (*mcp.CallToolResult, any, error) {
		return func(ctx context.Context, req *mcp.CallToolRequest, in noteIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			alias, _ := noteRef(in.Note)
			n, err := s.store.NoteByAlias(ctx, alias)
			if err != nil {
				return nil, nil, fmt.Errorf("no note %q", alias)
			}
			if err := s.canTrash(id, n); err != nil {
				return nil, nil, err
			}
			switch {
			case restore && n.DeletedAt == "":
				return nil, nil, fmt.Errorf("note %q is not in the trash", alias)
			case !restore && n.DeletedAt != "":
				return nil, nil, fmt.Errorf("note %q is already in the trash", alias)
			case restore:
				err = s.restoreNote(ctx, id, n)
			default:
				err = s.trashNote(ctx, id, n)
			}
			if err != nil {
				return nil, nil, err
			}
			if restore {
				return textResult(fmt.Sprintf("restored %q", alias))
			}
			return textResult(fmt.Sprintf("moved %q to the trash; restore_note brings it back for %d days", alias, int(s.cfg.TrashRetention.Hours()/24)))
		}
	}
	mcp.AddTool(srv, &mcp.Tool{Name: "trash_note", Description: "Move a note to the trash. Only for notes the user owns, with agent policy edit. " +
		"It can be restored until the trash retention ends. Agents cannot delete notes for good."}, trash(false))
	mcp.AddTool(srv, &mcp.Tool{Name: "restore_note", Description: "Bring a note back from the trash. Same rules as trash_note."}, trash(true))
	mcp.AddTool(srv, &mcp.Tool{Name: "get_history", Description: "Timeline of a note: edit sessions with authors and sources, comments, suggestions and permission changes.", Annotations: ro},
		func(ctx context.Context, req *mcp.CallToolRequest, in historyIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			n, _, err := s.mcpNote(ctx, id, in.Note, permission.Read)
			if err != nil {
				return nil, nil, err
			}
			if in.RevisionID > 0 {
				rev, err := s.store.Revision(ctx, n.ID, in.RevisionID)
				if err != nil {
					return nil, nil, err
				}
				return jsonResult(rev)
			}
			limit := defaultLimit(in.Limit, 30)
			revs, err := s.store.Revisions(ctx, n.ID, limit)
			if err != nil {
				return nil, nil, err
			}
			events, err := s.store.Events(ctx, n.ID, limit)
			if err != nil {
				return nil, nil, err
			}
			return jsonResult(map[string]any{"revisions": revs, "events": events})
		})
}

func defaultLimit(n, def int) int {
	if n <= 0 || n > 200 {
		return def
	}
	return n
}

func (s *Server) mcpList(ctx context.Context, id *Identity, f store.ListFilter) (*mcp.CallToolResult, any, error) {
	notes, err := s.store.ListNotes(ctx, f)
	if err != nil {
		return nil, nil, err
	}
	type item struct {
		Alias     string   `json:"alias"`
		Title     string   `json:"title"`
		Tags      []string `json:"tags"`
		UpdatedAt string   `json:"updated_at"`
	}
	out := []item{}
	for _, n := range notes {
		out = append(out, item{n.PrimaryAlias, n.Title, n.Tags, n.UpdatedAt})
	}
	return jsonResult(map[string]any{"notes": out})
}

func (s *Server) mcpSuggest(ctx context.Context, id *Identity, n *store.Note, in editIn) (*mcp.CallToolResult, any, error) {
	req := createSuggestionRequest{Proposed: in.NewText, Reason: in.Reason, Quote: in.OldText, Occurrence: in.Occurrence}
	if in.OldText == "" {
		if in.Content == "" {
			return nil, nil, errors.New("give old_text and new_text, or content")
		}
		text, err := s.hub.Text(ctx, n.ID)
		if err != nil {
			return nil, nil, err
		}
		req.Quote, req.Proposed = text, in.Content
	}
	sg, err := s.createSuggestion(ctx, id, n, req)
	if err != nil {
		return nil, nil, err
	}
	return jsonResult(map[string]any{
		"suggestion": sg.ID, "status": "pending",
		"message": fmt.Sprintf("The note's agent policy is %q, so this was saved as a suggestion for a person to accept.", n.AgentPolicy),
	})
}

// publicURL is the configured base URL, or the one MCP clients last used.
func (s *Server) publicURL() string {
	if s.cfg.BaseURL != "" {
		return s.cfg.BaseURL
	}
	if v, ok := s.seenBase.Load().(string); ok {
		return v
	}
	return ""
}
