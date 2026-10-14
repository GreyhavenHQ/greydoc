package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestEndpointURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://x.example":     "https://x.example/v1/chat/completions",
		"https://x.example/v1":  "https://x.example/v1/chat/completions",
		"https://x.example/v1/": "https://x.example/v1/chat/completions",
	} {
		if got := chatURL(in); got != want {
			t.Errorf("%s: %s", in, got)
		}
	}
}

func TestRefineSendsContextAndCleansOutput(t *testing.T) {
	var got map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer k" || r.URL.Path != "/v1/chat/completions" {
			http.Error(w, "bad", 400)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "```markdown\nBetter text.\n```"}}}})
	}))
	defer ts.Close()
	c := New(ts.URL, "k", "m")
	out, err := c.Run(context.Background(), Request{Action: ActionRefine, Document: "# Doc\nBad text.\nEnd", Selection: "Bad text."})
	if err != nil {
		t.Fatal(err)
	}
	if out != "Better text." {
		t.Fatalf("%q", out)
	}
	msgs := got["messages"].([]any)
	user := msgs[len(msgs)-1].(map[string]any)["content"].(string)
	if !strings.Contains(user, "<<<SELECTION>>>Bad text.<<<END>>>") || got["model"] != "m" {
		t.Fatalf("request %v", got)
	}
}

func TestDiagramKeepsMermaidFence(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "```mermaid\ngraph TD\nA-->B\n```"}}}})
	}))
	defer ts.Close()
	out, err := New(ts.URL, "", "m").Run(context.Background(), Request{Action: ActionDiagram, Document: "a then b", Selection: "a then b"})
	if err != nil || !strings.HasPrefix(out, "```mermaid\n") {
		t.Fatalf("%q %v", out, err)
	}
}

func TestUpstreamErrorIsReported(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "nope", 500) }))
	defer ts.Close()
	if _, err := New(ts.URL, "", "m").Run(context.Background(), Request{Action: ActionRefine, Selection: "x"}); err == nil {
		t.Fatal("no error")
	}
}

func TestUnknownAction(t *testing.T) {
	if _, err := New("http://x", "", "m").Run(context.Background(), Request{Action: "nope"}); err == nil {
		t.Fatal("no error")
	}
}

// TestRealEndpoint calls the endpoint from .env. It is skipped when LLM_API_BASEURL is not set.
func TestRealEndpoint(t *testing.T) {
	base := os.Getenv("LLM_API_BASEURL")
	if base == "" || os.Getenv("GREYDOC_AI_SMOKE") == "" {
		t.Skip("set LLM_API_BASEURL and GREYDOC_AI_SMOKE=1 to call the real endpoint")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	out, err := New(base, os.Getenv("LLM_API_KEY"), os.Getenv("LLM_MODEL")).Run(ctx, Request{
		Action: ActionRefine, Document: "Notes\n\nthe meeting was good we decide to ship it next week maybe",
		Selection: "the meeting was good we decide to ship it next week maybe",
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out) == "" || strings.Contains(out, "<<<") {
		t.Fatalf("output %q", out)
	}
	t.Logf("refined: %s", out)
}
