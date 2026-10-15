# MCP

greydoc serves the Model Context Protocol at `/mcp` (Streamable HTTP). An agent connected there acts for one person, with that person's access, and every change it makes is marked as made by an agent.

## Connect

Claude Code:

```bash
claude mcp add --transport http greydoc https://notes.example.com/mcp
```

opencode: add the server to `opencode.json` (in the project) or `~/.config/opencode/opencode.json` (for all projects):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "greydoc": {
      "type": "remote",
      "url": "https://notes.example.com/mcp",
      "enabled": true
    }
  }
}
```

opencode asks you to sign in the first time it uses the server. To sign in before that, run `opencode mcp auth greydoc`. `opencode mcp list` shows the status, and `opencode mcp logout greydoc` removes the stored tokens.

To use a personal access token in opencode instead of OAuth, turn OAuth off and send the token as a header:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "greydoc": {
      "type": "remote",
      "url": "https://notes.example.com/mcp",
      "oauth": false,
      "headers": { "Authorization": "Bearer {env:GREYDOC_TOKEN}" }
    }
  }
}
```

Other clients: use the URL `https://notes.example.com/mcp` with HTTP transport.

- With OIDC, the client finds the OAuth server through `/.well-known/oauth-protected-resource/mcp`, registers itself, and opens a browser window. You sign in and press "Allow".
- A client without OAuth can send a personal access token: create one in Settings, then send `Authorization: Bearer gd_pat_…`. The CLI also creates one: `greydoc token create --user alice`.
- In local mode no sign-in is needed.

Settings lists connected clients and tokens. "Disconnect" and "Revoke" end access at once.

## Agent policy

Each note has an agent policy. The owner sets it in the Share dialog.

| Policy | Agents may |
|---|---|
| `none` | Nothing. The note is invisible to agents. |
| `read` | Read, list comments, read history. |
| `suggest` (default) | Also comment and suggest. `edit_note` creates a suggestion instead of editing. |
| `edit` | Also edit the text directly. |

Agents cannot delete a note for good. They can move it to the trash, where a person can restore it.

The policy only lowers access. An agent never gets more than the person it acts for. A token with only the `notes:read` scope is limited to reading.

## Tools

| Tool | What it does |
|---|---|
| `list_notes` | Notes you can read, newest first. Filter by scope (`recent`, `mine`, `shared`, `all`) or tag. |
| `search_notes` | Full-text search on title, tags and text. |
| `read_note` | The Markdown text, title, tags, your access level, the agent policy, and counts of open comments and suggestions. |
| `create_note` | Create a note owned by you. |
| `list_comments` | Comment threads with the quoted text. `detached` means the quoted text was deleted. |
| `add_comment` | Comment on a quoted part of the note. |
| `reply_comment` | Reply in a thread. |
| `resolve_comment` | Resolve or reopen a thread. |
| `suggest_edit` | Propose replacing `old_text` with `new_text`. |
| `edit_note` | Replace `old_text` with `new_text`, or the whole note with `content`. Under `suggest` it creates a suggestion. |
| `trash_note` | Move a note to the trash. Only for a note the user owns, with agent policy `edit`. |
| `restore_note` | Bring a note back from the trash. Same rules as `trash_note`. |
| `get_history` | Edit sessions with authors and sources, and comment, suggestion and permission events. Pass `revision_id` for the full text and diff. |

`old_text` and `quote` must match the note exactly. If the text appears more than once, quote more context or pass `occurrence` (1 is the first match).

A note can be given as its alias, as `/n/<alias>`, or as its full URL. A view-only link works too and gives read access.

## Import from HedgeDoc

`create_note` (and `POST /api/notes`, same fields) keeps what an imported note had:

| Field | Meaning |
|---|---|
| `alias` | The note's address. Use the HedgeDoc note ID, for example `s3BkeGgqTH-gU5UXqMZdag`, so old links keep working. Letters, digits, `-` and `_`. Lookups ignore case. |
| `extra_aliases` | More addresses. Put the HedgeDoc 1 short ID here, so `/s/<shortid>` links work. |
| `created_at` | Original creation date, RFC 3339. It is also the last update, unless `updated_at` is given. The date stays until someone edits the text. |
| `updated_at` | Original last update. |
| `permissions` | `hedgedoc_mode`, and or explicit `everyone`, `signed_in`, `users` (username to level) and `groups` (group to level). Explicit values win over the mode. Unset values keep the server defaults. |
| `agent_policy` | `none`, `read`, `suggest` or `edit`. |

Levels are `deny`, `read`, `comment` and `write`. HedgeDoc 2 words work too: `view` is read and `edit` is write. The note belongs to the user the agent acts for.

HedgeDoc 1 modes:

| Mode | Anyone with the address | Signed-in users |
|---|---|---|
| `freely` | write | write |
| `editable` | read | write |
| `limited` | none | write |
| `locked` | read | read |
| `protected` | none | read |
| `private` | none | none |

The owner always edits. "Anyone with the address" is capped by `GREYDOC_GUEST_MAX` (default read), so `freely` gives guests write only if the server allows it. For HedgeDoc 2, a grant with `canEdit: true` is `write` and with `false` is `read`. `_EVERYONE` maps to `everyone` and `_LOGGED_IN` to `signed_in`.

Links: HedgeDoc 2 paths are the same (`/n/<id>`, `/s/<id>`, `/p/<id>`). HedgeDoc 1 paths also work: `/<id>`, `/<id>/publish`, `/<id>/slide`, `/<id>/download`, and `/s/<shortid>` when the short ID is in `extra_aliases`. Users and groups named in `permissions` must have signed in to greydoc once.

## Audit

Every tool call is recorded in the audit log as `mcp.call`: the tool, the note, the arguments, whether it worked, the error, and how long it took. Long text arguments are cut to their first words and their length. Each new client session is recorded as `mcp.session`, with the client's name and version.

On the audit page, the filter "Agent (MCP) calls" shows these events and a usage summary for the last 7, 30 or 90 days: calls and errors by tool, by client and by person. The same summary is at `GET /api/audit/mcp?days=30`. Admins see all calls. Others see calls on notes they can read and their own calls.

Note timelines leave out these calls, so they only show what changed the note.

## What people see

Agent suggestions appear in the editor as tracked changes with an "agent" tag. Accepted agent text and direct agent edits show a dotted underline in the authors view. The timeline marks agent revisions and events with "Agent" and the client name, for example "via Claude".
