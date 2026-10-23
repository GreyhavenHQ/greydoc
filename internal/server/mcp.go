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

const mcpInstructions = `greydoc is a shared Markdown document server.
Every document has an agent policy set by its owner: none, read, suggest or edit.
Under "suggest", edit_note creates a suggestion that a person accepts or rejects; the text does not change until then.
Quote text exactly (old_text, quote) to target a range. If the quote is not unique, quote more context or pass occurrence.
Everything you do is recorded in the document timeline as done by an agent on behalf of the signed-in user.`

// mcpHandler serves the MCP Streamable HTTP endpoint. In OIDC mode it needs a bearer token.
func (s *Server) mcpHandler() http.Handler {
	srv := mcp.NewServer(&mcp.Implementation{Name: "greydoc", Version: "1"}, &mcp.ServerOptions{Instructions: mcpInstructions})
	s.registerTools(srv)
	srv.AddReceivingMiddleware(s.auditMCP)
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
	return s.mcpCaller(req.Extra, req.Session)
}

func (s *Server) mcpCaller(extra *mcp.RequestExtra, session *mcp.ServerSession) (*Identity, error) {
	var id *Identity
	if extra != nil && extra.TokenInfo != nil {
		id, _ = extra.TokenInfo.Extra["identity"].(*Identity)
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
		if p := session.InitializeParams(); p != nil && p.ClientInfo != nil && p.ClientInfo.Name != "" {
			cp.Client = p.ClientInfo.Name
		}
	}
	if cp.Client == "" {
		cp.Client = "MCP client"
	}
	return &cp, nil
}

// noteRef accepts an alias, a path such as /n/alias, or a full note URL. A short view-only link, /v/<token>, has no alias.
func noteRef(ref string) (alias, share string) {
	ref = strings.TrimSpace(ref)
	if u, err := url.Parse(ref); err == nil && (u.Scheme != "" || strings.HasPrefix(ref, "/")) {
		share = u.Query().Get("share")
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) == 2 && parts[0] == "v" {
			return "", parts[1]
		}
		return parts[len(parts)-1], share
	}
	return ref, ""
}

func (s *Server) mcpNote(ctx context.Context, id *Identity, ref string, need permission.Level) (*store.Note, permission.Level, error) {
	alias, share := noteRef(ref)
	if alias == "" && share != "" {
		noteID, err := s.store.ShareLinkNote(ctx, share)
		if errors.Is(err, store.ErrNotFound) {
			return nil, 0, errors.New("this view-only link does not exist or was revoked")
		}
		if err != nil {
			return nil, 0, err
		}
		n, err := s.store.NoteByID(ctx, noteID)
		if err != nil {
			return nil, 0, err
		}
		alias = n.PrimaryAlias
	}
	n, err := s.store.NoteByAlias(ctx, alias)
	if errors.Is(err, store.ErrNotFound) {
		return nil, 0, fmt.Errorf("no document %q", alias)
	}
	if err != nil {
		return nil, 0, err
	}
	if n.DeletedAt != "" {
		return nil, 0, fmt.Errorf("document %q is in the trash; restore_note brings it back", alias)
	}
	l, err := s.noteLevel(ctx, id, n, share)
	if err != nil {
		return nil, 0, err
	}
	if l < need {
		if l == permission.Deny {
			return nil, l, fmt.Errorf("no access to document %q (agent policy %q)", alias, n.AgentPolicy)
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
	Scope  string `json:"scope,omitempty" jsonschema:"recent, mine, shared or all (default all)"`
	Tag    string `json:"tag,omitempty" jsonschema:"only documents with this tag"`
	Folder string `json:"folder,omitempty" jsonschema:"only documents directly in this folder id (from list_folders), or root for documents outside any folder (with scope shared: outside any folder you can open)"`
	Limit  int    `json:"limit,omitempty" jsonschema:"documents per page, 1 to 200 (default 50)"`
	Offset int    `json:"offset,omitempty" jsonschema:"documents to skip: the next_offset of the previous page"`
}

type searchIn struct {
	Query  string `json:"query" jsonschema:"words to find in titles, tags and text"`
	Scope  string `json:"scope,omitempty" jsonschema:"recent, mine, shared or all (default all)"`
	Tag    string `json:"tag,omitempty" jsonschema:"only documents with this tag"`
	Limit  int    `json:"limit,omitempty" jsonschema:"documents per page, 1 to 200 (default 20)"`
	Offset int    `json:"offset,omitempty" jsonschema:"documents to skip: the next_offset of the previous page"`
}

type noteIn struct {
	Note string `json:"note" jsonschema:"document alias or URL"`
}

type permissionsIn struct {
	HedgeDocMode string            `json:"hedgedoc_mode,omitempty" jsonschema:"HedgeDoc 1 mode: freely, editable, limited, locked, protected or private"`
	Everyone     string            `json:"everyone,omitempty" jsonschema:"level for anyone with the address: deny, read, comment or write"`
	SignedIn     string            `json:"signed_in,omitempty" jsonschema:"level for signed-in users: deny, read, comment or write"`
	Users        map[string]string `json:"users,omitempty" jsonschema:"username to level"`
	Groups       map[string]string `json:"groups,omitempty" jsonschema:"greydoc group name to level. You must belong to the group."`
}

type createNoteIn struct {
	Content      string         `json:"content" jsonschema:"Markdown text. Front matter tags: [a, b] sets tags."`
	Alias        string         `json:"alias,omitempty" jsonschema:"address of the document, for example the ID it had in HedgeDoc so old links keep working. Letters, digits, - and _. Case is ignored."`
	ExtraAliases []string       `json:"extra_aliases,omitempty" jsonschema:"more addresses, for example a HedgeDoc 1 short ID used in /s/ links"`
	CreatedAt    string         `json:"created_at,omitempty" jsonschema:"original creation date, RFC 3339. Also the last update unless updated_at is given."`
	UpdatedAt    string         `json:"updated_at,omitempty" jsonschema:"original last update, RFC 3339"`
	Permissions  *permissionsIn `json:"permissions,omitempty" jsonschema:"initial access. Unset fields keep the server defaults."`
	AgentPolicy  string         `json:"agent_policy,omitempty" jsonschema:"none, read, suggest or edit"`
	Folder       string         `json:"folder,omitempty" jsonschema:"folder id to create the document in (from list_folders). It then gets its access from the folder."`
}

type listFoldersIn struct {
	Parent string `json:"parent,omitempty" jsonschema:"list the subfolders of this folder id. Empty lists top-level folders."`
	Scope  string `json:"scope,omitempty" jsonschema:"for top-level folders: mine (default) or shared (the highest folders shared with you)"`
}

type moveNoteIn struct {
	Note   string `json:"note" jsonschema:"document alias or URL"`
	Folder string `json:"folder,omitempty" jsonschema:"destination folder id. Empty moves the document out of any folder."`
}

type commentsIn struct {
	Note            string `json:"note" jsonschema:"document alias or URL"`
	IncludeResolved bool   `json:"include_resolved,omitempty" jsonschema:"also list resolved threads"`
}

type addCommentIn struct {
	Note       string `json:"note" jsonschema:"document alias or URL"`
	Quote      string `json:"quote" jsonschema:"exact text in the document the comment is about"`
	Occurrence int    `json:"occurrence,omitempty" jsonschema:"which match of quote, from 1, when it appears more than once"`
	Body       string `json:"body" jsonschema:"the comment, Markdown allowed"`
}

type replyIn struct {
	Note     string `json:"note" jsonschema:"document alias or URL"`
	ThreadID string `json:"thread_id" jsonschema:"thread id from list_comments"`
	Body     string `json:"body" jsonschema:"the reply"`
}

type resolveIn struct {
	Note     string `json:"note" jsonschema:"document alias or URL"`
	ThreadID string `json:"thread_id" jsonschema:"thread id from list_comments"`
	Reopen   bool   `json:"reopen,omitempty" jsonschema:"reopen instead of resolve"`
}

type editIn struct {
	Note       string `json:"note" jsonschema:"document alias or URL"`
	OldText    string `json:"old_text,omitempty" jsonschema:"exact text to replace. Leave empty with content to replace the whole document."`
	NewText    string `json:"new_text,omitempty" jsonschema:"replacement text"`
	Occurrence int    `json:"occurrence,omitempty" jsonschema:"which match of old_text, from 1, when it appears more than once"`
	Content    string `json:"content,omitempty" jsonschema:"full new text of the document, used when old_text is empty"`
	Reason     string `json:"reason,omitempty" jsonschema:"why, shown to the people reviewing"`
}

type historyIn struct {
	Note       string `json:"note" jsonschema:"document alias or URL"`
	Limit      int    `json:"limit,omitempty" jsonschema:"maximum number of entries (default 30)"`
	RevisionID int64  `json:"revision_id,omitempty" jsonschema:"return the full text and diff of this revision"`
}

func (s *Server) registerTools(srv *mcp.Server) {
	ro := &mcp.ToolAnnotations{ReadOnlyHint: true}
	mcp.AddTool(srv, &mcp.Tool{Name: "list_notes", Description: "List documents you can read, last updated first. A full page returns next_offset: pass it as offset to get the next page.", Annotations: ro},
		func(ctx context.Context, req *mcp.CallToolRequest, in listNotesIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			if in.Folder != "" && in.Folder != store.FolderRoot {
				if _, _, err := s.liveFolder(ctx, id, in.Folder, permission.Read); err != nil {
					return nil, nil, err
				}
			}
			return s.mcpList(ctx, id, store.ListFilter{Viewer: s.viewer(id), Scope: mcpScope(in.Scope), Tag: in.Tag, Folder: in.Folder,
				Limit: defaultLimit(in.Limit, 50), Offset: in.Offset}, "")
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "search_notes", Description: "Search documents by words in title, tags and text, best match first, with an excerpt around the match. A full page returns next_offset: pass it as offset to get the next page.", Annotations: ro},
		func(ctx context.Context, req *mcp.CallToolRequest, in searchIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			ids, err := s.store.SearchNoteIDs(ctx, in.Query, searchCap)
			if err != nil {
				return nil, nil, err
			}
			return s.mcpList(ctx, id, store.ListFilter{Viewer: s.viewer(id), Scope: mcpScope(in.Scope), Tag: in.Tag, IDs: ids,
				Limit: defaultLimit(in.Limit, 20), Offset: in.Offset}, in.Query)
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "read_note", Description: "Read a document: Markdown text, title, tags, your access level and the agent policy.", Annotations: ro},
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
				"your_level": l, "agent_policy": n.AgentPolicy, "open_comments": open, "pending_suggestions": len(sgs), "folder_id": n.FolderID,
				"url": s.publicURL() + "/n/" + n.PrimaryAlias, "content": text,
			})
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "create_note", Description: "Create a document owned by the signed-in user. " +
		"To import from HedgeDoc, pass the old document ID as alias, the short ID in extra_aliases, the original dates, and the permission mode."},
		func(ctx context.Context, req *mcp.CallToolRequest, in createNoteIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			if !id.canWriteScope() {
				return nil, nil, errors.New("this token can only read")
			}
			spec := NoteSpec{Content: in.Content, Alias: in.Alias, ExtraAliases: in.ExtraAliases, CreatedAt: in.CreatedAt,
				UpdatedAt: in.UpdatedAt, AgentPolicy: in.AgentPolicy, Folder: in.Folder}
			if in.Permissions != nil {
				p := in.Permissions
				spec.Permissions = &PermissionSpec{HedgeDocMode: p.HedgeDocMode, Everyone: p.Everyone, SignedIn: p.SignedIn, Users: p.Users, Groups: p.Groups}
			}
			n, err := s.createNote(ctx, id, spec)
			if err != nil {
				return nil, nil, err
			}
			return jsonResult(map[string]any{"alias": n.PrimaryAlias, "title": n.Title, "url": s.publicURL() + "/n/" + n.PrimaryAlias,
				"created_at": n.CreatedAt, "updated_at": n.UpdatedAt})
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "list_folders", Description: "List folders. A folder's access applies to every document and folder inside it.", Annotations: ro},
		func(ctx context.Context, req *mcp.CallToolRequest, in listFoldersIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			f := store.FolderFilter{Viewer: s.viewer(id), Parent: in.Parent, Scope: store.ScopeMine}
			if in.Scope == string(store.ScopeShared) {
				f.Scope = store.ScopeShared
			}
			if in.Parent != "" {
				if _, _, err := s.liveFolder(ctx, id, in.Parent, permission.Read); err != nil {
					return nil, nil, err
				}
			}
			folders, err := s.store.ListFolders(ctx, f)
			if err != nil {
				return nil, nil, err
			}
			return jsonResult(map[string]any{"folders": folders})
		})
	mcp.AddTool(srv, &mcp.Tool{Name: "move_note", Description: "Move a document into a folder, or out of any folder. " +
		"Its own grants stay; the grants of the old folder no longer apply and those of the new one do. " +
		"Only for documents the user owns, with agent policy edit, into a folder the user can edit."},
		func(ctx context.Context, req *mcp.CallToolRequest, in moveNoteIn) (*mcp.CallToolResult, any, error) {
			id, err := s.mcpIdentity(req)
			if err != nil {
				return nil, nil, err
			}
			alias, _ := noteRef(in.Note)
			to := ""
			if in.Folder != "" {
				dest, _, err := s.liveFolder(ctx, id, in.Folder, permission.Write)
				if err != nil {
					return nil, nil, err
				}
				to = dest.Name
			}
			items, msg, err := s.moveItems(ctx, id, moveRequest{Notes: []string{alias}})
			if err != nil {
				return nil, nil, err
			}
			if msg != "" {
				return nil, nil, errors.New(msg)
			}
			if err := s.moveItem(ctx, id, items[0], in.Folder, to); err != nil {
				return nil, nil, err
			}
			return jsonResult(map[string]any{"alias": items[0].note.PrimaryAlias, "folder": in.Folder})
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
	mcp.AddTool(srv, &mcp.Tool{Name: "add_comment", Description: "Start a comment thread on a quoted part of a document."},
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
			s.notifyMentions(ctx, id, n, mentionComment, in.ThreadID, in.Body)
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
	mcp.AddTool(srv, &mcp.Tool{Name: "suggest_edit", Description: "Propose replacing old_text with new_text. People review it in the editor; the document does not change until accepted."},
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
	mcp.AddTool(srv, &mcp.Tool{Name: "edit_note", Description: "Replace old_text with new_text, or the whole document with content. " +
		"Applies directly when the document's agent policy is edit; under suggest it creates a suggestion instead."},
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
				return nil, nil, fmt.Errorf("no document %q", alias)
			}
			if err := s.canTrash(id, n); err != nil {
				return nil, nil, err
			}
			switch {
			case restore && n.DeletedAt == "":
				return nil, nil, fmt.Errorf("document %q is not in the trash", alias)
			case !restore && n.DeletedAt != "":
				return nil, nil, fmt.Errorf("document %q is already in the trash", alias)
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
	mcp.AddTool(srv, &mcp.Tool{Name: "trash_note", Description: "Move a document to the trash. Only for documents the user owns, with agent policy edit. " +
		"It can be restored until the trash retention ends. Agents cannot delete documents for good."}, trash(false))
	mcp.AddTool(srv, &mcp.Tool{Name: "restore_note", Description: "Bring a document back from the trash. Same rules as trash_note."}, trash(true))
	mcp.AddTool(srv, &mcp.Tool{Name: "create_upload", Description: "Get a one-time URL to upload a local image or PDF file to a document. " +
		"Run the returned curl command with the file path: it prints the Markdown to put in the document with edit_note or suggest_edit. " +
		"The URL works once and expires after 10 minutes."}, s.mcpCreateUpload)
	mcp.AddTool(srv, &mcp.Tool{Name: "get_history", Description: "Timeline of a document: edit sessions with authors and sources, comments, suggestions and permission changes.", Annotations: ro},
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

func mcpScope(scope string) store.Scope {
	if scope == "" {
		return store.ScopeAll
	}
	return store.Scope(scope)
}

// mcpList returns one page of notes. One extra row tells whether a next page exists.
func (s *Server) mcpList(ctx context.Context, id *Identity, f store.ListFilter, query string) (*mcp.CallToolResult, any, error) {
	f.Offset = max(f.Offset, 0)
	page := f.Limit
	f.Limit++
	notes, err := s.store.ListNotes(ctx, f)
	if err != nil {
		return nil, nil, err
	}
	more := len(notes) > page
	notes = notes[:min(len(notes), page)]
	snippets := map[string]string{}
	if query != "" && len(notes) > 0 {
		ids := make([]string, len(notes))
		for i, n := range notes {
			ids[i] = n.ID
		}
		if snippets, err = s.store.SearchSnippets(ctx, query, ids); err != nil {
			return nil, nil, err
		}
	}
	type item struct {
		Alias     string   `json:"alias"`
		Title     string   `json:"title"`
		Tags      []string `json:"tags"`
		UpdatedAt string   `json:"updated_at"`
		Snippet   string   `json:"snippet,omitempty"`
	}
	out := []item{}
	for _, n := range notes {
		out = append(out, item{n.PrimaryAlias, n.Title, n.Tags, n.UpdatedAt, snippets[n.ID]})
	}
	res := map[string]any{"notes": out, "offset": f.Offset}
	if more {
		res["next_offset"] = f.Offset + page
	}
	return jsonResult(res)
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
		"message": fmt.Sprintf("The document's agent policy is %q, so this was saved as a suggestion for a person to accept.", n.AgentPolicy),
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
