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

e2e: build
    cd ui && npx playwright test

test:
    go test ./...

race:
    go test -race -count=1 ./...

lint:
    golangci-lint run

serve:
    go run ./cmd/greydoc serve
