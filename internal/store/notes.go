package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"errors"
	"regexp"
	"slices"
	"strings"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/secrets"
)

type AgentPolicy string

const (
	AgentNone    AgentPolicy = "none"
	AgentRead    AgentPolicy = "read"
	AgentSuggest AgentPolicy = "suggest"
	AgentEdit    AgentPolicy = "edit"
)

func (p AgentPolicy) Valid() bool {
	return p == AgentNone || p == AgentRead || p == AgentSuggest || p == AgentEdit
}

type Note struct {
	ID           string      `json:"id"`
	PrimaryAlias string      `json:"alias"`
	OwnerID      string      `json:"owner_id,omitempty"`
	Title        string      `json:"title"`
	Description  string      `json:"description"`
	Content      string      `json:"-"`
	YState       []byte      `json:"-"`
	Tags         []string    `json:"tags"`
	AgentPolicy  AgentPolicy `json:"agent_policy"`
	CreatedAt    string      `json:"created_at"`
	UpdatedAt    string      `json:"updated_at"`
	ViewCount    int64       `json:"view_count"`
	Slides       bool        `json:"slides"`
	DeletedAt    string      `json:"deleted_at,omitempty"`
	DeletedBy    string      `json:"deleted_by,omitempty"`
	FolderID     string      `json:"folder_id,omitempty"`
}

type NewNote struct {
	OwnerID string
	Alias   string
	Content string
	// Groups and Users (by user ID) are the initial grants.
	Groups map[string]permission.Level
	Users  map[string]permission.Level
	// ExtraAliases are secondary addresses, for example an imported note's other IDs.
	ExtraAliases []string
	// CreatedAt and UpdatedAt keep an imported note's dates. Empty means now.
	CreatedAt   string
	UpdatedAt   string
	AgentPolicy AgentPolicy
	FolderID    string
	Event       *Event
}

// reservedAliases collide with UI routes and API prefixes.
var reservedAliases = []string{
	"new", "n", "s", "p", "f", "api", "auth", "ws", "mcp", "oauth", "assets", "fonts", "uploads",
	"healthz", "login", "logout", "favicon.svg", ".well-known", "index.html", "settings",
	"trash", "audit", "features", "v",
}

// aliasPattern accepts HedgeDoc 1 note IDs, which are base64url and may start with - or _.
var aliasPattern = regexp.MustCompile(`^[a-z0-9_-]{1,64}$`)

// idPattern is the shape of note.id. An alias with this shape could hide another document's id address.
var idPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

var crockford = base32.NewEncoding("0123456789ABCDEFGHJKMNPQRSTVWXYZ").WithPadding(base32.NoPadding)

// GenerateRandomAlias returns 128 random bits as lowercase Crockford base32 (26 chars), as HedgeDoc does.
func GenerateRandomAlias() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return strings.ToLower(crockford.EncodeToString(b[:]))
}

func NormalizeAlias(alias string) (string, error) {
	a := strings.ToLower(strings.TrimSpace(alias))
	if !aliasPattern.MatchString(a) || strings.Trim(a, "-_") == "" || slices.Contains(reservedAliases, a) || idPattern.MatchString(a) {
		return "", ErrAliasForbidden
	}
	return a, nil
}

func (s *Store) CreateNote(ctx context.Context, nn NewNote) (*Note, error) {
	alias := nn.Alias
	if alias == "" {
		alias = GenerateRandomAlias()
	}
	alias, err := NormalizeAlias(alias)
	if err != nil {
		return nil, err
	}
	extra := make([]string, 0, len(nn.ExtraAliases))
	for _, a := range nn.ExtraAliases {
		na, err := NormalizeAlias(a)
		if err != nil {
			return nil, err
		}
		if na != alias && !slices.Contains(extra, na) {
			extra = append(extra, na)
		}
	}
	created, updated := Now(), ""
	if nn.CreatedAt != "" {
		created = nn.CreatedAt
	}
	updated = created
	if nn.UpdatedAt != "" {
		updated = nn.UpdatedAt
	}
	n := &Note{
		ID: secrets.NewID(), PrimaryAlias: alias, OwnerID: nn.OwnerID, Content: nn.Content, FolderID: nn.FolderID,
		AgentPolicy: AgentSuggest, CreatedAt: created, UpdatedAt: updated, Tags: []string{},
	}
	if nn.AgentPolicy != "" {
		n.AgentPolicy = nn.AgentPolicy
	}
	err = s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO note (id, owner_id, folder_id, content, agent_policy, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`), n.ID, nullStr(n.OwnerID), nullStr(n.FolderID), n.Content, string(n.AgentPolicy), created, updated); err != nil {
			return err
		}
		if err := s.insertAlias(ctx, tx, n.ID, alias, true); err != nil {
			return err
		}
		for _, a := range extra {
			if err := s.insertAlias(ctx, tx, n.ID, a, false); err != nil {
				return err
			}
		}
		for uid, l := range nn.Users {
			if l == permission.Deny {
				continue
			}
			if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO note_user_grant (note_id, user_id, level) VALUES (?, ?, ?)`),
				n.ID, uid, l.String()); err != nil {
				return err
			}
		}
		for g, l := range nn.Groups {
			if l == permission.Deny {
				continue
			}
			if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO note_group_grant (note_id, group_name, level) VALUES (?, ?, ?)`),
				n.ID, g, l.String()); err != nil {
				return err
			}
		}
		if nn.Event != nil {
			nn.Event.NoteID = n.ID
		}
		return s.insertEvent(ctx, tx, nn.Event)
	})
	if err != nil {
		return nil, err
	}
	return n, nil
}

func (s *Store) insertAlias(ctx context.Context, tx execer, noteID, alias string, primary bool) error {
	_, err := tx.ExecContext(ctx, s.q(`INSERT INTO note_alias (name, note_id, is_primary, created_at) VALUES (?, ?, ?, ?)`),
		alias, noteID, boolInt(primary), Now())
	if isUniqueViolation(err) {
		return ErrAliasTaken
	}
	return err
}

const noteColumns = `n.id, a.name, COALESCE(n.owner_id, ''), n.title, n.description, n.content, n.ystate, n.agent_policy, n.created_at, n.updated_at,
	COALESCE(n.deleted_at, ''), n.deleted_by, n.view_count, n.slides, COALESCE(n.folder_id, '')`

func (s *Store) scanNote(ctx context.Context, row *sql.Row) (*Note, error) {
	var n Note
	var policy string
	var slides int
	if err := row.Scan(&n.ID, &n.PrimaryAlias, &n.OwnerID, &n.Title, &n.Description, &n.Content, &n.YState,
		&policy, &n.CreatedAt, &n.UpdatedAt, &n.DeletedAt, &n.DeletedBy, &n.ViewCount, &slides, &n.FolderID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	n.AgentPolicy = AgentPolicy(policy)
	n.Slides = slides == 1
	tags, err := s.noteTags(ctx, n.ID)
	if err != nil {
		return nil, err
	}
	n.Tags = tags
	return &n, nil
}

func (s *Store) NoteByID(ctx context.Context, id string) (*Note, error) {
	return s.scanNote(ctx, s.db.QueryRowContext(ctx, s.q(`SELECT `+noteColumns+`
		FROM note n JOIN note_alias a ON a.note_id = n.id AND a.is_primary = 1 WHERE n.id = ?`), id))
}

// NoteByAlias resolves an alias, then falls back to the note id, which is a permanent address.
func (s *Store) NoteByAlias(ctx context.Context, alias string) (*Note, error) {
	n, err := s.noteByAliasName(ctx, alias)
	if errors.Is(err, ErrNotFound) && idPattern.MatchString(strings.ToLower(alias)) {
		return s.NoteByID(ctx, strings.ToLower(alias))
	}
	return n, err
}

func (s *Store) noteByAliasName(ctx context.Context, alias string) (*Note, error) {
	return s.scanNote(ctx, s.db.QueryRowContext(ctx, s.q(`SELECT `+noteColumns+`
		FROM note_alias x JOIN note n ON n.id = x.note_id
		JOIN note_alias a ON a.note_id = n.id AND a.is_primary = 1 WHERE x.name = ?`), strings.ToLower(alias)))
}

func (s *Store) noteTags(ctx context.Context, noteID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT tag FROM note_tag WHERE note_id = ? ORDER BY tag`), noteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

type Alias struct {
	Name    string `json:"name"`
	Primary bool   `json:"primary"`
}

func (s *Store) Aliases(ctx context.Context, noteID string) ([]Alias, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT name, is_primary FROM note_alias WHERE note_id = ?
		ORDER BY is_primary DESC, created_at, name`), noteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Alias
	for rows.Next() {
		var a Alias
		var p int
		if err := rows.Scan(&a.Name, &p); err != nil {
			return nil, err
		}
		a.Primary = p == 1
		out = append(out, a)
	}
	return out, rows.Err()
}

// AddAlias adds a secondary alias. The first alias of a note is always primary.
func (s *Store) AddAlias(ctx context.Context, noteID, alias string) error {
	alias, err := NormalizeAlias(alias)
	if err != nil {
		return err
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		var n int
		if err := tx.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM note_alias WHERE note_id = ?`), noteID).Scan(&n); err != nil {
			return err
		}
		return s.insertAlias(ctx, tx, noteID, alias, n == 0)
	})
}

func (s *Store) MakeAliasPrimary(ctx context.Context, noteID, alias string) error {
	alias = strings.ToLower(alias)
	return s.tx(ctx, func(tx *sql.Tx) error {
		var n int
		if err := tx.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM note_alias WHERE note_id = ? AND name = ?`),
			noteID, alias).Scan(&n); err != nil {
			return err
		}
		if n != 1 {
			return ErrNotFound
		}
		return s.promoteAlias(ctx, tx, noteID, alias)
	})
}

// promoteAlias makes an existing alias primary and deletes the custom slug it replaces.
func (s *Store) promoteAlias(ctx context.Context, tx *sql.Tx, noteID, alias string) error {
	if _, err := tx.ExecContext(ctx, s.q(`UPDATE note_alias SET is_primary = 0 WHERE note_id = ?`), noteID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, s.q(`DELETE FROM note_alias WHERE note_id = ? AND custom = 1 AND name <> ?`), noteID, alias); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, s.q(`UPDATE note_alias SET is_primary = 1 WHERE note_id = ? AND name = ?`), noteID, alias)
	return err
}

// SetSlug makes slug the primary alias of the note and releases the previous custom slug.
// Other aliases stay. ev, if set, gets the new and previous alias and is written only on a change.
func (s *Store) SetSlug(ctx context.Context, noteID, slug string, ev *Event) (string, error) {
	slug, err := NormalizeAlias(slug)
	if err != nil {
		return "", err
	}
	err = s.tx(ctx, func(tx *sql.Tx) error {
		var previous string
		if err := tx.QueryRowContext(ctx, s.q(`SELECT name FROM note_alias WHERE note_id = ? AND is_primary = 1`),
			noteID).Scan(&previous); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		if previous == slug {
			return nil
		}
		var owner string
		err := tx.QueryRowContext(ctx, s.q(`SELECT note_id FROM note_alias WHERE name = ?`), slug).Scan(&owner)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			if err := s.promoteAlias(ctx, tx, noteID, ""); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO note_alias (name, note_id, is_primary, created_at, custom)
				VALUES (?, ?, 1, ?, 1)`), slug, noteID, Now()); err != nil {
				if isUniqueViolation(err) {
					return ErrAliasTaken
				}
				return err
			}
		case err != nil:
			return err
		case owner != noteID:
			return ErrAliasTaken
		default:
			if err := s.promoteAlias(ctx, tx, noteID, slug); err != nil {
				return err
			}
		}
		if ev == nil {
			return nil
		}
		ev.NoteID = noteID
		if ev.Data == nil {
			ev.Data = map[string]any{}
		}
		ev.Data["alias"], ev.Data["previous"] = slug, previous
		return s.insertEvent(ctx, tx, ev)
	})
	if err != nil {
		return "", err
	}
	return slug, nil
}

func (s *Store) RemoveAlias(ctx context.Context, alias string) error {
	alias = strings.ToLower(alias)
	return s.tx(ctx, func(tx *sql.Tx) error {
		var primary int
		err := tx.QueryRowContext(ctx, s.q(`SELECT is_primary FROM note_alias WHERE name = ?`), alias).Scan(&primary)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if primary == 1 {
			return ErrPrimaryAliasDeletion
		}
		_, err = tx.ExecContext(ctx, s.q(`DELETE FROM note_alias WHERE name = ?`), alias)
		return err
	})
}

func (s *Store) DeleteNote(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, s.q(`DELETE FROM note WHERE id = ?`), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// NoteState is what the collaboration room persists after edits.
type NoteState struct {
	YState      []byte
	Content     string
	Title       string
	Description string
	Tags        []string
	Slides      bool
}

func (s *Store) SaveNoteState(ctx context.Context, id string, st NoteState) error {
	return s.saveNoteState(ctx, id, st, -1, 0)
}

// saveNoteState with fromUpto >= 0 saves only if ystate_upto is still fromUpto, and moves it to toUpto.
func (s *Store) saveNoteState(ctx context.Context, id string, st NoteState, fromUpto, toUpto int64) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		// updated_at follows text changes only, so opening a note, or an imported date, does not move it.
		q := `UPDATE note SET updated_at = CASE WHEN content <> ? THEN ? ELSE updated_at END,
			ystate = ?, content = ?, title = ?, description = ?, search_tags = ?, slides = ?`
		args := []any{st.Content, Now(), st.YState, st.Content, st.Title, st.Description, strings.Join(st.Tags, " "), boolInt(st.Slides)}
		if fromUpto >= 0 {
			q += `, ystate_upto = ? WHERE id = ? AND ystate_upto = ?`
			args = append(args, toUpto, id, fromUpto)
		} else {
			q += ` WHERE id = ?`
			args = append(args, id)
		}
		res, err := tx.ExecContext(ctx, s.q(q), args...)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			if fromUpto >= 0 {
				return ErrConflict
			}
			return ErrNotFound
		}
		if _, err := tx.ExecContext(ctx, s.q(`DELETE FROM note_tag WHERE note_id = ?`), id); err != nil {
			return err
		}
		if err := s.indexNote(ctx, tx, id, st); err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, t := range st.Tags {
			if t == "" || seen[t] {
				continue
			}
			seen[t] = true
			if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO note_tag (note_id, tag) VALUES (?, ?)`), id, t); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) SetAgentPolicy(ctx context.Context, id string, p AgentPolicy) error {
	_, err := s.db.ExecContext(ctx, s.q(`UPDATE note SET agent_policy = ? WHERE id = ?`), string(p), id)
	return err
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// SetNoteTimes keeps an imported note's dates after its content was written.
func (s *Store) SetNoteTimes(ctx context.Context, id, created, updated string) error {
	_, err := s.db.ExecContext(ctx, s.q(`UPDATE note SET created_at = ?, updated_at = ? WHERE id = ?`), created, updated, id)
	return err
}

// CountView adds one to a note's view counter, as HedgeDoc does on each page load.
func (s *Store) CountView(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.q(`UPDATE note SET view_count = view_count + 1 WHERE id = ?`), id)
	return err
}
