package store

import "strings"

// Schema is portable: TEXT ids and timestamps, INTEGER 0/1 booleans, BLOB becomes BYTEA on Postgres.
// No semicolons in comments: Init splits on them.
const Schema = `
CREATE TABLE IF NOT EXISTS app_user (
    id TEXT PRIMARY KEY,
    sub TEXT UNIQUE,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_login_at TEXT
);
-- Groups come from the OIDC groups claim and are replaced on every login.
CREATE TABLE IF NOT EXISTS user_group (
    user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    group_name TEXT NOT NULL,
    PRIMARY KEY (user_id, group_name)
);
-- The cookie holds an opaque token. Only its keyed hash is stored. Logout deletes the row.
CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
CREATE TABLE IF NOT EXISTS note (
    id TEXT PRIMARY KEY,
    owner_id TEXT REFERENCES app_user(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    ystate BLOB,
    -- ystate_upto is the last note_update id the snapshot includes.
    ystate_upto BIGINT NOT NULL DEFAULT 0,
    agent_policy TEXT NOT NULL DEFAULT 'suggest',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_updated ON note(updated_at);
CREATE INDEX IF NOT EXISTS idx_note_owner ON note(owner_id);
-- Aliases are stored lowercase. At most one primary per note.
CREATE TABLE IF NOT EXISTS note_alias (
    name TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_alias_note ON note_alias(note_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_note_alias_primary ON note_alias(note_id) WHERE is_primary = 1;
CREATE TABLE IF NOT EXISTS note_user_grant (
    note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    level TEXT NOT NULL,
    PRIMARY KEY (note_id, user_id)
);
-- group_name is an OIDC group or a special group: _everyone, _signed_in.
CREATE TABLE IF NOT EXISTS note_group_grant (
    note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
    group_name TEXT NOT NULL,
    level TEXT NOT NULL,
    PRIMARY KEY (note_id, group_name)
);
-- A share link is a revocable read-only capability. The token is kept so the owner can copy the link again.
CREATE TABLE IF NOT EXISTS share_link (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_link_note ON share_link(note_id);
-- Non-text events for the timeline. note_id has no foreign key so the delete event survives the note.
CREATE TABLE IF NOT EXISTS audit_event (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    actor_id TEXT,
    actor_name TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'human',
    client TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_event_note ON audit_event(note_id, created_at);
-- Append-only Yjs update log with author and source. Merged runs of one client per row.
CREATE TABLE IF NOT EXISTS note_update (
    id SERIALPK,
    note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    client_id BIGINT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_update_note ON note_update(note_id, id);
-- Maps each Yjs client ID in a note to a person and source, for attribution.
CREATE TABLE IF NOT EXISTS note_client (
    note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
    client_id BIGINT NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (note_id, client_id)
);
CREATE TABLE IF NOT EXISTS note_tag (
    note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_note_tag_tag ON note_tag(tag);
`

func schemaFor(dialect string) string {
	if dialect == "postgres" {
		s := strings.ReplaceAll(Schema, " BLOB", " BYTEA")
		return strings.ReplaceAll(s, "SERIALPK", "BIGSERIAL PRIMARY KEY") + postgresExtra
	}
	return strings.ReplaceAll(Schema, "SERIALPK", "INTEGER PRIMARY KEY AUTOINCREMENT") + sqliteExtra
}

const sqliteExtra = ``

const postgresExtra = ``
