package server

import (
	"bytes"
	"context"
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
	f, ok := s.readUpload(w, r)
	if !ok {
		return
	}
	m, err := s.storeUpload(r.Context(), n.ID, identityFrom(r.Context()).UserID(), f)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"url": "/uploads/" + m.StoredName, "media": m})
}

type uploadFile struct {
	name, contentType, ext string
	data                   []byte
}

// readUpload reads the multipart field "file" and checks its size and type. It writes the error response itself.
func (s *Server) readUpload(w http.ResponseWriter, r *http.Request) (uploadFile, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+64<<10)
	file, hdr, err := r.FormFile("file")
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large", "the file is too large")
			return uploadFile{}, false
		}
		writeError(w, http.StatusBadRequest, "bad_upload", "send the file as multipart field \"file\"")
		return uploadFile{}, false
	}
	defer file.Close()
	if hdr.Size > s.cfg.MaxUploadBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "the file is too large")
		return uploadFile{}, false
	}
	data, err := io.ReadAll(io.LimitReader(file, s.cfg.MaxUploadBytes+1))
	if err != nil || int64(len(data)) > s.cfg.MaxUploadBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "the file is too large")
		return uploadFile{}, false
	}
	ct := sniff(hdr.Filename, data[:min(len(data), 512)])
	ext, allowed := mediaTypes[ct]
	if !allowed {
		writeError(w, http.StatusUnsupportedMediaType, "bad_type", "only images and PDF files can be uploaded")
		return uploadFile{}, false
	}
	return uploadFile{name: filepath.Base(hdr.Filename), contentType: ct, ext: ext, data: data}, true
}

// storeUpload writes a checked file to the uploads directory and records it on the note.
func (s *Server) storeUpload(ctx context.Context, noteID, userID string, f uploadFile) (*store.Media, error) {
	name := secrets.NewID() + f.ext
	if err := os.MkdirAll(s.uploadsDir(), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(s.uploadsDir(), name), f.data, 0o644); err != nil {
		return nil, err
	}
	m := &store.Media{NoteID: noteID, StoredName: name, Filename: f.name, ContentType: f.contentType, Size: int64(len(f.data)), UploadedBy: userID}
	return m, s.store.AddMedia(ctx, m)
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
	f, err := os.Open(filepath.Join(s.uploadsDir(), name))
	if err != nil {
		// A missing file may be restored later, so its 404 is not cached.
		w.Header().Set("Cache-Control", "no-store")
		writeError(w, http.StatusNotFound, "not_found", "no such file")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
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
