package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/greyhavenhq/greydoc/internal/ai"
	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

// handleAI asks the model about a selection and returns its answer as an AI-assisted suggestion.
// The note text never changes here.
func (s *Server) handleAI(w http.ResponseWriter, r *http.Request) {
	if s.ai == nil {
		writeError(w, http.StatusNotFound, "ai_disabled", "AI is not configured on this server")
		return
	}
	n, _, ok := s.noteFor(w, r, permission.Comment)
	if !ok {
		return
	}
	var req struct {
		Action      ai.Action `json:"action"`
		Instruction string    `json:"instruction"`
		createSuggestionRequest
	}
	if !readJSON(w, r, &req) {
		return
	}
	text, err := s.hub.Text(r.Context(), n.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	var start, end int
	if len(req.AnchorStart) > 0 {
		_, offs, oks, err := s.hub.Resolve(r.Context(), n.ID, req.AnchorStart, req.AnchorEnd)
		if err != nil {
			internalError(w, err)
			return
		}
		if !oks[0] || !oks[1] || offs[0] > offs[1] || offs[1] > len(text) {
			writeError(w, http.StatusConflict, "stale", "the selection changed; select the text again")
			return
		}
		start, end = offs[0], offs[1]
	} else if start, end, err = findQuote(text, req.Quote, req.Occurrence); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "bad_quote", err.Error())
		return
	}
	selection := text[start:end]
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	out, err := s.ai.Run(ctx, ai.Request{Action: req.Action, Instruction: req.Instruction, Document: text, Selection: selection})
	if err != nil {
		slog.Warn("ai request failed", "error", err)
		writeError(w, http.StatusBadGateway, "ai_failed", err.Error())
		return
	}
	sreq := req.createSuggestionRequest
	sreq.Proposed = out
	if req.Action == ai.ActionDiagram {
		// A diagram goes after the selection's last line. The selected text stays.
		at := len(text)
		if i := strings.IndexByte(text[end:], '\n'); i >= 0 {
			at = end + i
		}
		startRel, endRel, _, err := s.hub.Anchor(r.Context(), n.ID, func(string) (int, int, error) { return at, at, nil })
		if err != nil {
			internalError(w, err)
			return
		}
		sreq = createSuggestionRequest{AnchorStart: startRel, AnchorEnd: endRel, Original: "", Proposed: "\n\n" + strings.TrimSpace(out) + "\n", Reason: req.Reason}
	}
	sreq.Source = store.SourceAIAssisted
	if sreq.Reason == "" {
		sreq.Reason = aiReason(req.Action, req.Instruction)
	}
	sg, err := s.createSuggestion(r.Context(), identityFrom(r.Context()), n, sreq)
	if err != nil {
		var he *httpError
		if errors.As(err, &he) && he.slug == "no_change" {
			writeError(w, http.StatusUnprocessableEntity, "no_change", "the AI proposed no change")
			return
		}
		s.writeHTTPError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, sg)
}

func aiReason(a ai.Action, instruction string) string {
	switch a {
	case ai.ActionPrompt:
		return "AI: " + instruction
	case ai.ActionDiagram:
		return "AI: diagram"
	default:
		return "AI: " + string(a)
	}
}

// handleReviseSuggestion asks the model to change a pending AI suggestion and replaces it with the answer.
func (s *Server) handleReviseSuggestion(w http.ResponseWriter, r *http.Request) {
	if s.ai == nil {
		writeError(w, http.StatusNotFound, "ai_disabled", "AI is not configured on this server")
		return
	}
	n, _, ok := s.noteFor(w, r, permission.Comment)
	if !ok {
		return
	}
	var req struct {
		Instruction string `json:"instruction"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	old, err := s.store.Suggestion(r.Context(), n.ID, r.PathValue("id"))
	if err != nil {
		s.writeNoteError(w, err)
		return
	}
	if old.Status != "pending" || old.Source != store.SourceAIAssisted {
		writeError(w, http.StatusConflict, "not_revisable", "only pending AI suggestions can be revised")
		return
	}
	text, offs, oks, err := s.hub.Resolve(r.Context(), n.ID, old.AnchorStart, old.AnchorEnd)
	if err != nil {
		internalError(w, err)
		return
	}
	a, b := offs[0], offs[1]
	if !oks[0] || !oks[1] || a > b || text[a:b] != old.Original {
		writeError(w, http.StatusConflict, "stale", "the text changed since this suggestion")
		return
	}
	doc := text[:a] + old.Proposed + text[b:]
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	out, err := s.ai.Run(ctx, ai.Request{Action: ai.ActionRevise, Instruction: req.Instruction, Document: doc, Selection: strings.TrimSpace(old.Proposed)})
	if err != nil {
		writeError(w, http.StatusBadGateway, "ai_failed", err.Error())
		return
	}
	lead := old.Proposed[:len(old.Proposed)-len(strings.TrimLeft(old.Proposed, " \n"))]
	trail := old.Proposed[len(strings.TrimRight(old.Proposed, " \n")):]
	id := identityFrom(r.Context())
	sg, err := s.createSuggestion(r.Context(), id, n, createSuggestionRequest{
		AnchorStart: old.AnchorStart, AnchorEnd: old.AnchorEnd, Original: old.Original,
		Proposed: lead + strings.TrimSpace(out) + trail, Reason: "AI: " + req.Instruction, Source: store.SourceAIAssisted,
	})
	if err != nil {
		s.writeHTTPError(w, err)
		return
	}
	_ = s.store.DecideSuggestion(r.Context(), n.ID, old.ID, "replaced", id.displayName(),
		id.event(n.ID, "suggestion.revise", map[string]any{"suggestion": old.ID, "by": sg.ID, "instruction": excerpt(req.Instruction)}))
	s.suggestionsChanged(n.ID)
	writeJSON(w, http.StatusCreated, sg)
}
