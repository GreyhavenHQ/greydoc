// Package mirror writes each note as a markdown file in the data directory. The mirror is write-only:
// edits on disk are ignored and overwritten.
package mirror

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/greyhavenhq/greydoc/internal/notemeta"
	"github.com/greyhavenhq/greydoc/internal/store"
)

type Mirror struct {
	st       *store.Store
	dir      string
	debounce time.Duration

	mu     sync.Mutex
	timers map[string]*time.Timer
	paths  map[string]string
	closed bool
	wg     sync.WaitGroup
}

func New(st *store.Store, dataDir string, debounce time.Duration) *Mirror {
	return &Mirror{st: st, dir: filepath.Join(dataDir, "notes"), debounce: debounce,
		timers: map[string]*time.Timer{}, paths: map[string]string{}}
}

// Touch schedules a write of the note after the debounce delay.
func (m *Mirror) Touch(noteID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	if t := m.timers[noteID]; t != nil && t.Stop() {
		m.wg.Done()
	}
	m.wg.Add(1)
	m.timers[noteID] = time.AfterFunc(m.debounce, func() {
		defer m.wg.Done()
		m.mu.Lock()
		delete(m.timers, noteID)
		m.mu.Unlock()
		if err := m.write(context.Background(), noteID); err != nil {
			slog.Error("mirror write failed", "note", noteID, "error", err)
		}
	})
}

func (m *Mirror) Remove(noteID string) {
	m.mu.Lock()
	if t := m.timers[noteID]; t != nil && t.Stop() {
		m.wg.Done()
	}
	delete(m.timers, noteID)
	path := m.paths[noteID]
	delete(m.paths, noteID)
	m.mu.Unlock()
	if path != "" {
		_ = os.Remove(path)
	}
}

// Close flushes pending writes.
func (m *Mirror) Close() {
	m.mu.Lock()
	m.closed = true
	var pending []string
	for id, t := range m.timers {
		if t.Stop() {
			m.wg.Done()
			pending = append(pending, id)
		}
	}
	m.timers = map[string]*time.Timer{}
	m.mu.Unlock()
	for _, id := range pending {
		_ = m.write(context.Background(), id)
	}
	m.wg.Wait()
}

// Rebuild rewrites every note and deletes files that belong to no note.
func (m *Mirror) Rebuild(ctx context.Context) error {
	ids, err := m.st.AllNoteIDs(ctx)
	if err != nil {
		return err
	}
	keep := map[string]bool{}
	for _, id := range ids {
		if err := m.write(ctx, id); err != nil {
			return err
		}
		m.mu.Lock()
		if p := m.paths[id]; p != "" {
			keep[p] = true
		}
		m.mu.Unlock()
	}
	entries, err := os.ReadDir(m.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, e := range entries {
		p := filepath.Join(m.dir, e.Name())
		if strings.HasSuffix(e.Name(), ".md") && !keep[p] {
			_ = os.Remove(p)
		}
	}
	return nil
}

func (m *Mirror) write(ctx context.Context, noteID string) error {
	n, err := m.st.NoteByID(ctx, noteID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && n.DeletedAt != "") {
		m.Remove(noteID)
		return nil
	}
	if err != nil {
		return err
	}
	owner := ""
	if n.OwnerID != "" {
		if u, err := m.st.UserByID(ctx, n.OwnerID); err == nil {
			owner = u.Username
		}
	}
	body := Render(n, owner)
	if err := os.MkdirAll(m.dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(m.dir, n.PrimaryAlias+".md")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(body), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	m.mu.Lock()
	old := m.paths[noteID]
	m.paths[noteID] = path
	m.mu.Unlock()
	if old != "" && old != path {
		_ = os.Remove(old)
	}
	return nil
}

type meta struct {
	ID      string `yaml:"id"`
	Alias   string `yaml:"alias"`
	Owner   string `yaml:"owner,omitempty"`
	Created string `yaml:"created"`
	Updated string `yaml:"updated"`
}

// Render returns the file content: the note with greydoc metadata in its front matter.
// Existing front matter keeps its text. The greydoc block is appended inside it.
func Render(n *store.Note, owner string) string {
	g, _ := yaml.Marshal(map[string]meta{"greydoc": {ID: n.ID, Alias: n.PrimaryAlias, Owner: owner, Created: n.CreatedAt, Updated: n.UpdatedAt}})
	lines := strings.Split(n.Content, "\n")
	if ex := notemeta.ExtractFrontmatter(lines); ex != nil && !ex.Incomplete {
		head := strings.Join(lines[:ex.LineOffset-1], "\n")
		rest := strings.Join(lines[ex.LineOffset-1:], "\n")
		return head + "\n" + string(g) + rest
	}
	var top []byte
	if n.Title != "" || len(n.Tags) > 0 {
		top, _ = yaml.Marshal(struct {
			Title string   `yaml:"title,omitempty"`
			Tags  []string `yaml:"tags,omitempty"`
		}{n.Title, n.Tags})
	}
	return "---\n" + string(top) + string(g) + "---\n" + n.Content
}
