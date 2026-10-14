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
}

type NewNote struct {
	OwnerID string
	Alias   string
	Content string
	// Groups are the initial group grants, for example the configured defaults.
	Groups map[string]permission.Level
	Event  *Event
}

// reservedAliases collide with UI routes and API prefixes.
var reservedAliases = []string{
	"new", "n", "s", "p", "api", "auth", "ws", "mcp", "oauth", "assets", "fonts", "uploads",
	"healthz", "login", "logout", "favicon.svg", ".well-known", "index.html", "settings",
}

var aliasPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

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
	if !aliasPattern.MatchString(a) || slices.Contains(reservedAliases, a) {
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
	now := Now()
	n := &Note{
		ID: secrets.NewID(), PrimaryAlias: alias, OwnerID: nn.OwnerID, Content: nn.Content,
		AgentPolicy: AgentSuggest, CreatedAt: now, UpdatedAt: now, Tags: []string{},
	}
	err = s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO note (id, owner_id, content, agent_policy, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)`), n.ID, nullStr(n.OwnerID), n.Content, string(n.AgentPolicy), now, now); err != nil {
			return err
		}
		if err := s.insertAlias(ctx, tx, n.ID, alias, true); err != nil {
			return err
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

const noteColumns = `n.id, a.name, COALESCE(n.owner_id, ''), n.title, n.description, n.content, n.ystate, n.agent_policy, n.created_at, n.updated_at`

func (s *Store) scanNote(ctx context.Context, row *sql.Row) (*Note, error) {
	var n Note
	var policy string
	if err := row.Scan(&n.ID, &n.PrimaryAlias, &n.OwnerID, &n.Title, &n.Description, &n.Content, &n.YState,
		&policy, &n.CreatedAt, &n.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	n.AgentPolicy = AgentPolicy(policy)
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

func (s *Store) NoteByAlias(ctx context.Context, alias string) (*Note, error) {
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
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE note_alias SET is_primary = 0 WHERE note_id = ?`), noteID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, s.q(`UPDATE note_alias SET is_primary = 1 WHERE note_id = ? AND name = ?`), noteID, alias)
		return err
	})
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
}

func (s *Store) SaveNoteState(ctx context.Context, id string, st NoteState) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, s.q(`UPDATE note SET ystate = ?, content = ?, title = ?, description = ?, updated_at = ?
			WHERE id = ?`), st.YState, st.Content, st.Title, st.Description, Now(), id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		if _, err := tx.ExecContext(ctx, s.q(`DELETE FROM note_tag WHERE note_id = ?`), id); err != nil {
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
