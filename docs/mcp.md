# MCP

greydoc serves the Model Context Protocol at `/mcp` (Streamable HTTP). An agent connected there acts for one person, with that person's access, and every change it makes is marked as made by an agent.

## Connect

The settings page shows these steps with your server's URL. In local mode, skip the sign-in step.

### opencode

1. Add the server to `opencode.json`, in the project or in `~/.config/opencode/opencode.json` for all projects:

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

2. Sign in. Run `opencode mcp auth` and pick `greydoc` in the list. A browser window opens. Press "Allow".
3. Start opencode and ask about your documents.

Several opencode sessions can share one sign-in. If opencode reports that greydoc needs a sign-in, do step 2 again. `opencode mcp list` shows the status, and `opencode mcp logout greydoc` removes the stored tokens.

### Claude Code

1. Add the server:

   ```bash
   claude mcp add --transport http greydoc https://notes.example.com/mcp
   ```

2. Sign in. In Claude Code, run `/mcp`, pick `greydoc`, then "Authenticate". A browser window opens. Press "Allow".
3. Ask Claude about your documents.

### Personal access token in opencode

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

Each document has an agent policy. The owner sets it in the Share dialog.

| Policy | Agents may |
|---|---|
| `none` | Nothing. The document is invisible to agents. |
| `read` | Read, list comments, read history. |
| `suggest` (default) | Also comment and suggest. `edit_note` creates a suggestion instead of editing. |
| `edit` | Also edit the text directly. |

A document that a person creates starts at `suggest`. A document that an agent creates with `create_note` starts at `edit`, so the agent can keep working on its own draft in the same session. Pass `agent_policy` to `create_note` to choose another level.

Agents cannot delete a document for good. They can move it to the trash, where a person can restore it.

The policy only lowers access. An agent never gets more than the person it acts for. A token with only the `notes:read` scope is limited to reading.

## Tools

| Tool | What it does |
|---|---|
| `list_notes` | Documents you can read, last updated first. Filter by scope (`recent`, `mine`, `shared`, `all`) or tag. Pages with `limit` and `offset`. |
| `search_notes` | Full-text search on title, tags and text, best match first, with an excerpt. Same filters and pages as `list_notes`. |
| `read_note` | The Markdown text, title, tags, your access level, the agent policy, and counts of open comments and suggestions. |
| `create_note` | Create a document owned by you. |
| `list_comments` | Comment threads with the quoted text. `detached` means the quoted text was deleted. |
| `add_comment` | Comment on a quoted part of the document. |
| `reply_comment` | Reply in a thread. |
| `resolve_comment` | Resolve or reopen a thread. |
| `suggest_edit` | Propose replacing `old_text` with `new_text`. |
| `edit_note` | Replace `old_text` with `new_text`, or the whole document with `content`. Under `suggest` it creates a suggestion. |
| `trash_note` | Move a document to the trash. Only for a document the user owns, with agent policy `edit`. |
| `restore_note` | Bring a document back from the trash. Same rules as `trash_note`. |
| `get_history` | Edit sessions with authors and sources, and comment, suggestion and permission events. Pass `revision_id` for the full text and diff. |
| `create_upload` | A one-time URL to upload an image or a PDF file to a document, and the `curl` command that uses it. Needs agent policy `suggest` or `edit`. |

A page of `list_notes` or `search_notes` holds up to `limit` documents (default 50 and 20, maximum 200). If more documents exist, the result has `next_offset`. Pass it as `offset` to get the next page. Search ranks the first 500 matches.

`old_text` and `quote` must match the document exactly. If the text appears more than once, quote more context or pass `occurrence` (1 is the first match).

A document can be given as its alias, as `/n/<alias>`, or as its full URL. A view-only link, such as `https://notes.example.com/v/<token>`, works too and gives read access.

## Upload images and files

A tool call cannot carry a file, so the agent uploads it with `curl`. The file goes straight from the agent's disk to greydoc. It does not pass through the model.

1. The agent calls `create_upload` with the document. It gets an upload URL and a command such as `curl -sS -F "file=@chart.png" https://notes.example.com/api/uploads/gd_up_…`.
2. The agent runs the command. The answer holds the Markdown for the file, for example `![chart.png](/uploads/1f3a….png)`.
3. The agent puts that Markdown in the document with `edit_note`, or proposes it with `suggest_edit`.

The URL works once and expires after 10 minutes. A rejected file, for example HTML or a file over the size limit, leaves the URL usable. The audit log records the upload as made by the agent.

## Import from HedgeDoc

`create_note` takes the fields an import needs: `alias` (the old document ID), `extra_aliases` (the other IDs), `created_at`, `updated_at`, `permissions` (a HedgeDoc 1 `hedgedoc_mode`, or explicit `everyone`, `signed_in`, `users` and `groups` levels, where `groups` uses greydoc group names that you belong to) and `agent_policy`. `POST /api/notes` takes the same fields. [Import from HedgeDoc 1](import-hedgedoc.md) explains the IDs, the permission mapping and the links that keep working.

## Audit

Every tool call is recorded in the audit log as `mcp.call`: the tool, the document, the arguments, whether it worked, the error, and how long it took. Long text arguments are cut to their first words and their length. Each new client session is recorded as `mcp.session`, with the client's name and version.

On the audit page, the filter "Agent (MCP) calls" shows these events and a usage summary for the last 7, 30 or 90 days: calls and errors by tool, by client and by person. The same summary is at `GET /api/audit/mcp?days=30`. Admins see all calls. Others see calls on documents they can read and their own calls.

Document timelines leave out these calls, so they only show what changed the document.

## What people see

Agent suggestions appear in the editor as tracked changes with an "agent" tag. Accepted agent text and direct agent edits show a dotted underline in the authors view. The timeline marks agent revisions and events with "Agent" and the client name, for example "via Claude".
