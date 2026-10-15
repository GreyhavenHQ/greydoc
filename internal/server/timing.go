package server

import (
	"bufio"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// slowRequest is how long greydoc may take before answering a request before it is logged.
const slowRequest = time.Second

// timingWriter adds Server-Timing when the headers go out, so the browser shows how long greydoc took to answer.
type timingWriter struct {
	http.ResponseWriter
	start  time.Time
	status int
	took   time.Duration
}

func (t *timingWriter) mark() {
	if t.status == 0 {
		t.took = time.Since(t.start)
		t.Header().Set("Server-Timing", fmt.Sprintf("app;dur=%.1f", float64(t.took.Microseconds())/1000))
	}
}

func (t *timingWriter) WriteHeader(code int) {
	t.mark()
	if t.status == 0 {
		t.status = code
	}
	t.ResponseWriter.WriteHeader(code)
}

func (t *timingWriter) Write(b []byte) (int, error) {
	if t.status == 0 {
		t.WriteHeader(http.StatusOK)
	}
	return t.ResponseWriter.Write(b)
}

// Hijack lets a websocket take over the connection through the wrapper.
func (t *timingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := t.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	return h.Hijack()
}

func (t *timingWriter) Flush() {
	if f, ok := t.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (t *timingWriter) Unwrap() http.ResponseWriter { return t.ResponseWriter }

// withTiming measures the time until the response headers, which for a websocket is the handshake.
// A slow answer is logged with the database pool, to tell slow queries from waits for a connection.
func (s *Server) withTiming(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tw := &timingWriter{ResponseWriter: w, start: time.Now()}
		before := s.store.Stats()
		next.ServeHTTP(tw, r)
		if tw.status == 0 {
			tw.took = time.Since(tw.start)
		}
		if tw.took > slowRequest {
			after := s.store.Stats()
			slog.Warn("slow request", "method", r.Method, "path", r.URL.Path, "status", tw.status, "took", tw.took,
				"db_in_use", after.InUse, "db_idle", after.Idle, "db_max_open", after.MaxOpenConnections,
				"db_waits", after.WaitCount-before.WaitCount, "db_wait_time", after.WaitDuration-before.WaitDuration)
		}
	})
}
