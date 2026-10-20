package store

import (
	"context"
	"fmt"
	"strings"
)

// Viewer is who a list is for. Local sees everything.
type Viewer struct {
	Local bool
	// Admin sees every note's trash and audit events.
	Admin  bool
	UserID string
	// Groups are the viewer's app_group ids.
	Groups []string
}

type Scope string

const (
	ScopeRecent Scope = "recent"
	ScopeMine   Scope = "mine"
	ScopeShared Scope = "shared"
	ScopeAll    Scope = "all"
)

type ListFilter struct {
	Viewer Viewer
	Scope  Scope
	Tag    string
	// Group keeps the notes that grant this app_group id a level, directly or through a folder above them.
	Group string
	// Folder lists one folder by id, or the top level with FolderRoot.
	Folder string
	// IDs restricts the list, for search results, and keeps their order.
	IDs    []string
	Limit  int
	Offset int
}

// FolderRoot is the Folder filter for notes outside any folder.
const FolderRoot = "root"

type NoteSummary struct {
	ID           string   `json:"id"`
	PrimaryAlias string   `json:"alias"`
	Title        string   `json:"title"`
	Description  string   `json:"description"`
	Tags         []string `json:"tags"`
	OwnerName    string   `json:"owner"`
	OwnerID      string   `json:"owner_id"`
	UpdatedAt    string   `json:"updated_at"`
	VisitedAt    string   `json:"visited_at,omitempty"`
	Pinned       bool     `json:"pinned"`
	Snippet      string   `json:"snippet,omitempty"`
	ViewCount    int64    `json:"view_count"`
	Slides       bool     `json:"slides"`
	FolderID     string   `json:"folder_id,omitempty"`
	// FolderName is empty when the viewer cannot see the folder.
	FolderName string `json:"folder_name,omitempty"`
}

func viewerGroups(v Viewer) []string {
	groups := append([]string{GroupEveryone}, v.Groups...)
	if v.UserID != "" {
		groups = append(groups, GroupSignedIn)
	}
	return groups
}

// visibleFolders selects the ids of folders the viewer can read: owned or granted, and everything below them.
func (s *Store) visibleFolders(v Viewer) (string, []any) {
	groups := viewerGroups(v)
	q := `WITH RECURSIVE vf(id) AS (SELECT f.id FROM folder f WHERE f.deleted_at IS NULL AND (f.owner_id = ?
			OR EXISTS (SELECT 1 FROM folder_user_grant ug WHERE ug.folder_id = f.id AND ug.user_id = ?)
			OR EXISTS (SELECT 1 FROM folder_group_grant gg WHERE gg.folder_id = f.id AND gg.group_name IN (` + placeholders(len(groups)) + `)))
		UNION SELECT c.id FROM folder c JOIN vf ON c.parent_id = vf.id WHERE c.deleted_at IS NULL) SELECT id FROM vf`
	args := []any{v.UserID, v.UserID}
	for _, g := range groups {
		args = append(args, g)
	}
	return q, args
}

// visibleWhere matches notes the viewer can read through ownership, a grant, or a folder above them.
func (s *Store) visibleWhere(v Viewer) (string, []any) {
	if v.Local {
		return "1 = 1", nil
	}
	groups := viewerGroups(v)
	vf, fargs := s.visibleFolders(v)
	where := `(n.owner_id = ? OR EXISTS (SELECT 1 FROM note_user_grant ug WHERE ug.note_id = n.id AND ug.user_id = ?)
		OR EXISTS (SELECT 1 FROM note_group_grant gg WHERE gg.note_id = n.id AND gg.group_name IN (` + placeholders(len(groups)) + `))
		OR n.folder_id IN (` + vf + `))`
	args := []any{v.UserID, v.UserID}
	for _, g := range groups {
		args = append(args, g)
	}
	return where, append(args, fargs...)
}

func (s *Store) ListNotes(ctx context.Context, f ListFilter) ([]NoteSummary, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 200
	}
	where, args := s.visibleWhere(f.Viewer)
	where = "n.deleted_at IS NULL AND " + where
	join := "LEFT JOIN note_visit v ON v.note_id = n.id AND v.user_id = ?"
	args = append([]any{f.Viewer.UserID}, args...)
	order := "n.updated_at DESC"
	switch f.Scope {
	case ScopeRecent:
		where += " AND v.visited_at IS NOT NULL"
		order = "v.pinned DESC, v.visited_at DESC"
	case ScopeMine:
		where += " AND n.owner_id = ?"
		args = append(args, f.Viewer.UserID)
	case ScopeShared:
		gw := "1 = 0"
		if len(f.Viewer.Groups) > 0 {
			gw = "gg.group_name IN (" + placeholders(len(f.Viewer.Groups)) + ")"
		}
		where += ` AND (n.owner_id IS NULL OR n.owner_id <> ?) AND (EXISTS (SELECT 1 FROM note_user_grant ug WHERE ug.note_id = n.id AND ug.user_id = ?)
			OR EXISTS (SELECT 1 FROM note_group_grant gg WHERE gg.note_id = n.id AND ` + gw + `))`
		args = append(args, f.Viewer.UserID, f.Viewer.UserID)
		for _, g := range f.Viewer.Groups {
			args = append(args, g)
		}
	}
	if f.Tag != "" {
		where += " AND EXISTS (SELECT 1 FROM note_tag t WHERE t.note_id = n.id AND t.tag = ?)"
		args = append(args, f.Tag)
	}
	if f.Group != "" {
		where += ` AND (EXISTS (SELECT 1 FROM note_group_grant fg WHERE fg.note_id = n.id AND fg.group_name = ?)
			OR n.folder_id IN (WITH RECURSIVE gf(id) AS (SELECT folder_id FROM folder_group_grant WHERE group_name = ?
				UNION SELECT c.id FROM folder c JOIN gf ON c.parent_id = gf.id WHERE c.deleted_at IS NULL) SELECT id FROM gf))`
		args = append(args, f.Group, f.Group)
	}
	switch f.Folder {
	case "":
	case FolderRoot:
		where += " AND n.folder_id IS NULL"
	default:
		where += " AND n.folder_id = ?"
		args = append(args, f.Folder)
	}
	if f.IDs != nil {
		if len(f.IDs) == 0 {
			return []NoteSummary{}, nil
		}
		where += " AND n.id IN (" + strings.TrimSuffix(strings.Repeat("?, ", len(f.IDs)), ", ") + ")"
		for _, id := range f.IDs {
			args = append(args, id)
		}
		var rank strings.Builder
		for i, id := range f.IDs {
			fmt.Fprintf(&rank, " WHEN ? THEN %d", i)
			args = append(args, id)
		}
		order = "CASE n.id" + rank.String() + " END"
	}
	args = append(args, f.Limit, max(f.Offset, 0))
	folderName := "COALESCE(fo.name, '')"
	if !f.Viewer.Local {
		vf, fargs := s.visibleFolders(f.Viewer)
		folderName = "CASE WHEN fo.id IN (" + vf + ") THEN fo.name ELSE '' END"
		args = append(fargs, args...)
	}
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT n.id, a.name, n.title, n.description, COALESCE(u.display_name, ''), COALESCE(n.owner_id, ''), n.updated_at,
		COALESCE(v.visited_at, ''), COALESCE(v.pinned, 0), n.view_count, n.slides, COALESCE(n.folder_id, ''), `+folderName+`
		FROM note n JOIN note_alias a ON a.note_id = n.id AND a.is_primary = 1
		LEFT JOIN app_user u ON u.id = n.owner_id LEFT JOIN folder fo ON fo.id = n.folder_id `+join+`
		WHERE `+where+` ORDER BY `+order+` LIMIT ? OFFSET ?`), args...)
	if err != nil {
		return nil, err
	}
	out := []NoteSummary{}
	for rows.Next() {
		var n NoteSummary
		var pinned, slides int
		if err := rows.Scan(&n.ID, &n.PrimaryAlias, &n.Title, &n.Description, &n.OwnerName, &n.OwnerID, &n.UpdatedAt, &n.VisitedAt, &pinned, &n.ViewCount, &slides, &n.FolderID, &n.FolderName); err != nil {
			rows.Close()
			return nil, err
		}
		n.Pinned = pinned == 1
		n.Slides = slides == 1
		out = append(out, n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if out[i].Tags, err = s.noteTags(ctx, out[i].ID); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *Store) RecordVisit(ctx context.Context, userID, noteID string) error {
	_, err := s.db.ExecContext(ctx, s.q(`INSERT INTO note_visit (user_id, note_id, visited_at) VALUES (?, ?, ?)
		ON CONFLICT (user_id, note_id) DO UPDATE SET visited_at = excluded.visited_at`), userID, noteID, Now())
	return err
}

func (s *Store) SetPinned(ctx context.Context, userID, noteID string, pinned bool) error {
	_, err := s.db.ExecContext(ctx, s.q(`INSERT INTO note_visit (user_id, note_id, visited_at, pinned) VALUES (?, ?, ?, ?)
		ON CONFLICT (user_id, note_id) DO UPDATE SET pinned = excluded.pinned`), userID, noteID, Now(), boolInt(pinned))
	return err
}

func (s *Store) ForgetVisit(ctx context.Context, userID, noteID string) error {
	_, err := s.db.ExecContext(ctx, s.q(`DELETE FROM note_visit WHERE user_id = ? AND note_id = ?`), userID, noteID)
	return err
}

type TagCount struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

func (s *Store) TagCounts(ctx context.Context, v Viewer) ([]TagCount, error) {
	where, args := s.visibleWhere(v)
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT t.tag, COUNT(*) FROM note_tag t JOIN note n ON n.id = t.note_id
		WHERE n.deleted_at IS NULL AND `+where+` GROUP BY t.tag ORDER BY COUNT(*) DESC, t.tag`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TagCount{}
	for rows.Next() {
		var tc TagCount
		if err := rows.Scan(&tc.Tag, &tc.Count); err != nil {
			return nil, err
		}
		out = append(out, tc)
	}
	return out, rows.Err()
}

// VisitCount is how many people opened the note, for HedgeDoc's view count.
func (s *Store) VisitCount(ctx context.Context, noteID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM note_visit WHERE note_id = ?`), noteID).Scan(&n)
	return n, err
}

// placeholders returns n comma-separated ? markers.
func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?, ", n), ", ")
}
