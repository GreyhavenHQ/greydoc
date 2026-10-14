package server

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/secrets"
	"github.com/greyhavenhq/greydoc/internal/store"
)

// Uploads are public by unguessable name, like HedgeDoc, so images also load on view-only links.

var mediaTypes = map[string]string{
	"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
	"application/pdf": ".pdf", "image/svg+xml": ".svg",
}

var storedName = regexp.MustCompile(`^[0-9a-f]{32}\.(png|jpg|gif|webp|pdf|svg)$`)

func (s *Server) uploadsDir() string { return filepath.Join(s.cfg.DataDir, "uploads") }

func sniff(name string, head []byte) string {
	ct := http.DetectContentType(head)
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	if strings.EqualFold(filepath.Ext(name), ".svg") && bytes.Contains(bytes.ToLower(head), []byte("<svg")) {
		return "image/svg+xml"
	}
	return ct
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Write)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+64<<10)
	file, hdr, err := r.FormFile("file")
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large", "the file is too large")
			return
		}
		writeError(w, http.StatusBadRequest, "bad_upload", "send the file as multipart field \"file\"")
		return
	}
	defer file.Close()
	if hdr.Size > s.cfg.MaxUploadBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "the file is too large")
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, s.cfg.MaxUploadBytes+1))
	if err != nil || int64(len(data)) > s.cfg.MaxUploadBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "the file is too large")
		return
	}
	ct := sniff(hdr.Filename, data[:min(len(data), 512)])
	ext, allowed := mediaTypes[ct]
	if !allowed {
		writeError(w, http.StatusUnsupportedMediaType, "bad_type", "only images and PDF files can be uploaded")
		return
	}
	name := secrets.NewID() + ext
	if err := os.MkdirAll(s.uploadsDir(), 0o755); err != nil {
		internalError(w, err)
		return
	}
	if err := os.WriteFile(filepath.Join(s.uploadsDir(), name), data, 0o644); err != nil {
		internalError(w, err)
		return
	}
	id := identityFrom(r.Context())
	m := &store.Media{NoteID: n.ID, StoredName: name, Filename: filepath.Base(hdr.Filename), ContentType: ct, Size: int64(len(data)), UploadedBy: id.UserID()}
	if err := s.store.AddMedia(r.Context(), m); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"url": "/uploads/" + name, "media": m})
}

func (s *Server) handleServeUpload(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !storedName.MatchString(name) {
		writeError(w, http.StatusNotFound, "not_found", "no such file")
		return
	}
	ext := filepath.Ext(name)
	for ct, e := range mediaTypes {
		if e == ext {
			w.Header().Set("Content-Type", ct)
		}
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	f, err := os.Open(filepath.Join(s.uploadsDir(), name))
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "no such file")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		internalError(w, err)
		return
	}
	http.ServeContent(w, r, name, st.ModTime(), f)
}

func (s *Server) removeNoteMedia(media []store.Media) {
	for _, m := range media {
		if storedName.MatchString(m.StoredName) {
			_ = os.Remove(filepath.Join(s.uploadsDir(), m.StoredName))
		}
	}
}
