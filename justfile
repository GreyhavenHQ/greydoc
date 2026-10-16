# Every recipe runs inside the dev container. On the host, prefix with:
#   docker compose -f docker-compose.dev.yml run --rm dev just <recipe>

default:
    @just --list

build:
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$(git describe --tags --always --dirty 2>/dev/null || echo dev)" -o bin/greydoc ./cmd/greydoc

ui:
    cd ui && npm ci --no-fund --no-audit && npm run build

ui-test:
    cd ui && npm ci --no-fund --no-audit && npm run test

e2e: ui build
    cd ui && npx playwright test

test:
    go test ./...

race:
    go test -race -count=1 ./...

lint:
    golangci-lint run

serve:
    go run ./cmd/greydoc serve

# Needs the postgres service: docker compose -f docker-compose.dev.yml --profile postgres up -d postgres
test-pg:
    GREYDOC_TEST_POSTGRES_URL='postgres://greydoc:greydoc@postgres:5432/greydoc?sslmode=disable' go test -count=1 ./internal/store/ ./internal/server/
