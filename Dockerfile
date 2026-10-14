# Production image: a static Go binary with the committed UI (internal/server/uidist) embedded.
# The build stage runs natively and cross-compiles, so multi-arch builds do not emulate the compiler.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ARG GIT_COMMIT=""
ARG BUILD_TIME=""
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath \
    -ldflags="-s -w -X main.version=${VERSION} -X main.gitCommit=${GIT_COMMIT} -X main.buildTime=${BUILD_TIME}" \
    -o /out/greydoc ./cmd/greydoc

FROM alpine:3.22
RUN adduser -D -u 1000 greydoc && mkdir -p /data && chown greydoc:greydoc /data
COPY --from=build /out/greydoc /usr/local/bin/greydoc
USER greydoc
VOLUME /data
ENV GREYDOC_DATABASE_URL=/data/greydoc.db \
    GREYDOC_DATA_DIR=/data \
    GREYDOC_SECRET_FILE=/data/secret \
    GREYDOC_HOST=0.0.0.0 \
    GREYDOC_PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${GREYDOC_PORT:-3000}/healthz" || exit 1
ENTRYPOINT ["greydoc"]
CMD ["serve"]
