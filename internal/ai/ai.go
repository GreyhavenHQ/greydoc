// Package ai calls an OpenAI-compatible chat endpoint for in-editor actions. It returns text only and never writes notes.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type Action string

const (
	ActionRefine   Action = "refine"
	ActionShorten  Action = "shorten"
	ActionFix      Action = "fix"
	ActionDiagram  Action = "diagram"
	ActionContinue Action = "continue"
	ActionPrompt   Action = "prompt"
	// ActionRevise changes an earlier AI answer, given as the selection.
	ActionRevise Action = "revise"
)

type Request struct {
	Action Action
	// Instruction is the user's own request, required for ActionPrompt.
	Instruction string
	Document    string
	Selection   string
}

type Client struct {
	url, key, model string
	http            *http.Client
}

func New(baseURL, key, model string) *Client {
	return &Client{url: chatURL(baseURL), key: key, model: model, http: &http.Client{Timeout: 120 * time.Second}}
}

func chatURL(base string) string {
	base = strings.TrimRight(base, "/")
	if !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	return base + "/chat/completions"
}

const system = `You edit part of a shared Markdown document.
The user message holds the document. The part to work on is between <<<SELECTION>>> and <<<END>>>.
Reply with the replacement text for that part only: Markdown, no preamble, no explanation, no surrounding quotes.
Keep the language of the document. Keep Markdown structure (headings, lists, links) unless asked to change it.`

var tasks = map[Action]string{
	ActionRefine:   "Rewrite the selection so it reads clearly and concisely. Keep the meaning and every fact.",
	ActionShorten:  "Make the selection shorter. Keep the key facts.",
	ActionFix:      "Fix spelling, grammar and punctuation in the selection. Change nothing else.",
	ActionDiagram:  "Draw the selection as a Mermaid diagram. Reply with one ```mermaid fenced block and nothing else. Use flowchart TD when there are more than four steps, flowchart LR otherwise, or sequenceDiagram for exchanges between parties. Keep node labels short.",
	ActionContinue: "Write the text that follows the selection. Reply with the selection followed by the new text.",
}

const maxDocument = 24000

var fence = regexp.MustCompile("(?s)^```[a-zA-Z]*\\n(.*?)\\n?```$")

// Message is one chat message sent to the model.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func (c *Client) Model() string { return c.model }

// Messages returns the exact chat messages that Run sends for r.
func (c *Client) Messages(r Request) ([]Message, error) {
	task, ok := tasks[r.Action]
	if r.Action == ActionPrompt || r.Action == ActionRevise {
		if strings.TrimSpace(r.Instruction) == "" {
			return nil, errors.New("the prompt is empty")
		}
		task, ok = "Apply this request to the selection: "+r.Instruction, true
		if r.Action == ActionRevise && strings.Contains(r.Selection, "```mermaid") {
			task += " Keep it one ```mermaid fenced block."
		}
	}
	if !ok {
		return nil, fmt.Errorf("unknown action %q", r.Action)
	}
	doc := r.Document
	marked := "<<<SELECTION>>>" + r.Selection + "<<<END>>>"
	if i := strings.Index(doc, r.Selection); r.Selection != "" && i >= 0 {
		doc = doc[:i] + marked + doc[i+len(r.Selection):]
	} else {
		doc += "\n\n" + marked
	}
	if len(doc) > maxDocument {
		i := strings.Index(doc, marked)
		start := max(0, i-maxDocument/2)
		end := min(len(doc), i+len(marked)+maxDocument/2)
		doc = doc[start:end]
	}
	return []Message{{Role: "system", Content: system}, {Role: "user", Content: "Task: " + task + "\n\nDocument:\n" + doc}}, nil
}

// Run asks the model for the replacement of the selection.
func (c *Client) Run(ctx context.Context, r Request) (string, error) {
	messages, err := c.Messages(r)
	if err != nil {
		return "", err
	}
	body, _ := json.Marshal(map[string]any{"model": c.model, "temperature": 0.3, "messages": messages})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.key != "" {
		req.Header.Set("Authorization", "Bearer "+c.key)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("AI request failed: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("AI endpoint returned HTTP %d", resp.StatusCode)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || len(out.Choices) == 0 {
		return "", errors.New("AI endpoint returned no answer")
	}
	action := r.Action
	if action == ActionRevise && strings.Contains(r.Selection, "```mermaid") {
		action = ActionDiagram
	}
	return clean(out.Choices[0].Message.Content, action), nil
}

// clean removes a fence wrapping the whole answer, except the mermaid fence a diagram needs.
func clean(s string, a Action) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "<<<SELECTION>>>")
	s = strings.TrimSuffix(s, "<<<END>>>")
	if a == ActionDiagram {
		if !strings.HasPrefix(s, "```mermaid") {
			if m := fence.FindStringSubmatch(s); m != nil {
				s = m[1]
			}
			s = "```mermaid\n" + strings.TrimSpace(s) + "\n```"
		}
		return s
	}
	if m := fence.FindStringSubmatch(s); m != nil {
		s = m[1]
	}
	return strings.TrimSpace(s)
}
