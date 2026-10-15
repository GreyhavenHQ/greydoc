// Package config holds runtime configuration, read from GREYDOC_* variables.
package config

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// DatabaseURL is a SQLite file path (default) or a postgres:// URL.
	DatabaseURL string
	// DataDir holds uploads (uploads/).
	DataDir    string
	SecretFile string
	Secret     string

	Host          string
	Port          int
	AllowNonlocal bool
	// BaseURL is the public origin, used for OAuth metadata and links. Empty means derive from the request.
	BaseURL string

	// OIDCIssuer empty means local mode: no login, full access.
	OIDCIssuer       string
	OIDCClientID     string
	OIDCClientSecret string
	OIDCRedirectURL  string
	OIDCScopes       string
	OIDCGroupsClaim  string
	SessionTTL       time.Duration

	// AdminGroup members see the whole audit log and every note's trash.
	AdminGroup string
	// TrashRetention is how long a note stays in the trash before it is deleted for good.
	TrashRetention time.Duration

	// GuestMax caps what a signed-out visitor can get in OIDC mode: deny, read, comment or write.
	GuestMax string
	// DefaultEveryone and DefaultSignedIn are the grants a new note starts with.
	DefaultEveryone string
	DefaultSignedIn string

	MaxNoteLength  int
	MaxUploadBytes int64
	RoomIdleGrace  time.Duration
	RoomSaveEvery  time.Duration

	LLMBaseURL string
	LLMAPIKey  string
	LLMModel   string

	LogLevel string
}

func (c Config) LocalMode() bool { return c.OIDCIssuer == "" }

func (c Config) AIEnabled() bool { return c.LLMBaseURL != "" }

func FromEnv() Config {
	return Config{
		DatabaseURL:      envStr("GREYDOC_DATABASE_URL", "greydoc.db"),
		DataDir:          envStr("GREYDOC_DATA_DIR", "data"),
		SecretFile:       envStr("GREYDOC_SECRET_FILE", ".greydoc/secret"),
		Secret:           envStr("GREYDOC_SECRET", ""),
		Host:             envStr("GREYDOC_HOST", "127.0.0.1"),
		Port:             envInt("GREYDOC_PORT", 3000),
		AllowNonlocal:    envBool("GREYDOC_ALLOW_NONLOCAL", false),
		BaseURL:          strings.TrimRight(envStr("GREYDOC_BASE_URL", ""), "/"),
		OIDCIssuer:       envStr("GREYDOC_OIDC_ISSUER", ""),
		OIDCClientID:     envStr("GREYDOC_OIDC_CLIENT_ID", ""),
		OIDCClientSecret: envStr("GREYDOC_OIDC_CLIENT_SECRET", ""),
		OIDCRedirectURL:  envStr("GREYDOC_OIDC_REDIRECT_URL", ""),
		OIDCScopes:       envStr("GREYDOC_OIDC_SCOPES", "openid profile email"),
		OIDCGroupsClaim:  envStr("GREYDOC_OIDC_GROUPS_CLAIM", "groups"),
		SessionTTL:       envDuration("GREYDOC_SESSION_TTL", 7*24*time.Hour),
		AdminGroup:       envStr("GREYDOC_ADMIN_GROUP", ""),
		TrashRetention:   envDuration("GREYDOC_TRASH_RETENTION", 30*24*time.Hour),
		GuestMax:         envStr("GREYDOC_GUEST_MAX", "read"),
		DefaultEveryone:  envStr("GREYDOC_DEFAULT_EVERYONE", "deny"),
		DefaultSignedIn:  envStr("GREYDOC_DEFAULT_SIGNED_IN", "write"),
		MaxNoteLength:    envInt("GREYDOC_MAX_NOTE_LENGTH", 1_000_000),
		MaxUploadBytes:   envInt64("GREYDOC_MAX_UPLOAD_BYTES", 10<<20),
		RoomIdleGrace:    envDuration("GREYDOC_ROOM_IDLE_GRACE", 10*time.Second),
		RoomSaveEvery:    envDuration("GREYDOC_ROOM_SAVE_INTERVAL", 5*time.Second),
		LLMBaseURL:       strings.TrimRight(envStr("LLM_API_BASEURL", ""), "/"),
		LLMAPIKey:        envStr("LLM_API_KEY", ""),
		LLMModel:         envStr("LLM_MODEL", ""),
		LogLevel:         envStr("GREYDOC_LOG_LEVEL", "info"),
	}
}

func (c Config) SlogLevel() slog.Level {
	switch strings.ToLower(c.LogLevel) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func envStr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if n, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return n
	}
	return fallback
}

func envInt64(key string, fallback int64) int64 {
	if n, err := strconv.ParseInt(os.Getenv(key), 10, 64); err == nil {
		return n
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	if b, err := strconv.ParseBool(os.Getenv(key)); err == nil {
		return b
	}
	return fallback
}

func envDuration(key string, fallback time.Duration) time.Duration {
	if d, err := time.ParseDuration(os.Getenv(key)); err == nil {
		return d
	}
	return fallback
}
