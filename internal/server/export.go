package server

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/greyhavenhq/greydoc/internal/permission"
)

var unsafeFilename = regexp.MustCompile(`[^\p{L}\p{N}]+`)

func downloadName(title, alias, ext string) string {
	name := strings.Trim(unsafeFilename.ReplaceAllString(strings.ToLower(title), "-"), "-")
	if name == "" {
		name = alias
	}
	if len(name) > 80 {
		name = name[:80]
	}
	return name + ext
}

func (s *Server) handleDownloadMarkdown(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	text, err := s.hub.Text(r.Context(), n.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+downloadName(n.Title, n.PrimaryAlias, ".md")+`"`)
	_, _ = w.Write([]byte(text))
}
