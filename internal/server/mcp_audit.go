package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/greyhavenhq/greydoc/internal/store"
)

// auditMCP records every tool call and every new client session in the audit log, to show how agents use greydoc.
func (s *Server) auditMCP(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		switch r := req.(type) {
		case *mcp.CallToolRequest:
			start := time.Now()
			res, err := next(ctx, method, req)
			s.recordCall(r, res, err, time.Since(start))
			return res, err
		case *mcp.ServerRequest[*mcp.InitializeParams]:
			res, err := next(ctx, method, req)
			if err == nil {
				s.recordSession(r)
			}
			return res, err
		}
		return next(ctx, method, req)
	}
}

// auditArg keeps short values and replaces long text with its start and length.
func auditArg(v any) any {
	switch x := v.(type) {
	case string:
		if n := utf8.RuneCountInString(x); n > 120 {
			return fmt.Sprintf("%s… (%d characters)", string([]rune(x)[:80]), n)
		}
		return x
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			out[k] = auditArg(val)
		}
		return out
	case []any:
		out := make([]any, 0, min(len(x), 20))
		for _, val := range x[:min(len(x), 20)] {
			out = append(out, auditArg(val))
		}
		return out
	}
	return v
}

func (s *Server) recordCall(r *mcp.CallToolRequest, res mcp.Result, callErr error, took time.Duration) {
	id, err := s.mcpCaller(r.Extra, r.Session)
	if err != nil || r.Params == nil {
		return
	}
	var args map[string]any
	_ = json.Unmarshal(r.Params.Arguments, &args)
	data := map[string]any{"tool": r.Params.Name, "args": auditArg(args), "ok": true, "ms": took.Milliseconds()}
	if callErr != nil {
		data["ok"], data["error"] = false, excerpt(callErr.Error())
	} else if tr, ok := res.(*mcp.CallToolResult); ok && tr.IsError {
		data["ok"] = false
		if e := tr.GetError(); e != nil {
			data["error"] = excerpt(e.Error())
		} else {
			for _, c := range tr.Content {
				if t, ok := c.(*mcp.TextContent); ok {
					data["error"] = excerpt(t.Text)
					break
				}
			}
		}
	}
	ev := id.event("", "mcp.call", data)
	if ref, ok := args["note"].(string); ok && ref != "" {
		alias, _ := noteRef(ref)
		if n, err := s.store.NoteByAlias(context.Background(), alias); err == nil {
			ev.NoteID = n.ID
		}
	}
	if err := s.store.AddEvent(context.Background(), ev); err != nil {
		slog.Warn("audit of an MCP call failed", "error", err)
	}
}

func (s *Server) recordSession(r *mcp.ServerRequest[*mcp.InitializeParams]) {
	id, err := s.mcpCaller(r.Extra, r.Session)
	if err != nil {
		return
	}
	data := map[string]any{}
	if p := r.Params; p != nil {
		data["protocol"] = p.ProtocolVersion
		if p.ClientInfo != nil {
			data["client"], data["version"] = p.ClientInfo.Name, p.ClientInfo.Version
			id.Client = p.ClientInfo.Name
		}
	}
	ev := id.event("", "mcp.session", data)
	ev.Source = store.SourceAgent
	_ = s.store.AddEvent(context.Background(), ev)
}

type usageRow struct {
	Name   string `json:"name"`
	Calls  int    `json:"calls"`
	Errors int    `json:"errors"`
	AvgMS  int64  `json:"avg_ms"`
	Last   string `json:"last"`
}

func summarize(calls []store.MCPCall, key func(store.MCPCall) string) []usageRow {
	rows := map[string]*usageRow{}
	total := map[string]int64{}
	for _, c := range calls {
		k := key(c)
		if k == "" {
			k = "unknown"
		}
		r := rows[k]
		if r == nil {
			r = &usageRow{Name: k, Last: c.At}
			rows[k] = r
		}
		r.Calls++
		if !c.OK {
			r.Errors++
		}
		total[k] += c.MS
	}
	out := make([]usageRow, 0, len(rows))
	for k, r := range rows {
		r.AvgMS = total[k] / int64(r.Calls)
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Calls > out[j].Calls || (out[i].Calls == out[j].Calls && out[i].Name < out[j].Name)
	})
	return out
}

// handleMCPUsage sums up agent tool calls by tool, client and person over the last days.
func (s *Server) handleMCPUsage(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil || id.isAgent() {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
		return
	}
	days, err := strconv.Atoi(r.URL.Query().Get("days"))
	if err != nil || days <= 0 || days > 365 {
		days = 30
	}
	const max = 100000
	calls, err := s.store.MCPCalls(r.Context(), s.viewer(id), time.Now().AddDate(0, 0, -days), max)
	if err != nil {
		internalError(w, err)
		return
	}
	errs := 0
	for _, c := range calls {
		if !c.OK {
			errs++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"days": days, "calls": len(calls), "errors": errs, "truncated": len(calls) == max,
		"tools":   summarize(calls, func(c store.MCPCall) string { return c.Tool }),
		"clients": summarize(calls, func(c store.MCPCall) string { return c.Client }),
		"people":  summarize(calls, func(c store.MCPCall) string { return c.Actor }),
	})
}
