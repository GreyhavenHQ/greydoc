package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/secrets"
	"github.com/greyhavenhq/greydoc/internal/store"
)

const maxCommentLen = 20000

// threadOut adds the anchor's current position, in characters, to a thread.
type threadOut struct {
	store.Thread
	QuoteNow string `json:"quote_now"`
	Start    int    `json:"start"`
	End      int    `json:"end"`
	Detached bool   `json:"detached"`
}

func excerpt(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > 80 {
		return string([]rune(s)[:79]) + "…"
	}
	return s
}

// resolveThreads places each thread in the current text.
func (s *Server) resolveThreads(ctx context.Context, noteID string, ths []store.Thread) ([]threadOut, error) {
	rels := make([][]byte, 0, 2*len(ths))
	for _, th := range ths {
		rels = append(rels, th.AnchorStart, th.AnchorEnd)
	}
	text, offs, oks, err := s.hub.Resolve(ctx, noteID, rels...)
	if err != nil {
		return nil, err
	}
	out := make([]threadOut, len(ths))
	for i, th := range ths {
		o := threadOut{Thread: th}
		a, b := offs[2*i], offs[2*i+1]
		if !oks[2*i] || !oks[2*i+1] || a >= b {
			o.Detached = true
		} else {
			o.QuoteNow = text[a:b]
			o.Start = utf8.RuneCountInString(text[:a])
			o.End = o.Start + utf8.RuneCountInString(o.QuoteNow)
		}
		out[i] = o
	}
	return out, nil
}

func (s *Server) handleListComments(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	ths, err := s.store.Threads(r.Context(), n.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	out, err := s.resolveThreads(r.Context(), n.ID, ths)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"threads": out})
}

func (s *Server) commentsChanged(noteID string) {
	s.hub.Broadcast(noteID, map[string]any{"type": "comments"})
}

func validBody(w http.ResponseWriter, body string) bool {
	if strings.TrimSpace(body) == "" || len(body) > maxCommentLen {
		writeError(w, http.StatusBadRequest, "bad_body", "comment text is empty or too long")
		return false
	}
	return true
}

type createThreadRequest struct {
	Body        string `json:"body"`
	Quote       string `json:"quote"`
	Occurrence  int    `json:"occurrence"`
	AnchorStart []byte `json:"anchor_start"`
	AnchorEnd   []byte `json:"anchor_end"`
}

// createThread anchors and stores a new thread. Anchors come from the browser, or the server finds the quote.
func (s *Server) createThread(ctx context.Context, id *Identity, n *store.Note, req createThreadRequest) (*threadOut, int, error) {
	if strings.TrimSpace(req.Body) == "" || len(req.Body) > maxCommentLen {
		return nil, http.StatusBadRequest, errors.New("comment text is empty or too long")
	}
	th := &store.Thread{ID: secrets.NewID(), NoteID: n.ID, CreatedBy: id.UserID()}
	if len(req.AnchorStart) > 0 && len(req.AnchorEnd) > 0 {
		_, _, oks, err := s.hub.Resolve(ctx, n.ID, req.AnchorStart, req.AnchorEnd)
		if err != nil {
			return nil, http.StatusInternalServerError, err
		}
		if !oks[0] || !oks[1] {
			return nil, http.StatusUnprocessableEntity, errors.New("the anchors do not resolve in this document")
		}
		th.AnchorStart, th.AnchorEnd = req.AnchorStart, req.AnchorEnd
		th.Quote = req.Quote
		if len(th.Quote) > 2000 {
			th.Quote = th.Quote[:2000]
		}
	} else {
		start, end, quote, err := s.anchorQuote(ctx, n.ID, req.Quote, req.Occurrence)
		if err != nil {
			return nil, http.StatusUnprocessableEntity, err
		}
		th.AnchorStart, th.AnchorEnd, th.Quote = start, end, quote
	}
	first := &store.Comment{AuthorID: id.UserID(), AuthorName: id.displayName(), Source: id.source(), Client: clientOf(id), Body: req.Body}
	ev := id.event(n.ID, "comment.create", map[string]any{"thread": th.ID, "excerpt": excerpt(req.Body), "quote": excerpt(th.Quote)})
	if err := s.store.CreateThread(ctx, th, first, ev); err != nil {
		return nil, http.StatusInternalServerError, err
	}
	s.commentsChanged(n.ID)
	s.notifyMentions(ctx, id, n, mentionComment, th.ID, req.Body)
	out, err := s.resolveThreads(ctx, n.ID, []store.Thread{*th})
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	return &out[0], http.StatusCreated, nil
}

func clientOf(id *Identity) string {
	if id == nil {
		return ""
	}
	return id.Client
}

func (s *Server) handleCreateComment(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Comment)
	if !ok {
		return
	}
	var req createThreadRequest
	if !readJSON(w, r, &req) {
		return
	}
	out, code, err := s.createThread(r.Context(), identityFrom(r.Context()), n, req)
	if err != nil {
		if code == http.StatusInternalServerError {
			internalError(w, err)
		} else {
			writeError(w, code, "bad_comment", err.Error())
		}
		return
	}
	writeJSON(w, code, out)
}

func (s *Server) handleReply(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Comment)
	if !ok {
		return
	}
	var req struct {
		Body string `json:"body"`
	}
	if !readJSON(w, r, &req) || !validBody(w, req.Body) {
		return
	}
	id := identityFrom(r.Context())
	c := &store.Comment{ThreadID: r.PathValue("thread"), AuthorID: id.UserID(), AuthorName: id.displayName(), Source: id.source(),
		Client: clientOf(id), Body: req.Body}
	ev := id.event(n.ID, "comment.reply", map[string]any{"thread": c.ThreadID, "excerpt": excerpt(req.Body)})
	if err := s.store.AddComment(r.Context(), n.ID, c, ev); err != nil {
		s.writeNoteError(w, err)
		return
	}
	s.commentsChanged(n.ID)
	s.notifyMentions(r.Context(), id, n, mentionComment, c.ThreadID, req.Body)
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) handleThreadStatus(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Comment)
	if !ok {
		return
	}
	status, kind := "resolved", "comment.resolve"
	if strings.HasSuffix(r.URL.Path, "/reopen") {
		status, kind = "open", "comment.reopen"
	}
	id := identityFrom(r.Context())
	threadID := r.PathValue("thread")
	if err := s.store.SetThreadStatus(r.Context(), n.ID, threadID, status, id.displayName(),
		id.event(n.ID, kind, map[string]any{"thread": threadID})); err != nil {
		s.writeNoteError(w, err)
		return
	}
	s.commentsChanged(n.ID)
	th, err := s.store.Thread(r.Context(), n.ID, threadID)
	if err != nil {
		s.writeNoteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, th)
}

func (s *Server) handleDeleteThread(w http.ResponseWriter, r *http.Request) {
	n, l, ok := s.noteFor(w, r, permission.Comment)
	if !ok {
		return
	}
	id := identityFrom(r.Context())
	th, err := s.store.Thread(r.Context(), n.ID, r.PathValue("thread"))
	if err != nil {
		s.writeNoteError(w, err)
		return
	}
	if l < permission.Full && th.CreatedBy != id.UserID() {
		writeError(w, http.StatusForbidden, "forbidden", "only the author or the owner can delete a thread")
		return
	}
	if err := s.store.DeleteThread(r.Context(), n.ID, th.ID, id.event(n.ID, "comment.delete", map[string]any{"thread": th.ID})); err != nil {
		s.writeNoteError(w, err)
		return
	}
	s.commentsChanged(n.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleEditComment(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Comment)
	if !ok {
		return
	}
	var req struct {
		Body string `json:"body"`
	}
	if !readJSON(w, r, &req) || !validBody(w, req.Body) {
		return
	}
	threadID, commentID := r.PathValue("thread"), r.PathValue("comment")
	if _, err := s.store.Thread(r.Context(), n.ID, threadID); err != nil {
		s.writeNoteError(w, err)
		return
	}
	author, err := s.store.CommentAuthor(r.Context(), threadID, commentID)
	if err != nil {
		s.writeNoteError(w, err)
		return
	}
	if author != identityFrom(r.Context()).UserID() {
		writeError(w, http.StatusForbidden, "forbidden", "only the author can edit a comment")
		return
	}
	if err := s.store.EditComment(r.Context(), threadID, commentID, req.Body); err != nil {
		internalError(w, err)
		return
	}
	s.commentsChanged(n.ID)
	w.WriteHeader(http.StatusNoContent)
}
