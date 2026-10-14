# CLAUDE.md

## Docker only

Every build, test, lint and run command MUST run inside the dev container. Do not run `go`, `node`, `npm` or Playwright on the host.

```bash
docker compose -f docker-compose.dev.yml run --rm dev just test     # go test ./...
docker compose -f docker-compose.dev.yml run --rm dev just race
docker compose -f docker-compose.dev.yml run --rm dev just ui       # rebuild internal/server/uidist
docker compose -f docker-compose.dev.yml run --rm dev just ui-test  # vitest
docker compose -f docker-compose.dev.yml run --rm dev just e2e      # Playwright against a built binary
docker compose -f docker-compose.dev.yml --profile postgres up -d postgres && docker compose -f docker-compose.dev.yml run --rm dev just test-pg
docker compose -f docker-compose.dev.yml up app                     # http://127.0.0.1:3000
```

`.env` holds `LLM_API_BASEURL`, `LLM_API_KEY`, `LLM_MODEL`. It is read only through `env_file` in the containers. It MUST NOT be committed or copied into an image.

## Layout

- `cmd/greydoc`: CLI (`serve`, `token`, `version`).
- `internal/config`: `GREYDOC_*` variables. Empty `GREYDOC_OIDC_ISSUER` means local mode: no login, full access.
- `internal/store`: all persistence. `schema.go` is the DDL for SQLite and Postgres.
- `internal/collab`: Yjs sync hub. `crdt.go` is the only file that imports `ygo`.
- `internal/permission`: pure access decisions.
- `internal/notemeta`: front matter, tags, title.
- `internal/history`: edit sessions into timeline revisions.
- `internal/mirror`: write-only markdown mirror in the data directory.
- `internal/mcp`, `internal/oauth`: MCP server and its OAuth authorization server.
- `internal/server`: HTTP handlers and the embedded UI.
- `ui/`: React + Vite. It builds into `internal/server/uidist/`, which is committed. After a UI change, run `just ui` and commit `uidist/`.

## Rules

- The database is the source of truth. The data directory mirror is write-only.
- Every text change is stored with its author and source (`human`, `ai_assisted`, `agent`, `restore`).
- In-app AI output is always a suggestion. It never changes text directly.
