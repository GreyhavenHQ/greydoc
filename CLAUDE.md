# CLAUDE.md

## Docker only

Every build, test, lint and run command MUST run inside the dev container. Do not run `go`, `node`, `npm` or Playwright on the host.

```bash
docker compose -f docker-compose.dev.yml run --rm dev just test     # go test ./...
docker compose -f docker-compose.dev.yml run --rm dev just race
docker compose -f docker-compose.dev.yml run --rm dev just ui       # build the UI into internal/server/uidist (not tracked)
docker compose -f docker-compose.dev.yml run --rm dev just ui-test  # vitest
docker compose -f docker-compose.dev.yml run --rm dev just e2e      # Playwright against a built binary
docker compose -f docker-compose.dev.yml --profile postgres up -d postgres && docker compose -f docker-compose.dev.yml run --rm dev just test-pg
docker compose -f docker-compose.dev.yml up app                     # http://127.0.0.1:43031
```

`.env` holds `LLM_API_BASEURL`, `LLM_API_KEY`, `LLM_MODEL`. It is read only through `env_file` in the containers. It MUST NOT be committed or copied into an image.

## Layout

- `cmd/greydoc`: CLI (`serve`, `token create`, `copy-db`, `version`).
- `internal/config`: `GREYDOC_*` variables. Empty `GREYDOC_OIDC_ISSUER` means local mode: no login, full access.
- `internal/store`: all persistence. `schema.go` is the DDL for SQLite and Postgres.
- `internal/collab`: Yjs sync hub. `crdt.go` is the only file that imports `ygo`.
- `internal/permission`: pure access decisions.
- `internal/notemeta`: front matter, tags, title.
- `internal/history`: edit sessions into timeline revisions.
- `internal/ai`: OpenAI-compatible client for in-editor actions. It returns text and never writes.
- `internal/server`: HTTP handlers, the embedded UI, the MCP tools (`mcp.go`) and the OAuth server for MCP (`oauth.go`). MCP shares the access checks of the REST handlers.
- `ui/`: React + Vite. It builds into `internal/server/uidist/`, which is embedded but not tracked: only `.gitkeep` is. The Docker image builds it in its own stage. Without it, the server answers 503 on UI pages; run `just ui` before `just e2e` or `just serve`.

## Rules

- `docker-compose.dev.yml` is the project `greydoc-dev`. Its Postgres is a throwaway test database. Never point tests at the database of `docker-compose.yml`.
- `just lint` MUST pass. Postgres changes MUST pass `just test-pg`.
- Commits MUST follow Conventional Commits: `type(scope): subject`, imperative, lowercase. Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, `perf`. Scopes are packages or `ui`. One logical change per commit.

- The database is the source of truth. The data directory holds uploads and the secret only.
- Every text change is stored with its author and source (`human`, `ai_assisted`, `agent`, `restore`).
- In-app AI output is always a suggestion. It never changes text directly.
