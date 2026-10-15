package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/secrets"
	"github.com/greyhavenhq/greydoc/internal/store"
)

// An agent cannot attach a file to a tool call. It asks for a one-time upload URL, then runs curl with the file,
// so the bytes go from its disk to greydoc and never through the model.

const uploadTicketTTL = 10 * time.Minute

type uploadIn struct {
	Note     string `json:"note" jsonschema:"note alias or URL"`
	Filename string `json:"filename,omitempty" jsonschema:"path or name of the file to upload, used in the curl command"`
}

func (s *Server) mcpCreateUpload(ctx context.Context, req *mcp.CallToolRequest, in uploadIn) (*mcp.CallToolResult, any, error) {
	id, err := s.mcpIdentity(req)
	if err != nil {
		return nil, nil, err
	}
	// An upload does not change the note. The text changes only when an edit or a suggestion uses the file.
	n, _, err := s.mcpNote(ctx, id, in.Note, permission.Comment)
	if err != nil {
		return nil, nil, err
	}
	token := secrets.NewToken("gd_up_")
	expires := time.Now().Add(uploadTicketTTL)
	if err := s.store.CreateUploadTicket(ctx, store.UploadTicket{Hash: secrets.Hash(s.secret, token), NoteID: n.ID, UserID: id.UserID(),
		DisplayName: id.displayName(), Client: id.Client, Filename: in.Filename, ExpiresAt: store.FormatTime(expires)}); err != nil {
		return nil, nil, err
	}
	url := s.publicURL() + "/api/uploads/" + token
	path := in.Filename
	if path == "" {
		path = "/path/to/image.png"
	}
	return jsonResult(map[string]any{
		"upload_url": url,
		"command":    `curl -sS -F "file=@` + path + `" ` + url,
		"expires_at": store.FormatTime(expires),
		"next": "Run the command with the path of the file. It prints JSON with \"markdown\", for example ![chart.png](/uploads/…). " +
			"Put that Markdown in the note with edit_note, or propose it with suggest_edit. The URL works once. Images and PDF files only.",
	})
}

func (s *Server) handleTicketUpload(w http.ResponseWriter, r *http.Request) {
	gone := func() {
		writeError(w, http.StatusGone, "gone", "this upload URL was used or has expired; ask for a new one with create_upload")
	}
	hash := secrets.Hash(s.secret, r.PathValue("ticket"))
	t, err := s.store.UploadTicket(r.Context(), hash)
	if errors.Is(err, store.ErrNotFound) {
		gone()
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	n, err := s.store.NoteByID(r.Context(), t.NoteID)
	if err != nil || n.DeletedAt != "" {
		gone()
		return
	}
	// The file is checked first, so a rejected file leaves the ticket usable.
	f, ok := s.readUpload(w, r)
	if !ok {
		return
	}
	if used, err := s.store.ConsumeUploadTicket(r.Context(), hash); err != nil {
		internalError(w, err)
		return
	} else if !used {
		gone()
		return
	}
	m, err := s.storeUpload(r.Context(), n.ID, t.UserID, f)
	if err != nil {
		internalError(w, err)
		return
	}
	url := "/uploads/" + m.StoredName
	_ = s.store.AddEvent(r.Context(), &store.Event{NoteID: n.ID, ActorID: t.UserID, ActorName: t.DisplayName, Source: store.SourceAgent,
		Client: t.Client, Kind: "media.upload", Data: map[string]any{"filename": f.name, "url": url, "size": len(f.data)}})
	markdown := "[" + f.name + "](" + url + ")"
	if strings.HasPrefix(f.contentType, "image/") {
		markdown = "!" + markdown
	}
	writeJSON(w, http.StatusCreated, map[string]any{"url": url, "markdown": markdown})
}
