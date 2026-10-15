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
    -- history_state is the Yjs state after the last update turned into a revision.
    history_state BLOB,
    history_upto BIGINT NOT NULL DEFAULT 0,
    agent_policy TEXT NOT NULL DEFAULT 'suggest',
    search_tags TEXT NOT NULL DEFAULT '',
    -- A note in the trash has deleted_at set. It is purged after the retention period.
    deleted_at TEXT,
    deleted_by TEXT NOT NULL DEFAULT '',
    view_count BIGINT NOT NULL DEFAULT 0,
    -- slides is 1 when the front matter says type: slide.
    slides INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS note_visit (
    user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
    visited_at TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, note_id)
);
CREATE INDEX IF NOT EXISTS idx_note_visit_user ON note_visit(user_id, visited_at);
-- A revision is one edit session: the text after it, a unified diff, and who did it.
CREATE TABLE IF NOT EXISTS note_revision (
    id SERIALPK,
    note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    patch TEXT NOT NULL,
    authors TEXT NOT NULL,
    sources TEXT NOT NULL,
    added INTEGER NOT NULL,
    removed INTEGER NOT NULL,
    from_update BIGINT NOT NULL,
    to_update BIGINT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_revision_note ON note_revision(note_id, id);
-- Anchors are Yjs relative positions so threads follow the text while others edit.
CREATE TABLE IF NOT EXISTS comment_thread (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
    anchor_start BLOB NOT NULL,
    anchor_end BLOB NOT NULL,
    quote TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    resolved_by TEXT NOT NULL DEFAULT '',
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comment_thread_note ON comment_thread(note_id);
CREATE TABLE IF NOT EXISTS comment (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES comment_thread(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL DEFAULT '',
    author_name TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'human',
    client TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comment_thread ON comment(thread_id, created_at);
-- A proposed replacement of the anchored text. The note text does not change until accepted.
CREATE TABLE IF NOT EXISTS suggestion (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
    anchor_start BLOB NOT NULL,
    anchor_end BLOB NOT NULL,
    original TEXT NOT NULL,
    proposed TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    author_id TEXT NOT NULL DEFAULT '',
    author_name TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'human',
    client TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    decided_by TEXT NOT NULL DEFAULT '',
    decided_at TEXT,
    ai_prompt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_suggestion_note ON suggestion(note_id, status);
-- Bearer tokens: personal access tokens, and OAuth access and refresh tokens for MCP clients.
CREATE TABLE IF NOT EXISTS api_token (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    client_id TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '',
    family TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    rotated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_api_token_user ON api_token(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_api_token_family ON api_token(family);
CREATE TABLE IF NOT EXISTS oauth_client (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    redirect_uris TEXT NOT NULL,
    auth_method TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_code (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_client(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    resource TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
    stored_name TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size BIGINT NOT NULL,
    uploaded_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_note ON media(note_id);
CREATE TABLE IF NOT EXISTS upload_ticket (
    token_hash TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    client TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL
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
	// The trigger body needs a semicolon, which Init would split on. It is added back in Init.
	return strings.ReplaceAll(Schema, "SERIALPK", "INTEGER PRIMARY KEY AUTOINCREMENT") + strings.Replace(sqliteExtra, "%s", triggerSemicolon, 1)
}

const sqliteExtra = `;
CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(note_id UNINDEXED, title, tags, content, tokenize = 'unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS note_fts_delete AFTER DELETE ON note BEGIN DELETE FROM note_fts WHERE note_id = old.id%s END
`

const postgresExtra = `;
CREATE INDEX IF NOT EXISTS idx_note_search ON note USING GIN (to_tsvector('simple', title || ' ' || search_tags || ' ' || content))
`

// triggerSemicolon stands for the semicolon inside a trigger body until Init splits the DDL.
const triggerSemicolon = "\x00"
