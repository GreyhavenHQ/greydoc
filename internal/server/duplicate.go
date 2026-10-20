package server

import (
	"context"
	"net/http"
	"os"
	"path/filepath"

	"github.com/greyhavenhq/greydoc/internal/notemeta"
	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

func (s *Server) handleDuplicateNote(w http.ResponseWriter, r *http.Request) {
	src, _, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in to duplicate documents")
		return
	}
	n, err := s.duplicateNote(r.Context(), id, src, r.Host)
	if err != nil {
		s.writeHTTPError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, noteView{Note: n, Level: permission.Full})
}

// duplicateNote creates a copy of src owned by id. Each local upload gets its own file, so purging src keeps the copy whole.
func (s *Server) duplicateNote(ctx context.Context, id *Identity, src *store.Note, host string) (*store.Note, error) {
	text, err := s.hub.Text(ctx, src.ID)
	if err != nil {
		return nil, err
	}
	filenames := map[string]string{}
	if media, err := s.store.NoteMedia(ctx, src.ID); err == nil {
		for _, m := range media {
			filenames[m.StoredName] = m.Filename
		}
	}
	copied := map[string]uploadFile{}
	link := localUpload(host)
	text = link.ReplaceAllStringFunc(text, func(m string) string {
		sub := link.FindStringSubmatch(m)
		f, ok := s.copyUpload(sub[2], filenames)
		if !ok {
			return m
		}
		copied[f.storedName] = f.uploadFile
		return sub[1] + "/uploads/" + f.storedName
	})
	removeCopies := func() {
		for name := range copied {
			_ = os.Remove(filepath.Join(s.uploadsDir(), name))
		}
	}

	spec := NoteSpec{
		Content:   notemeta.PrefixTitle(text, "Copy of "),
		eventData: map[string]any{"duplicated_from": src.PrimaryAlias, "source_title": src.Title},
	}
	if src.FolderID != "" {
		if _, _, err := s.liveFolder(ctx, id, src.FolderID, permission.Write); err == nil {
			spec.Folder = src.FolderID
		}
	}
	n, err := s.createNote(ctx, id, spec)
	if err != nil {
		removeCopies()
		return nil, err
	}
	for name, f := range copied {
		if err := s.store.AddMedia(ctx, uploadMedia(n.ID, id.UserID(), name, f)); err != nil {
			return nil, err
		}
	}
	return n, nil
}

type copiedUpload struct {
	uploadFile
	storedName string
}

// copyUpload writes a copy of the stored upload name. It returns false when the file cannot be read or written.
func (s *Server) copyUpload(name string, filenames map[string]string) (copiedUpload, bool) {
	data, err := os.ReadFile(filepath.Join(s.uploadsDir(), name))
	if err != nil {
		return copiedUpload{}, false
	}
	f := uploadFile{name: name, ext: filepath.Ext(name), data: data}
	if fn := filenames[name]; fn != "" {
		f.name = fn
	}
	for ct, ext := range mediaTypes {
		if ext == f.ext {
			f.contentType = ct
		}
	}
	stored, err := s.writeUpload(f)
	if err != nil {
		return copiedUpload{}, false
	}
	return copiedUpload{f, stored}, true
}
