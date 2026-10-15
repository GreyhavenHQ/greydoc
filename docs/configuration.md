# Configuration

greydoc reads environment variables. All have defaults. The server needs none of them to start in local mode.

## Server

| Variable | Default | Meaning |
|---|---|---|
| `GREYDOC_HOST` | `127.0.0.1` | Bind address. The Docker image uses `0.0.0.0`. |
| `GREYDOC_PORT` | `3000` | Bind port. |
| `GREYDOC_BASE_URL` | derived from the request in local mode | Public origin, for example `https://notes.example.com`. Required with OIDC. OAuth metadata, login redirects and share links use it. Request headers such as `X-Forwarded-Host` are never trusted. |
| `GREYDOC_ALLOW_NONLOCAL` | `false` | Allow local mode on an address other than loopback. Local mode has no login, so anyone who can reach the server can edit every note. |
| `GREYDOC_DATABASE_URL` | `greydoc.db` | SQLite file path, or a `postgres://` URL. |
| `GREYDOC_DATA_DIR` | `data` | Uploads go to `uploads/`. |
| `GREYDOC_SECRET` | empty | Secret for cookies and token hashes. If empty, greydoc creates `GREYDOC_SECRET_FILE`. |
| `GREYDOC_SECRET_FILE` | `.greydoc/secret` | Where the generated secret is kept. Back it up with the database. The Docker image puts it in `/data`. |
| `GREYDOC_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

Keep `/data` on a persistent volume. It holds the uploaded files and the secret. If `/data` is lost at a deploy, the uploads are gone, and greydoc creates a new secret: every browser session and MCP token stops working, and everyone must sign in again. The log then says `created a new secret`. To keep sessions across deploys whatever happens to `/data`, set `GREYDOC_SECRET` to a fixed random value, for example the output of `openssl rand -hex 32`.

Run one server per database in normal operation. Two servers can run at the same time during a rolling deploy. Each save merges the edits that the other server stored, so no edit is lost. Live editing state is in memory, so people connected to different servers do not see each other's typing until they reconnect.

`greydoc copy-db --from <database> --to <empty database>` copies everything from one database to another, for example from SQLite to Postgres. Stop the server first. The source is not changed.

## Sign-in (OIDC)

[Sign in with authentik](authentik.md) gives the steps for authentik.

When `GREYDOC_OIDC_ISSUER` is empty, greydoc runs in local mode: no login, full access for every request.

| Variable | Default | Meaning |
|---|---|---|
| `GREYDOC_OIDC_ISSUER` | empty | Issuer URL. greydoc reads `/.well-known/openid-configuration` from it. |
| `GREYDOC_OIDC_CLIENT_ID` | empty | Client ID registered at the provider. |
| `GREYDOC_OIDC_CLIENT_SECRET` | empty | Client secret. The login also uses PKCE (S256). |
| `GREYDOC_OIDC_REDIRECT_URL` | `<base>/auth/callback` | Register this URL at the provider. |
| `GREYDOC_OIDC_SCOPES` | `openid profile email` | Requested scopes. Add the scope that returns groups if your provider needs one. |
| `GREYDOC_OIDC_GROUPS_CLAIM` | `groups` | Userinfo claim with the user's groups. Groups can receive note access. |
| `GREYDOC_SESSION_TTL` | `168h` | Browser session lifetime. A session in use is extended, so it ends after this long without use. |
| `GREYDOC_REFRESH_REUSE_GRACE` | `24h` | How long an MCP client may still use a refresh token after it was rotated. Sessions of one client that share stored tokens need it. A reuse after this time revokes all of the client's tokens. `0` turns it off. |

## Access defaults

Levels are `deny`, `read`, `comment` and `write`. The owner always has full access: delete, permissions, addresses and agent policy.

| Variable | Default | Meaning |
|---|---|---|
| `GREYDOC_DEFAULT_EVERYONE` | `deny` | What anyone with the address gets on a new note, without sign-in. |
| `GREYDOC_DEFAULT_SIGNED_IN` | `write` | What signed-in users get on a new note. |
| `GREYDOC_GUEST_MAX` | `read` | The most a person without sign-in can get on any note. |

View-only links work for guests whatever these values are.

## Administration

| Variable | Default | Meaning |
|---|---|---|
| `GREYDOC_ADMIN_GROUP` | empty | OIDC group whose members see the whole audit log and every note in the trash, and can restore or delete any trashed note. In local mode everyone has these rights. |
| `GREYDOC_TRASH_RETENTION` | `720h` | How long a note stays in the trash before it is deleted for good. The deletion is recorded in the audit log. |

## Limits

| Variable | Default | Meaning |
|---|---|---|
| `GREYDOC_MAX_NOTE_LENGTH` | `1000000` | Characters per note, for notes created through the API. |
| `GREYDOC_MAX_UPLOAD_BYTES` | `10485760` | Largest upload. Images and PDF files only. |
| `GREYDOC_ROOM_SAVE_INTERVAL` | `5s` | How often an open note is saved while people type. |
| `GREYDOC_ROOM_IDLE_GRACE` | `10s` | How long a note stays loaded after the last person leaves. |

## AI

The AI actions call an OpenAI-compatible chat endpoint. When `LLM_API_BASEURL` is empty, the AI menu does not show.

| Variable | Meaning |
|---|---|
| `LLM_API_BASEURL` | For example `https://llm.example.com`. greydoc adds `/v1` if it is missing. |
| `LLM_API_KEY` | Sent as a bearer token. |
| `LLM_MODEL` | Model name. |
| `GREYDOC_AI_RATE_PER_MINUTE` | AI requests allowed per user per minute. Default `20`. `0` removes the limit. |
| `GREYDOC_AI_ACTIONS` | The presets of the AI menu: a JSON list, or the path of a JSON file. Empty means the four built-in presets. |

Each preset has an `id` (lowercase letters, digits and dashes), a `label`, the `instruction` for the model, and an `output`:

- `replace` (default): the answer replaces the selection.
- `below`: the answer goes below the selection.
- `diagram`: the answer is a Mermaid diagram below the selection.

```json
[
  {"id": "fix", "label": "Fix spelling and grammar", "instruction": "Fix spelling, grammar and punctuation in the selection. Change nothing else."},
  {"id": "summary", "label": "Add a summary below", "instruction": "Summarize the selection in two sentences.", "output": "below"},
  {"id": "flow", "label": "Make a diagram below", "instruction": "Draw the selection as a Mermaid flowchart.", "output": "diagram"}
]
```

The menu always has a free text box above the presets. The server does not start if the list is not valid.
