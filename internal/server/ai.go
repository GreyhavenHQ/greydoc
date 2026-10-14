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
	selection := req.Original
	if len(req.AnchorStart) == 0 {
		start, end, err := findQuote(text, req.Quote, req.Occurrence)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "bad_quote", err.Error())
			return
		}
		selection = text[start:end]
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	out, err := s.ai.Run(ctx, ai.Request{Action: req.Action, Instruction: req.Instruction, Document: text, Selection: selection})
	if err != nil {
		slog.Warn("ai request failed", "error", err)
		writeError(w, http.StatusBadGateway, "ai_failed", err.Error())
		return
	}
	if req.Action == ai.ActionDiagram && selection != "" && !strings.Contains(out, selection) {
		out = strings.TrimRight(selection, "\n") + "\n\n" + out
		if strings.HasSuffix(selection, "\n") {
			out += "\n"
		}
	}
	sreq := req.createSuggestionRequest
	sreq.Proposed = out
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
