// Package history turns the Yjs update log into timeline revisions.
package history

import (
	"context"
	"errors"
	"time"

	"github.com/greyhavenhq/greydoc/internal/collab"
	"github.com/greyhavenhq/greydoc/internal/store"
)

const (
	// IdleGap closes an edit session.
	IdleGap = 2 * time.Minute
	// MaxSpan caps how long one session can run.
	MaxSpan = 15 * time.Minute
)

type Processor struct {
	Store *store.Store
	Now   func() time.Time
}

// class decides which updates may share a session. People editing together share one.
// Each non-human source and author gets its own.
func class(u store.NoteUpdate) string {
	if u.Source == store.SourceHuman {
		return "human"
	}
	return string(u.Source) + ":" + u.UserID
}

// Group splits updates into sessions by idle gap, maximum span and source class.
func Group(ups []store.NoteUpdate) [][]store.NoteUpdate {
	var out [][]store.NoteUpdate
	var cur []store.NoteUpdate
	var start, last time.Time
	for _, u := range ups {
		at := store.ParseTime(u.CreatedAt)
		if len(cur) > 0 && (at.Sub(last) > IdleGap || at.Sub(start) > MaxSpan || class(u) != class(cur[0])) {
			out = append(out, cur)
			cur = nil
		}
		if len(cur) == 0 {
			start = at
		}
		cur = append(cur, u)
		last = at
	}
	if len(cur) > 0 {
		out = append(out, cur)
	}
	return out
}

// Process turns closed sessions into revisions. force also closes the session still in progress.
func (p *Processor) Process(ctx context.Context, noteID string, force bool) error {
	upto, state, err := p.Store.HistoryCursor(ctx, noteID)
	if err != nil {
		return err
	}
	ups, err := p.Store.UpdatesBetween(ctx, noteID, upto, 0)
	if err != nil {
		return err
	}
	sessions := Group(ups)
	now := time.Now()
	if p.Now != nil {
		now = p.Now()
	}
	if !force && len(sessions) > 0 {
		lastSession := sessions[len(sessions)-1]
		if now.Sub(store.ParseTime(lastSession[len(lastSession)-1].CreatedAt)) < IdleGap {
			sessions = sessions[:len(sessions)-1]
		}
	}
	if len(sessions) == 0 {
		return nil
	}
	prev := ""
	if last, err := p.Store.LastRevision(ctx, noteID); err == nil {
		prev = last.Text
	} else if len(state) > 0 {
		if _, prev, err = collab.Replay(state, nil); err != nil {
			return err
		}
	}
	for _, sess := range sessions {
		datas := make([][]byte, len(sess))
		for i, u := range sess {
			datas[i] = u.Data
		}
		var text string
		state, text, err = collab.Replay(state, datas)
		if err != nil {
			return err
		}
		var rev *store.Revision
		if text != prev {
			patch, added, removed := UnifiedDiff(prev, text)
			rev = &store.Revision{Text: text, Patch: patch, Added: added, Removed: removed,
				FromUpdate: sess[0].ID, ToUpdate: sess[len(sess)-1].ID,
				StartedAt: sess[0].CreatedAt, EndedAt: sess[len(sess)-1].CreatedAt}
			seen := map[string]bool{}
			srcSeen := map[store.Source]bool{}
			for _, u := range sess {
				key := u.UserID + "\x00" + string(u.Source)
				if !seen[key] {
					seen[key] = true
					rev.Authors = append(rev.Authors, store.RevisionAuthor{UserID: u.UserID, Name: u.Name, Source: u.Source})
				}
				if !srcSeen[u.Source] {
					srcSeen[u.Source] = true
					rev.Sources = append(rev.Sources, u.Source)
				}
			}
			prev = text
		}
		end := sess[len(sess)-1].ID
		if err := p.Store.CommitHistory(ctx, noteID, rev, upto, end, state); errors.Is(err, store.ErrConflict) {
			// Another server wrote this history first.
			return nil
		} else if err != nil {
			return err
		}
		upto = end
	}
	return p.Store.CompactUpdates(ctx, noteID)
}
