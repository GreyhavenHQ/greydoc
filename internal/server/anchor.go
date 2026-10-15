package server

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

var errQuoteNotFound = errors.New("the quoted text is not in the document")

// findQuote locates the occurrence-th (1-based) exact match of quote. With occurrence 0, the quote MUST be unique.
func findQuote(text, quote string, occurrence int) (int, int, error) {
	if quote == "" {
		return 0, 0, errors.New("quote is empty")
	}
	var hits []int
	for from := 0; ; {
		i := strings.Index(text[from:], quote)
		if i < 0 {
			break
		}
		hits = append(hits, from+i)
		from += i + 1
	}
	switch {
	case len(hits) == 0:
		return 0, 0, errQuoteNotFound
	case occurrence == 0 && len(hits) > 1:
		return 0, 0, fmt.Errorf("the quoted text appears %d times; quote more context or pass occurrence", len(hits))
	case occurrence > len(hits):
		return 0, 0, fmt.Errorf("the quoted text appears only %d times", len(hits))
	}
	if occurrence == 0 {
		occurrence = 1
	}
	start := hits[occurrence-1]
	return start, start + len(quote), nil
}

// anchorQuote returns Yjs relative positions for a quote in the live note.
func (s *Server) anchorQuote(ctx context.Context, noteID, quote string, occurrence int) ([]byte, []byte, string, error) {
	return s.hub.Anchor(ctx, noteID, func(text string) (int, int, error) { return findQuote(text, quote, occurrence) })
}
