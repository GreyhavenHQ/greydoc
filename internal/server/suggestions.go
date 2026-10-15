package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"unicode/utf8"

	"github.com/greyhavenhq/greydoc/internal/collab"
	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/secrets"
	"github.com/greyhavenhq/greydoc/internal/store"
)

type suggestionOut struct {
	store.Suggestion
	Current  string `json:"current"`
	Start    int    `json:"start"`
	End      int    `json:"end"`
	Detached bool   `json:"detached"`
	// Stale means the anchored text no longer matches the original.
	Stale bool `json:"stale"`
}

func (s *Server) resolveSuggestions(ctx context.Context, noteID string, sgs []store.Suggestion) ([]suggestionOut, error) {
	rels := make([][]byte, 0, 2*len(sgs))
	for _, sg := range sgs {
		rels = append(rels, sg.AnchorStart, sg.AnchorEnd)
	}
	text, offs, oks, err := s.hub.Resolve(ctx, noteID, rels...)
	if err != nil {
		return nil, err
	}
	out := make([]suggestionOut, len(sgs))
	for i, sg := range sgs {
		o := suggestionOut{Suggestion: sg}
		a, b := offs[2*i], offs[2*i+1]
		if !oks[2*i] || !oks[2*i+1] || a > b || (a == b && sg.Original != "") {
			o.Detached, o.Stale = true, true
		} else {
			o.Current = text[a:b]
			o.Start = utf8.RuneCountInString(text[:a])
			o.End = o.Start + utf8.RuneCountInString(o.Current)
			o.Stale = o.Current != sg.Original
		}
		out[i] = o
	}
	return out, nil
}

func (s *Server) suggestionsChanged(noteID string) {
	s.hub.Broadcast(noteID, map[string]any{"type": "suggestions"})
}

func (s *Server) handleListSuggestions(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	sgs, err := s.store.Suggestions(r.Context(), n.ID, r.URL.Query().Get("all") == "1")
	if err != nil {
		internalError(w, err)
		return
	}
	out, err := s.resolveSuggestions(r.Context(), n.ID, sgs)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"suggestions": out})
}

type createSuggestionRequest struct {
	Proposed    string `json:"proposed"`
	Reason      string `json:"reason"`
	Quote       string `json:"quote"`
	Occurrence  int    `json:"occurrence"`
	Original    string `json:"original"`
	AnchorStart []byte `json:"anchor_start"`
	AnchorEnd   []byte `json:"anchor_end"`
	// Source overrides the caller's source. Only ai_assisted is accepted, from the AI endpoint.
	Source store.Source `json:"-"`
	// AIPrompt, AIAction and AIInstruction are set by the AI endpoints only.
	AIPrompt      string `json:"-"`
	AIAction      string `json:"-"`
	AIInstruction string `json:"-"`
}

var errStale = errors.New("the text changed since the suggestion was made")

type httpError struct {
	code int
	slug string
	err  error
}

func (e *httpError) Error() string { return e.err.Error() }

func (s *Server) createSuggestion(ctx context.Context, id *Identity, n *store.Note, req createSuggestionRequest) (*suggestionOut, error) {
	if len(req.Proposed) > s.cfg.MaxNoteLength || len(req.Reason) > maxCommentLen {
		return nil, &httpError{http.StatusBadRequest, "too_long", errors.New("suggestion is too long")}
	}
	sg := &store.Suggestion{ID: secrets.NewID(), NoteID: n.ID, Proposed: req.Proposed, Reason: req.Reason,
		AuthorID: id.UserID(), AuthorName: id.displayName(), Source: id.source(), Client: clientOf(id)}
	if req.Source == store.SourceAIAssisted {
		sg.Source = req.Source
		sg.AIPrompt = req.AIPrompt
	}
	if len(req.AnchorStart) > 0 && len(req.AnchorEnd) > 0 {
		text, offs, oks, err := s.hub.Resolve(ctx, n.ID, req.AnchorStart, req.AnchorEnd)
		if err != nil {
			return nil, err
		}
		if !oks[0] || !oks[1] || offs[0] > offs[1] {
			return nil, &httpError{http.StatusUnprocessableEntity, "bad_anchor", errors.New("the anchors do not resolve in this note")}
		}
		if text[offs[0]:offs[1]] != req.Original {
			return nil, &httpError{http.StatusConflict, "stale", errStale}
		}
		sg.AnchorStart, sg.AnchorEnd, sg.Original = req.AnchorStart, req.AnchorEnd, req.Original
	} else {
		start, end, quote, err := s.anchorQuote(ctx, n.ID, req.Quote, req.Occurrence)
		if err != nil {
			return nil, &httpError{http.StatusUnprocessableEntity, "bad_quote", err}
		}
		sg.AnchorStart, sg.AnchorEnd, sg.Original = start, end, quote
	}
	if sg.Original == sg.Proposed {
		return nil, &httpError{http.StatusBadRequest, "no_change", errors.New("the suggestion does not change anything")}
	}
	data := map[string]any{"suggestion": sg.ID, "original": excerpt(sg.Original), "proposed": excerpt(sg.Proposed)}
	if req.AIAction != "" {
		data["ai_action"], data["instruction"] = req.AIAction, excerpt(req.AIInstruction)
	}
	ev := id.event(n.ID, "suggestion.create", data)
	ev.Source = sg.Source
	if err := s.store.CreateSuggestion(ctx, sg, ev); err != nil {
		return nil, err
	}
	s.suggestionsChanged(n.ID)
	out, err := s.resolveSuggestions(ctx, n.ID, []store.Suggestion{*sg})
	if err != nil {
		return nil, err
	}
	return &out[0], nil
}

func (s *Server) writeHTTPError(w http.ResponseWriter, err error) {
	var he *httpError
	if errors.As(err, &he) {
		writeError(w, he.code, he.slug, he.err.Error())
		return
	}
	s.writeNoteError(w, err)
}

func (s *Server) handleCreateSuggestion(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Comment)
	if !ok {
		return
	}
	var req createSuggestionRequest
	if !readJSON(w, r, &req) {
		return
	}
	out, err := s.createSuggestion(r.Context(), identityFrom(r.Context()), n, req)
	if err != nil {
		s.writeHTTPError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// acceptSuggestion applies the suggestion as one server edit attributed to its author and source.
func (s *Server) acceptSuggestion(ctx context.Context, id *Identity, n *store.Note, sgID string, force bool) error {
	unlock := s.lockNote(n.ID)
	defer unlock()
	sg, err := s.store.Suggestion(ctx, n.ID, sgID)
	if err != nil {
		return err
	}
	if sg.Status != "pending" {
		return &httpError{http.StatusConflict, "decided", errors.New("this suggestion was already " + sg.Status)}
	}
	_, err = s.hub.Replace(ctx, n.ID, collab.Author{UserID: sg.AuthorID, Name: sg.AuthorName, Source: string(sg.Source)},
		func(v collab.EditView) (int, int, string, error) {
			a, okA := v.Resolve(sg.AnchorStart)
			b, okB := v.Resolve(sg.AnchorEnd)
			if !okA || !okB || a > b || (a == b && sg.Original != "") {
				return 0, 0, "", &httpError{http.StatusConflict, "stale", errors.New("the suggested text was removed")}
			}
			if v.Text[a:b] != sg.Original && !force {
				return 0, 0, "", &httpError{http.StatusConflict, "stale", errStale}
			}
			return a, b, sg.Proposed, nil
		})
	if err != nil {
		return err
	}
	ev := id.event(n.ID, "suggestion.accept", map[string]any{"suggestion": sg.ID, "author": sg.AuthorName, "source": string(sg.Source)})
	if err := s.store.DecideSuggestion(ctx, n.ID, sg.ID, "accepted", id.displayName(), ev); err != nil {
		return err
	}
	s.suggestionsChanged(n.ID)
	return nil
}

func (s *Server) handleDecideSuggestion(w http.ResponseWriter, r *http.Request, accept bool) {
	n, l, ok := s.noteFor(w, r, permission.Comment)
	if !ok {
		return
	}
	id := identityFrom(r.Context())
	sgID := r.PathValue("id")
	if accept {
		if l < permission.Write {
			writeError(w, http.StatusForbidden, "forbidden", "accepting a suggestion needs write access")
			return
		}
		var req struct {
			Force bool `json:"force"`
		}
		if r.ContentLength != 0 && !readJSON(w, r, &req) {
			return
		}
		if err := s.acceptSuggestion(r.Context(), id, n, sgID, req.Force); err != nil {
			if errors.Is(err, store.ErrConflict) {
				writeError(w, http.StatusConflict, "decided", "this suggestion was already decided")
				return
			}
			s.writeHTTPError(w, err)
			return
		}
	} else {
		sg, err := s.store.Suggestion(r.Context(), n.ID, sgID)
		if err != nil {
			s.writeNoteError(w, err)
			return
		}
		if l < permission.Write && sg.AuthorID != id.UserID() {
			writeError(w, http.StatusForbidden, "forbidden", "only writers or the author can reject a suggestion")
			return
		}
		if err := s.store.DecideSuggestion(r.Context(), n.ID, sgID, "rejected", id.displayName(),
			id.event(n.ID, "suggestion.reject", map[string]any{"suggestion": sgID})); err != nil {
			if errors.Is(err, store.ErrConflict) {
				writeError(w, http.StatusConflict, "decided", "this suggestion was already decided")
				return
			}
			internalError(w, err)
			return
		}
		s.suggestionsChanged(n.ID)
	}
	sg, err := s.store.Suggestion(r.Context(), n.ID, sgID)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sg)
}

// lockNote serializes decisions on one note.
func (s *Server) lockNote(noteID string) func() {
	v, _ := s.noteLocks.LoadOrStore(noteID, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func (s *Server) handleGetSuggestion(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	sg, err := s.store.Suggestion(r.Context(), n.ID, r.PathValue("id"))
	if err != nil {
		s.writeNoteError(w, err)
		return
	}
	out, err := s.resolveSuggestions(r.Context(), n.ID, []store.Suggestion{*sg})
	if err != nil {
		internalError(w, err)
		return
	}
	var prompt json.RawMessage
	if sg.AIPrompt != "" {
		prompt = json.RawMessage(sg.AIPrompt)
	}
	writeJSON(w, http.StatusOK, struct {
		suggestionOut
		AIPrompt json.RawMessage `json:"ai_prompt,omitempty"`
	}{out[0], prompt})
}
