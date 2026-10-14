package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/greyhavenhq/greydoc/internal/config"
)

func fakeLLM(t *testing.T, answer string) *httptest.Server {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": answer}}}})
	}))
	t.Cleanup(ts.Close)
	return ts
}

func TestAIRefineCreatesAISuggestion(t *testing.T) {
	llm := fakeLLM(t, "Clear sentence.")
	e := newTestEnv(t, func(c *config.Config) { c.LLMBaseURL = llm.URL; c.LLMModel = "m" })
	alias := e.createNote(nil, "# T\nmessy sentence here\n")
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	code, body := e.do(nil, "POST", "/api/notes/"+alias+"/ai", map[string]any{"action": "refine", "quote": "messy sentence here"})
	if code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	var sg suggestionView
	_ = json.Unmarshal([]byte(body), &sg)
	if sg.Source != "ai_assisted" || sg.Proposed != "Clear sentence." || sg.Original != "messy sentence here" {
		t.Fatalf("%+v", sg)
	}
	text, _ := e.srv.TextForTest(context.Background(), n.ID)
	if text != "# T\nmessy sentence here\n" {
		t.Fatalf("AI changed the text: %q", text)
	}
	if code, _ := e.do(nil, "POST", "/api/notes/"+alias+"/suggestions/"+sg.ID+"/accept", nil); code != 200 {
		t.Fatal("accept")
	}
	clients, _ := e.srv.Store().NoteClients(context.Background(), n.ID)
	if last := clients[len(clients)-1]; last.Source != "ai_assisted" || last.UserID != "local" {
		t.Fatalf("accepted AI text attributed to %+v", last)
	}
	if err := e.srv.ProcessHistory(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	revs, _ := e.srv.Store().Revisions(context.Background(), n.ID, 10)
	if len(revs) == 0 || revs[0].Sources[0] != "ai_assisted" {
		t.Fatalf("timeline %+v", revs)
	}
}

func TestAIDisabledWithoutEndpoint(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "x")
	code, body := e.do(nil, "POST", "/api/notes/"+alias+"/ai", map[string]any{"action": "refine", "quote": "x"})
	if code != 404 || !strings.Contains(body, "ai_disabled") {
		t.Fatalf("%d %s", code, body)
	}
	_, me := e.get("/api/me")
	if !strings.Contains(me, `"ai_enabled":false`) {
		t.Fatal(me)
	}
}

func TestAIDiagramIsAnInsertionAfterTheSelection(t *testing.T) {
	llm := fakeLLM(t, "```mermaid\ngraph LR\nA-->B\n```")
	e := newTestEnv(t, func(c *config.Config) { c.LLMBaseURL = llm.URL })
	alias := e.createNote(nil, "A calls B.\nNext line.")
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	code, body := e.do(nil, "POST", "/api/notes/"+alias+"/ai", map[string]any{"action": "diagram", "quote": "A calls B."})
	if code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	var sg suggestionView
	_ = json.Unmarshal([]byte(body), &sg)
	if sg.Original != "" || sg.Proposed != "\n\n```mermaid\ngraph LR\nA-->B\n```\n" {
		t.Fatalf("%+v", sg)
	}
	e.do(nil, "POST", "/api/notes/"+alias+"/suggestions/"+sg.ID+"/accept", nil)
	text, _ := e.srv.TextForTest(context.Background(), n.ID)
	if text != "A calls B.\n\n```mermaid\ngraph LR\nA-->B\n```\n\nNext line." {
		t.Fatalf("%q", text)
	}
}

func TestReviseAISuggestion(t *testing.T) {
	var answers = []string{"Version one.", "Version two."}
	var prompts []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages []struct{ Content string } `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		prompts = append(prompts, req.Messages[len(req.Messages)-1].Content)
		a := answers[0]
		answers = answers[1:]
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": a}}}})
	}))
	defer ts.Close()
	e := newTestEnv(t, func(c *config.Config) { c.LLMBaseURL = ts.URL })
	alias := e.createNote(nil, "rough text here")
	_, body := e.do(nil, "POST", "/api/notes/"+alias+"/ai", map[string]any{"action": "refine", "quote": "rough text here"})
	var first suggestionView
	_ = json.Unmarshal([]byte(body), &first)
	code, body := e.do(nil, "POST", "/api/notes/"+alias+"/suggestions/"+first.ID+"/revise", map[string]any{"instruction": "shorter"})
	if code != 201 {
		t.Fatalf("revise %d %s", code, body)
	}
	var second suggestionView
	_ = json.Unmarshal([]byte(body), &second)
	if second.Proposed != "Version two." || second.Original != "rough text here" || second.Source != "ai_assisted" {
		t.Fatalf("%+v", second)
	}
	if !strings.Contains(prompts[1], "shorter") || !strings.Contains(prompts[1], "<<<SELECTION>>>Version one.<<<END>>>") {
		t.Fatalf("prompt %q", prompts[1])
	}
	_, body = e.do(nil, "GET", "/api/notes/"+alias+"/suggestions/"+first.ID, nil)
	if !strings.Contains(body, `"status":"replaced"`) {
		t.Fatalf("old suggestion %s", body)
	}
	_, body = e.do(nil, "GET", "/api/notes/"+alias+"/suggestions", nil)
	if strings.Count(body, `"id"`) != 1 {
		t.Fatalf("pending %s", body)
	}
}
