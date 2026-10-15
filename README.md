# greydoc

greydoc is a collaborative Markdown editor in one Go binary, in the style of HedgeDoc. Open the site, press "New note" and type. Other people who open the same address edit with you in real time.

It adds what HedgeDoc does not have:

- A timeline of every change, with who made it and how: by hand, with AI help, or by an agent.
- An authors view that marks each part of the text with its writer, and AI-assisted text as such.
- Comments on a text range, with replies, resolve and reopen.
- Suggestions: proposed changes that a writer accepts or rejects. AI output is always a suggestion.
- An MCP endpoint, so AI agents can read, comment, suggest and, if the note allows it, edit.

It keeps what HedgeDoc users expect: split editor and preview, Mermaid diagrams, KaTeX math, tags in front matter, slide mode, a view-only page, and Markdown and HTML download.

## Run it

```bash
docker compose up -d
```

Open <http://127.0.0.1:43030>. Without OIDC, greydoc runs in local mode: there is no login and everyone can edit. Local mode listens on 127.0.0.1 only.

To use it as a team, configure OIDC. See [docs/configuration.md](docs/configuration.md).

## Use it

| Task | How |
|---|---|
| New note | Press "New note", or open `/new`. `/new?alias=standup` picks the address. |
| Short address | `/<alias>` opens `/n/<alias>`. HedgeDoc 1 links work for imported notes; see [docs/import-hedgedoc.md](docs/import-hedgedoc.md). |
| Read and edit in one view | Live mode (the book button, Ctrl+Alt+L) renders the note in place. The line you edit shows its Markdown. Click a diagram, table or formula to edit its source. The pencil, split and eye buttons give the source editor, editor with preview, and preview only. |
| Tags | Add `tags: [design, q4]` to the front matter. Click a tag on the home page to filter. |
| Protect a note | "Share" in the editor: people, groups, signed-in users, anyone with the address. Levels are view, comment and edit. |
| Share with a client | "Share", then "New link". The link opens `/s/<alias>`: the rendered note with no editor, comments or toolbar. |
| Comment | Select text, press "Comment". |
| Suggest | Select text, press "Suggest", or switch the editor to "Suggesting" and type. People with comment access always suggest. |
| AI | Select text, press "AI": refine, shorten, fix, diagram, continue, or ask. The answer is a suggestion. |
| History | The clock button opens the timeline. Open a revision to see its diff or restore it. Open a suggestion or comment event to see it, accept or reject it, or jump to it in the note. |
| Who wrote what | The people button colors text by author. Dashed underline means AI-assisted. Dotted means agent. |
| Slides | Menu, "Slide mode". `---` starts a slide, `----` a vertical slide, `note:` starts speaker notes. |
| Download | Menu, "Download Markdown" or "Download HTML". The HTML file has no scripts and includes the diagrams. |
| Images | Paste or drop an image in the editor. |
| Delete | Menu, "Move to trash". The trash (account menu) restores notes for 30 days. "Delete for good" removes a note at once. |
| Audit | Account menu, "Audit log": every action on notes and accounts, with filters, and Restore for trashed notes. |

## Compatibility with HedgeDoc 1

"Same" means it works as in HedgeDoc 1. "Different" means it works, in another way. "Missing" means greydoc does not have it yet.

### Addresses and API

| HedgeDoc 1 | greydoc | Notes |
|---|---|---|
| `/new` | Same | `/new?alias=<name>` picks the address. |
| `/<id>` (alias, note ID or short ID) | Same | IDs are case-insensitive. Import notes with all their IDs, see [import](docs/import-hedgedoc.md). |
| `?edit`, `?view`, `?both` | Same | greydoc adds a live mode and remembers the last mode. |
| `/<id>/publish`, `/s/<shortid>` | Same | |
| `/<id>/slide`, `/p/<shortid>` | Same | |
| `/<id>/download` | Same | |
| `/<id>/info` | Same | `viewcount` counts people who opened the note. |
| `POST /new`, `POST /new/<alias>` | Same | Needs sign-in in OIDC mode. |
| Free URL: opening an unknown `/<name>` creates it | Missing | Use `/new?alias=<name>`. |
| `/<id>/revision`, `/history`, `/me`, `/status` | Different | greydoc has its own JSON API under `/api`. |
| LZString note IDs from early versions | Missing | |

### Notes and permissions

| HedgeDoc 1 | greydoc | Notes |
|---|---|---|
| Permission modes (freely, editable, limited, locked, protected, private) | Different | Grants per person, group, signed-in users and anyone with the address, at view, comment or edit level. Each mode maps to grants, see [import](docs/import-hedgedoc.md). |
| Owner | Same | The owner manages access and the trash. |
| Guest editing | Different | Off by default. `GREYDOC_GUEST_MAX=write` allows it. |
| Real-time collaboration and cursors | Same | Yjs instead of OT. |
| Revision history and revert | Same | Timeline with diffs, authors and restore. |
| Recent notes and pins | Same | Home page, "Recent". |
| Delete | Different | Notes go to a trash for 30 days. |
| Sign-in: GitHub, GitLab, LDAP, SAML, email | Missing | OIDC only, or local mode with no sign-in. Most of these providers can sit behind an OIDC server. |
| Image upload | Different | Stored in the data directory. S3, imgur and similar backends are missing. |
| Export to Gist or Dropbox, import from them | Missing | |
| PDF export | Missing | Disabled by default in HedgeDoc 1. |

### Markdown

| HedgeDoc 1 | greydoc | Notes |
|---|---|---|
| CommonMark, tables, strikethrough, task lists, links | Same | |
| `[toc]`, emoji, footnotes, `==mark==`, `^sup^`, `~sub~`, `++ins++`, abbreviations, definition lists | Same | |
| Front matter `title`, `description`, `tags`; `###### tags:` line | Same | |
| `:::success`, `:::info`, `:::warning`, `:::danger`, `:::spoiler` | Same | GitHub `> [!NOTE]` alerts work too. |
| Image size `![](url =200x100)` | Same | |
| Math with `$…$` and `$$…$$` | Same | KaTeX. |
| Code highlighting | Same | |
| Code line numbers with ` ```js= ` | Different | The language works, line numbers do not show. |
| `csvpreview` | Same | |
| Mermaid | Same | Greyhaven theme, zoom, full screen, copy as SVG or PNG. |
| Graphviz, PlantUML, flowchart.js, js-sequence, abc, Vega-Lite, fretboard | Missing | |
| Embeds: `{%youtube %}`, Vimeo, Gist, SlideShare, Speaker Deck, PDF | Missing | |
| Front matter `type: slide` | Missing | Use slide mode from the menu. |
| `slideOptions` | Different | `transition` and `slideNumber` only. Themes are missing. |
| `breaks: false`, `lang`, `dir`, `robots`, `GA`, `disqus`, `opengraph` | Missing | Line breaks are always on. `opengraph.title` sets the title. |

### Not in HedgeDoc 1

Comments, suggestions, AI actions, live mode, authorship marks, the agent policy, MCP, the audit log and the trash are new in greydoc.

## Connect an agent

Claude Code:

```bash
claude mcp add --transport http greydoc https://notes.example.com/mcp
```

opencode, in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "greydoc": { "type": "remote", "url": "https://notes.example.com/mcp", "enabled": true }
  }
}
```

The client signs you in through the browser. In opencode, `opencode mcp auth greydoc` starts the sign-in. Each note's owner sets what agents may do on it: nothing, read, suggest (the default) or edit. See [docs/mcp.md](docs/mcp.md).

## Data

The database is the source of truth: SQLite by default, Postgres with `GREYDOC_DATABASE_URL=postgres://…`. greydoc also writes every note as a Markdown file to `data/notes/<alias>.md`, with its metadata in the front matter. These files are a copy for backups, search tools and git. greydoc does not read them back: edits on disk are overwritten.

## Develop

All commands run in the dev container. See [CLAUDE.md](CLAUDE.md) for the list.

```bash
docker compose -f docker-compose.dev.yml run --rm dev just test
docker compose -f docker-compose.dev.yml up app
```

More: [architecture](docs/architecture.md), [configuration](docs/configuration.md), [MCP](docs/mcp.md).
