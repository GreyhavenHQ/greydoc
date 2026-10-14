package server

import (
	"context"

	"github.com/greyhavenhq/greydoc/internal/collab"
)

// EditForTest replaces a note's text as a server edit by "test".
func (s *Server) EditForTest(ctx context.Context, noteID, text string) (string, error) {
	return s.hub.Edit(ctx, noteID, collab.Author{UserID: "test", Name: "test", Source: "human"},
		func(collab.EditView) (string, error) { return text, nil })
}
