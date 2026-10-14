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
| Short address | `/<alias>` opens `/n/<alias>`. |
| Tags | Add `tags: [design, q4]` to the front matter. Click a tag on the home page to filter. |
| Protect a note | "Share" in the editor: people, groups, signed-in users, anyone with the address. Levels are view, comment and edit. |
| Share with a client | "Share", then "New link". The link opens `/s/<alias>`: the rendered note with no editor, comments or toolbar. |
| Comment | Select text, press "Comment". |
| Suggest | Select text, press "Suggest", or switch the editor to "Suggesting" and type. People with comment access always suggest. |
| AI | Select text, press "AI": refine, shorten, fix, diagram, continue, or ask. The answer is a suggestion. |
| History | The clock button opens the timeline. Open a revision to see its diff or restore it. |
| Who wrote what | The people button colors text by author. Dashed underline means AI-assisted. Dotted means agent. |
| Slides | Menu, "Slide mode". `---` starts a slide, `----` a vertical slide, `note:` starts speaker notes. |
| Download | Menu, "Download Markdown" or "Download HTML". The HTML file has no scripts and includes the diagrams. |
| Images | Paste or drop an image in the editor. |

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
