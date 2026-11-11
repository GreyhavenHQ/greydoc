# greydoc

greydoc is a collaborative Markdown editor in one Go binary, in the style of HedgeDoc. Open the site, press "New document" and type. Other people who open the same address edit with you in real time.

It adds what HedgeDoc does not have:

- A timeline of every change, with who made it and how: by hand, with AI help, or by an agent.
- An authors view that marks each part of the text with its writer, and AI-assisted text as such.
- Comments on a text range, with replies, resolve and reopen.
- Suggestions: proposed changes that a writer accepts or rejects. AI output is always a suggestion.
- An MCP endpoint, so AI agents can read, comment, suggest and, if the document allows it, edit.
- A document list with the owner and a view counter for each document, as in HedgeDoc.

It keeps what HedgeDoc users expect: split editor and preview, Mermaid diagrams, KaTeX math, tags in front matter, slide mode, a view-only page, and Markdown and HTML download.

## Run it

```bash
docker compose up -d
```

Open <http://127.0.0.1:43030>. The Compose file runs greydoc with Postgres. Set `GREYDOC_POSTGRES_PASSWORD` in `.env` before the first start.

Without OIDC, greydoc runs in local mode: there is no login and everyone can edit. Local mode listens on 127.0.0.1 only. To use it as a team, configure OIDC, for example [with authentik](docs/authentik.md). All settings are in [docs/configuration.md](docs/configuration.md).

To move an existing SQLite database to Postgres, stop greydoc, then copy the data. The command never changes the source.

```bash
docker compose stop greydoc
docker compose up -d --wait postgres
docker compose run --rm --no-deps greydoc copy-db --from /data/greydoc.db \
  --to "postgres://greydoc:$GREYDOC_POSTGRES_PASSWORD@postgres:5432/greydoc?sslmode=disable"
docker compose up -d greydoc
```

## Use it

| Task | How |
|---|---|
| New document | Press "New document", or open `/new`. `/new?alias=standup` picks the address. |
| Short address | `/<alias>` opens `/n/<alias>`. HedgeDoc 1 links work for imported documents; see [docs/import-hedgedoc.md](docs/import-hedgedoc.md). |
| Change the address | Menu, "Address", for the owner. A new custom address replaces the previous one, which stops working. `/n/<document id>` always opens the document, and older generated or imported addresses keep working. `PUT /api/notes/<alias>/slug` with `{"slug": "<name>"}` does the same. |
| Read and edit in one view | Documents open in live mode: the document shows as the preview does, and you edit it in place. Boxes, callouts, definitions and collapsible sections are edited as text, and a menu on a box or a callout changes its type. A click on a diagram, a formula, a table of contents, a CSV table or an HTML block edits its source. The split view of HedgeDoc (editor and preview side by side, Ctrl+Alt+B) is one click away. The pencil and eye buttons give the editor alone and the preview alone. The buttons change the open document in this tab only. |
| Choose how documents open | Settings, "Editor". "Open documents in" sets the starting mode: Live, Editor, Split or Preview. "Live style" sets what live mode shows: Document never shows Markdown, Obsidian shows the Markdown of the line you edit. Both choices are stored on your account. Without a choice, documents open in Live with the Document style. |
| Format without Markdown | The toolbar above the editor has undo, redo, the paragraph style, bold, italic, strikethrough, highlight, inline code, link, the three list types, quote, table, image, code block and divider. The "⋯" button at the end opens the other formats: underline, superscript, subscript, formulas, callouts, boxes, collapsible sections, diagrams, CSV tables, definitions, a table of contents, footnotes and links to other documents. Each button writes Markdown, as its keyboard shortcut does. The link button edits the text and the address of the link under the cursor. On a narrow screen, the buttons that do not fit move into the "⋯" menu. People with comment access get no toolbar. |
| Edit a table | In live mode a table is a grid. Type in a cell. Tab and Shift+Tab move to the next and the previous cell, Enter moves down. On the last row, Tab and Enter add a row. The "⋯" button on a cell, or a right click, adds and deletes rows and columns, sets the alignment, pads the columns ("Tidy table"), and shows the table as Markdown until the cursor leaves it. |
| Tags | Add `tags: [design, q4]` to the front matter. Click a tag on the home page to filter. |
| Link to a document | Type `[[` in the editor and pick a document. It inserts `[[alias|Title]]`: the address, then the link text, which you can edit. `[[alias]]` alone shows the current title of the document. |
| Table of contents | On wide screens, the view page and the preview-only mode show the headings on the right, as in HedgeDoc: top-level headings, the open section, and "Expand all". `[toc]` in the text inserts a table of contents too. |
| Protect a document | "Share" in the editor: people, signed-in users, anyone with the address. Levels are view, comment and edit. |
| Share with a client | "Share", then "New link". The short link `/v/<token>` opens the rendered document with no editor, comments or toolbar. Older `/s/<alias>?share=<token>` links keep working. |
| Comment | Select text, press "Comment". |
| Suggest | Select text, press "Suggest". People with comment access suggest each time they type. |
| AI | Select text, press "AI", and type what to do, or pick a preset: fix spelling and grammar, make it clearer, make it shorter, make a diagram. Presets are set server-wide with `GREYDOC_AI_ACTIONS`. The answer is a suggestion. |
| History | The clock button opens the timeline. Open a revision to see its diff or restore it. Open a suggestion or comment event to see it, accept or reject it, or jump to it in the document. An AI suggestion shows the request and, on demand, the full prompt sent to the model. |
| Who wrote what | The people button colors text by author. Dashed underline means AI-assisted. Dotted means agent. |
| Slides | Menu, "Slide mode". `---` starts a slide, `----` a vertical slide, `note:` starts speaker notes. Escape shows all slides, D switches between light and dark. |
| Download | Menu, "Download Markdown" or "Download HTML". The HTML file has no scripts and includes the diagrams. |
| Move a document | Menu, "Download with uploads (.zip)": the Markdown at the root, its files in `uploads/`, and `note.json`. Drop the zip on the document list of another greydoc to import it. `POST /api/notes/import` takes the same zip. |
| Import Markdown | Drop `.md` files on the document list. |
| Images | Paste or drop an image in the editor. |
| Delete | Menu, "Move to trash". The trash (account menu) restores documents for 30 days. "Delete for good" removes a document at once. |
| Audit | Account menu, "Audit log": every action on documents and accounts, with filters, and Restore for trashed documents. |

## Compatibility with HedgeDoc 1

"Same" means it works as in HedgeDoc 1. "Different" means it works, in another way. "Missing" means greydoc does not have it yet.

### Addresses and API

| HedgeDoc 1 | greydoc | Notes |
|---|---|---|
| `/new` | Same | `/new?alias=<name>` picks the address. |
| `/<id>` (alias, document ID or short ID) | Same | IDs are case-insensitive. Import documents with all their IDs, see [import](docs/import-hedgedoc.md). |
| `?edit`, `?view`, `?both` | Same | greydoc adds a live mode. Without a parameter, a document opens in the mode chosen in Settings. |
| `/<id>/publish`, `/s/<shortid>` | Same | |
| `/<id>/slide`, `/p/<shortid>` | Same | |
| `/<id>/download` | Same | |
| `/<id>/info` | Same | `viewcount` counts people who opened the document. |
| `/features` | Same | greydoc's own guide. The source is [docs/features.md](docs/features.md). |
| `POST /new`, `POST /new/<alias>` | Same | Needs sign-in in OIDC mode. |
| Free URL: opening an unknown `/<name>` creates it | Missing | Use `/new?alias=<name>`. |
| `/<id>/revision`, `/history`, `/me`, `/status` | Different | greydoc has its own JSON API under `/api`. |
| LZString document IDs from early versions | Missing | |

### Documents and permissions

| HedgeDoc 1 | greydoc | Notes |
|---|---|---|
| Permission modes (freely, editable, limited, locked, protected, private) | Different | Grants per person, signed-in users and anyone with the address, at view, comment or edit level. Each mode maps to grants, see [import](docs/import-hedgedoc.md). |
| Owner | Same | The owner manages access and the trash. |
| Guest editing | Same | The owner sets "Anyone with the address" to "Can edit". `GREYDOC_GUEST_MAX=read` turns it off. |
| Real-time collaboration and cursors | Same | Yjs instead of OT. |
| Revision history and revert | Same | Timeline with diffs, authors and restore. |
| Recent documents and pins | Same | Home page, "Recent". |
| Delete | Different | Documents go to a trash for 30 days. |
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
| `slideOptions` | Different | `transition`, `slideNumber`, `width`, `height`, `margin`, `center`, `controls`, `progress`, `backgroundTransition`. `theme` picks the light or dark Greyhaven deck: dark for `black`, `night`, `league`, `blood`, `moon`, `dracula`. Without it, the deck follows the app theme. |
| `breaks: false`, `lang`, `dir`, `robots`, `GA`, `disqus`, `opengraph` | Missing | Line breaks are always on. `opengraph.title` sets the title. |

### Not in HedgeDoc 1

Comments, suggestions, AI actions, live mode, authorship marks, the agent policy, MCP, the audit log, the trash and the wide layout (`width: wide` in the front matter) are new in greydoc.

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

The client signs you in through the browser. In opencode, `opencode mcp auth greydoc` starts the sign-in. Each document's owner sets what agents may do on it: nothing, read, suggest (the default) or edit. See [docs/mcp.md](docs/mcp.md).

## Data

The database is the source of truth: Postgres in `docker-compose.yml`, or a SQLite file when `GREYDOC_DATABASE_URL` is a path (the binary's default). The data directory holds uploads and the server secret. Back up both with the database.

## Develop

All commands run in the dev container. See [CLAUDE.md](CLAUDE.md) for the list.

```bash
docker compose -f docker-compose.dev.yml run --rm dev just test
docker compose -f docker-compose.dev.yml up app
```

More: [architecture](docs/architecture.md), [configuration](docs/configuration.md), [authentik](docs/authentik.md), [MCP](docs/mcp.md), [import from HedgeDoc 1](docs/import-hedgedoc.md).
