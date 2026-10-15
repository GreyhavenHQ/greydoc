package ai

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Preset is a one-click AI action, set server-wide with GREYDOC_AI_ACTIONS.
type Preset struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Instruction string `json:"instruction"`
	Output      Output `json:"output,omitempty"`
}

// DefaultPresets say exactly what they ask, so the person sees what the model is told.
func DefaultPresets() []Preset {
	return []Preset{
		{ID: "fix", Label: "Fix spelling and grammar", Output: OutputReplace,
			Instruction: "Fix spelling, grammar and punctuation in the selection. Change nothing else."},
		{ID: "clearer", Label: "Make it clearer", Output: OutputReplace,
			Instruction: "Rewrite the selection so a reader understands it on the first read: short sentences, plain words, one idea per sentence. Keep every fact and the Markdown structure."},
		{ID: "shorter", Label: "Make it shorter", Output: OutputReplace,
			Instruction: "Cut the selection to about half its length. Keep the key facts and the Markdown structure."},
		{ID: "diagram", Label: "Make a diagram below", Output: OutputDiagram,
			Instruction: "Draw the selection as a Mermaid diagram. Use flowchart TD when there are more than four steps, flowchart LR otherwise, or sequenceDiagram for exchanges between parties. Keep node labels short."},
	}
}

var presetID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

// LoadPresets reads GREYDOC_AI_ACTIONS: a JSON list, or the path of a file that holds one. Empty means the defaults.
func LoadPresets(value string) ([]Preset, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return DefaultPresets(), nil
	}
	raw := []byte(value)
	if !strings.HasPrefix(value, "[") {
		b, err := os.ReadFile(value)
		if err != nil {
			return nil, fmt.Errorf("GREYDOC_AI_ACTIONS: %w", err)
		}
		raw = b
	}
	var presets []Preset
	if err := json.Unmarshal(raw, &presets); err != nil {
		return nil, fmt.Errorf("GREYDOC_AI_ACTIONS is not a JSON list of actions: %w", err)
	}
	seen := map[string]bool{}
	for i := range presets {
		p := &presets[i]
		if !presetID.MatchString(p.ID) || p.ID == "prompt" || p.ID == "revise" {
			return nil, fmt.Errorf("GREYDOC_AI_ACTIONS: id %q must be lowercase letters, digits and dashes, and not prompt or revise", p.ID)
		}
		if seen[p.ID] {
			return nil, fmt.Errorf("GREYDOC_AI_ACTIONS: id %q is used twice", p.ID)
		}
		seen[p.ID] = true
		if strings.TrimSpace(p.Label) == "" || strings.TrimSpace(p.Instruction) == "" {
			return nil, fmt.Errorf("GREYDOC_AI_ACTIONS: action %q needs a label and an instruction", p.ID)
		}
		switch p.Output {
		case "":
			p.Output = OutputReplace
		case OutputReplace, OutputBelow, OutputDiagram:
		default:
			return nil, fmt.Errorf("GREYDOC_AI_ACTIONS: action %q has output %q; use replace, below or diagram", p.ID, p.Output)
		}
	}
	return presets, nil
}
