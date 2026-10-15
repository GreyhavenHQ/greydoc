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

// Output says where an answer goes: in place of the selection, as text below it, or as a diagram below it.
type Output string

const (
	OutputReplace Output = "replace"
	OutputBelow   Output = "below"
	OutputDiagram Output = "diagram"
)

type Request struct {
	// Action names the request in the timeline: a preset ID, "prompt" or "revise".
	Action string
	// Instruction is the task for the model.
	Instruction string
	Output      Output
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
	task := strings.TrimSpace(r.Instruction)
	if task == "" {
		return nil, errors.New("the request is empty")
	}
	if r.Output == OutputDiagram {
		task += " Reply with one ```mermaid fenced block and nothing else."
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
	return clean(out.Choices[0].Message.Content, r.Output), nil
}

// clean removes a fence wrapping the whole answer, except the mermaid fence a diagram needs.
func clean(s string, o Output) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "<<<SELECTION>>>")
	s = strings.TrimSuffix(s, "<<<END>>>")
	if o == OutputDiagram {
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
