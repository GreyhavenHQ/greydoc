// greydoc: serve the collaborative editor, or manage access tokens in the database.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/greyhavenhq/greydoc/internal/config"
	"github.com/greyhavenhq/greydoc/internal/secrets"
	"github.com/greyhavenhq/greydoc/internal/server"
	"github.com/greyhavenhq/greydoc/internal/store"
)

var (
	version   = "dev"
	gitCommit = ""
	buildTime = ""
)

func versionString(version, gitCommit, buildTime string) string {
	switch {
	case gitCommit == "" && buildTime == "":
		return version
	case buildTime == "":
		return fmt.Sprintf("%s (%s)", version, gitCommit)
	case gitCommit == "":
		return fmt.Sprintf("%s (built %s)", version, buildTime)
	default:
		return fmt.Sprintf("%s (%s, built %s)", version, gitCommit, buildTime)
	}
}

var loopbackHosts = map[string]bool{"127.0.0.1": true, "::1": true, "localhost": true}

const nonlocalWarning = `!! WARNING: local mode (no OIDC) is bound to a non-loopback interface.
!! Anyone who can reach this address can read and edit every note.`

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = cmdServe(os.Args[2:])
	case "token":
		err = cmdToken(os.Args[2:])
	case "version", "--version":
		fmt.Println(versionString(version, gitCommit, buildTime))
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: greydoc <command>

commands:
  serve                  run the server
  token create --user U  mint a personal access token for the API and MCP
  version                print the version`)
}

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	host := fs.String("host", "", "bind address (default from GREYDOC_HOST)")
	port := fs.Int("port", 0, "bind port (default from GREYDOC_PORT)")
	_ = fs.Parse(args)

	cfg := config.FromEnv()
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: cfg.SlogLevel()})))
	if *host != "" {
		cfg.Host = *host
	}
	if *port != 0 {
		cfg.Port = *port
	}
	if cfg.LocalMode() && !loopbackHosts[cfg.Host] {
		if !cfg.AllowNonlocal {
			return fmt.Errorf("refusing to bind local mode to %q; set GREYDOC_ALLOW_NONLOCAL=1 to override", cfg.Host)
		}
		fmt.Fprintln(os.Stderr, nonlocalWarning)
	}

	srv, err := server.Open(cfg)
	if err != nil {
		return err
	}
	defer srv.Close()

	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	httpServer := &http.Server{Addr: addr, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-shutdown
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
	}()
	fmt.Fprintf(os.Stderr, "greydoc %s listening on http://%s\n", version, addr)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func cmdToken(args []string) error {
	if len(args) < 1 || args[0] != "create" {
		return errors.New("usage: greydoc token create --user USERNAME [--label LABEL] [--read-only]")
	}
	fs := flag.NewFlagSet("token create", flag.ExitOnError)
	user := fs.String("user", "", "username (local in local mode)")
	label := fs.String("label", "cli", "label shown in the token list")
	readOnly := fs.Bool("read-only", false, "only allow reading")
	_ = fs.Parse(args[1:])
	cfg := config.FromEnv()
	if *user == "" {
		if !cfg.LocalMode() {
			return errors.New("--user is required")
		}
		*user = "local"
	}
	secret, err := secrets.LoadOrCreate(cfg.Secret, cfg.SecretFile)
	if err != nil {
		return err
	}
	st, err := store.Open(cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := st.Init(ctx); err != nil {
		return err
	}
	scope := ""
	if *readOnly {
		scope = "notes:read"
	}
	tok, err := server.MintPAT(ctx, st, secret, *user, *label, scope)
	if err != nil {
		return err
	}
	fmt.Println(tok)
	return nil
}
