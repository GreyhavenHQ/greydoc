package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/secrets"
	"github.com/greyhavenhq/greydoc/internal/store"
)

// A note bundle is a zip: the Markdown document at the root, its uploads in uploads/, and note.json.
// Links to uploads are relative in the zip, so the unpacked folder reads well in any Markdown tool.

const bundleFormat = 1

type bundleMeta struct {
	Greydoc      int             `json:"greydoc"`
	Alias        string          `json:"alias"`
	ExtraAliases []string        `json:"extra_aliases,omitempty"`
	Title        string          `json:"title"`
	CreatedAt    string          `json:"created_at"`
	UpdatedAt    string          `json:"updated_at"`
	AgentPolicy  string          `json:"agent_policy"`
	Permissions  *PermissionSpec `json:"permissions,omitempty"`
	// Uploads maps a file in uploads/ to its original file name.
	Uploads map[string]string `json:"uploads,omitempty"`
}

// localUpload finds links to this server's uploads: /uploads/<name>, or the same with this host in front.
func localUpload(host string) *regexp.Regexp {
	return regexp.MustCompile(`(^|[\s("'=<])(?:https?://` + regexp.QuoteMeta(host) + `)?/uploads/([0-9a-f]{32}\.(?:png|jpg|gif|webp|pdf|svg))`)
}

// bundledUpload finds relative links into the bundle's uploads/ folder.
var bundledUpload = regexp.MustCompile(`(^|[\s("'=<])(?:\./)?uploads/([A-Za-z0-9._-]+)`)

func (s *Server) handleExportBundle(w http.ResponseWriter, r *http.Request) {
	n, level, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	text, err := s.hub.Text(r.Context(), n.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	meta := bundleMeta{Greydoc: bundleFormat, Alias: n.PrimaryAlias, Title: n.Title, CreatedAt: n.CreatedAt, UpdatedAt: n.UpdatedAt,
		AgentPolicy: string(n.AgentPolicy), Uploads: map[string]string{}}
	if aliases, err := s.store.Aliases(r.Context(), n.ID); err == nil {
		for _, a := range aliases {
			if !a.Primary {
				meta.ExtraAliases = append(meta.ExtraAliases, a.Name)
			}
		}
	}
	// Who else has access is the owner's business, as in the Share dialog.
	if level >= permission.Full {
		if meta.Permissions, err = s.exportPermissions(r.Context(), n.ID); err != nil {
			internalError(w, err)
			return
		}
	}
	names := map[string]bool{}
	text = localUpload(r.Host).ReplaceAllStringFunc(text, func(m string) string {
		sub := localUpload(r.Host).FindStringSubmatch(m)
		if _, err := os.Stat(filepath.Join(s.uploadsDir(), sub[2])); err != nil {
			return m
		}
		names[sub[2]] = true
		return sub[1] + "uploads/" + sub[2]
	})
	if media, err := s.store.NoteMedia(r.Context(), n.ID); err == nil {
		for _, m := range media {
			if names[m.StoredName] {
				meta.Uploads[m.StoredName] = m.Filename
			}
		}
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name string, data []byte) error {
		f, err := zw.Create(name)
		if err == nil {
			_, err = f.Write(data)
		}
		return err
	}
	metaJSON, _ := json.MarshalIndent(meta, "", "  ")
	err = errors.Join(add(downloadName(n.Title, n.PrimaryAlias, ".md"), []byte(text)), add("note.json", metaJSON))
	for name := range names {
		data, rerr := os.ReadFile(filepath.Join(s.uploadsDir(), name))
		err = errors.Join(err, rerr, add("uploads/"+name, data))
	}
	if err = errors.Join(err, zw.Close()); err != nil {
		internalError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+downloadName(n.Title, n.PrimaryAlias, ".zip")+`"`)
	_, _ = w.Write(buf.Bytes())
}

func (s *Server) exportPermissions(ctx context.Context, noteID string) (*PermissionSpec, error) {
	acl, err := s.store.NoteACL(ctx, noteID)
	if err != nil {
		return nil, err
	}
	p := &PermissionSpec{Everyone: "deny", SignedIn: "deny", Users: map[string]string{}, Groups: map[string]string{}}
	for _, g := range acl.Groups {
		switch g.Group {
		case store.GroupEveryone:
			p.Everyone = g.Level.String()
		case store.GroupSignedIn:
			p.SignedIn = g.Level.String()
		default:
			p.Groups[g.Group] = g.Level.String()
		}
	}
	for _, u := range acl.Users {
		if u.UserID != acl.OwnerID {
			p.Users[u.Username] = u.Level.String()
		}
	}
	return p, nil
}

type bundleFile struct {
	name, contentType, original string
	data                        []byte
}

func (s *Server) handleImportBundle(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in to import notes")
		return
	}
	limit := int64(s.cfg.MaxNoteLength)*4 + 20*s.cfg.MaxUploadBytes
	r.Body = http.MaxBytesReader(w, r.Body, limit+64<<10)
	var raw []byte
	var err error
	if ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); ct == "multipart/form-data" {
		file, _, ferr := r.FormFile("file")
		if ferr != nil {
			writeError(w, http.StatusBadRequest, "bad_upload", "send the zip as multipart field \"file\"")
			return
		}
		defer file.Close()
		raw, err = io.ReadAll(file)
	} else {
		raw, err = io.ReadAll(r.Body)
	}
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "the zip is too large")
		return
	} else if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "could not read the zip")
		return
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_zip", "the file is not a zip")
		return
	}

	var doc *zip.File
	var meta bundleMeta
	var files []*zip.File
	for _, f := range zr.File {
		name := strings.TrimPrefix(f.Name, "./")
		dir, base := path.Split(name)
		ext := strings.ToLower(path.Ext(base))
		switch {
		case f.FileInfo().IsDir() || strings.HasPrefix(base, "."):
		case dir == "" && (ext == ".md" || ext == ".markdown"):
			if doc != nil {
				writeError(w, http.StatusBadRequest, "bad_bundle", "the zip holds more than one Markdown document at its root")
				return
			}
			doc = f
		case dir == "" && base == "note.json":
			if b, err := readZipFile(f, 1<<20); err != nil || json.Unmarshal(b, &meta) != nil {
				writeError(w, http.StatusBadRequest, "bad_bundle", "note.json is not valid")
				return
			}
		case dir == "uploads/":
			files = append(files, f)
		}
	}
	// note.json may come after the uploads in the zip, so uploads are read once it is known.
	uploads := map[string]*bundleFile{}
	for _, f := range files {
		base := path.Base(f.Name)
		{
			data, err := readZipFile(f, s.cfg.MaxUploadBytes)
			if err != nil {
				writeError(w, http.StatusRequestEntityTooLarge, "too_large", "uploads/"+base+" is too large")
				return
			}
			ct := sniff(base, data[:min(len(data), 512)])
			ext, allowed := mediaTypes[ct]
			if !allowed {
				writeError(w, http.StatusUnsupportedMediaType, "bad_type", "uploads/"+base+" is not an image or a PDF file")
				return
			}
			original := base
			if o := meta.Uploads[base]; o != "" {
				original = o
			}
			uploads[base] = &bundleFile{name: secrets.NewID() + ext, contentType: ct, original: original, data: data}
		}
	}
	if doc == nil {
		writeError(w, http.StatusBadRequest, "bad_bundle", "the zip holds no Markdown document at its root")
		return
	}
	text, err := readZipFile(doc, int64(s.cfg.MaxNoteLength)*4)
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "the document is too long")
		return
	}
	content := bundledUpload.ReplaceAllStringFunc(string(text), func(m string) string {
		sub := bundledUpload.FindStringSubmatch(m)
		if u := uploads[sub[2]]; u != nil {
			return sub[1] + "/uploads/" + u.name
		}
		return m
	})

	spec := NoteSpec{Content: content, Alias: meta.Alias, ExtraAliases: meta.ExtraAliases, CreatedAt: meta.CreatedAt,
		UpdatedAt: meta.UpdatedAt, AgentPolicy: meta.AgentPolicy, Permissions: s.knownUsersOnly(r.Context(), meta.Permissions)}
	n, err := s.createNote(r.Context(), id, spec)
	renamed := false
	if errors.Is(err, store.ErrAliasTaken) || errors.Is(err, store.ErrAliasForbidden) {
		// The address belongs to another note here. Keep the note under a new address.
		spec.Alias, spec.ExtraAliases, renamed = "", nil, meta.Alias != ""
		n, err = s.createNote(r.Context(), id, spec)
	}
	if err != nil {
		s.writeHTTPError(w, err)
		return
	}
	if err := os.MkdirAll(s.uploadsDir(), 0o755); err != nil {
		internalError(w, err)
		return
	}
	for _, u := range uploads {
		if err := os.WriteFile(filepath.Join(s.uploadsDir(), u.name), u.data, 0o644); err != nil {
			internalError(w, err)
			return
		}
		m := &store.Media{NoteID: n.ID, StoredName: u.name, Filename: u.original, ContentType: u.contentType, Size: int64(len(u.data)), UploadedBy: id.UserID()}
		if err := s.store.AddMedia(r.Context(), m); err != nil {
			internalError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusCreated, struct {
		noteView
		Renamed bool `json:"renamed"`
		Uploads int  `json:"uploads"`
	}{noteView{Note: n, Level: permission.Full}, renamed, len(uploads)})
}

// knownUsersOnly drops grants to people who have no account on this server.
func (s *Server) knownUsersOnly(ctx context.Context, p *PermissionSpec) *PermissionSpec {
	if p == nil || len(p.Users) == 0 {
		return p
	}
	out := *p
	out.Users = map[string]string{}
	for name, level := range p.Users {
		if _, err := s.store.UserByUsername(ctx, name); err == nil {
			out.Users[name] = level
		}
	}
	return &out
}

func readZipFile(f *zip.File, limit int64) ([]byte, error) {
	if f.UncompressedSize64 > uint64(limit) {
		return nil, errors.New("too large")
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, limit+1))
	if err == nil && int64(len(b)) > limit {
		err = errors.New("too large")
	}
	return b, err
}
