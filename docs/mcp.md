# MCP

greydoc serves the Model Context Protocol at `/mcp` (Streamable HTTP). An agent connected there acts for one person, with that person's access, and every change it makes is marked as made by an agent.

## Connect

Claude Code:

```bash
claude mcp add --transport http greydoc https://notes.example.com/mcp
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
| `get_history` | Edit sessions with authors and sources, and comment, suggestion and permission events. Pass `revision_id` for the full text and diff. |

`old_text` and `quote` must match the note exactly. If the text appears more than once, quote more context or pass `occurrence` (1 is the first match).

A note can be given as its alias, as `/n/<alias>`, or as its full URL. A view-only link works too and gives read access.

## What people see

Agent suggestions appear in the editor as tracked changes with an "agent" tag. Accepted agent text and direct agent edits show a dotted underline in the authors view. The timeline marks agent revisions and events with "Agent" and the client name, for example "via Claude".
