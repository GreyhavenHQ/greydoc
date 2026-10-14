// Package permission decides note access. It does no I/O.
package permission

type Level int

const (
	Deny Level = iota
	Read
	// Comment allows reading, commenting and suggesting, but not editing.
	Comment
	Write
	// Full is reserved for the owner: delete, permissions, aliases, agent policy.
	Full
)

var levelNames = []string{"deny", "read", "comment", "write", "full"}

func (l Level) String() string {
	if l < Deny || l > Full {
		return "invalid"
	}
	return levelNames[l]
}

func ParseLevel(s string) (Level, bool) {
	for i, n := range levelNames {
		if n == s {
			return Level(i), true
		}
	}
	return Deny, false
}

func (l Level) MarshalText() ([]byte, error) { return []byte(l.String()), nil }

func (l *Level) UnmarshalText(b []byte) error {
	v, ok := ParseLevel(string(b))
	if !ok {
		return errInvalidLevel
	}
	*l = v
	return nil
}

type levelError string

func (e levelError) Error() string { return string(e) }

const errInvalidLevel = levelError("invalid permission level")

// Input holds every grant that applies to one caller on one note.
type Input struct {
	Local        bool
	IsOwner      bool
	IsRegistered bool
	// MaxGuest caps what a signed-out visitor can get.
	MaxGuest Level
	User     Level
	Everyone Level
	LoggedIn Level
	// Group is the highest grant among the caller's groups.
	Group     Level
	ShareLink bool
}

func Determine(in Input) Level {
	if in.Local || in.IsOwner {
		return Full
	}
	var l Level
	if in.IsRegistered {
		l = max(in.User, in.Everyone, in.LoggedIn, in.Group)
	} else {
		l = min(in.Everyone, in.MaxGuest)
	}
	l = min(l, Write)
	if in.ShareLink {
		l = max(l, Read)
	}
	return l
}

type Policy string

const (
	PolicyNone    Policy = "none"
	PolicyRead    Policy = "read"
	PolicySuggest Policy = "suggest"
	PolicyEdit    Policy = "edit"
)

// AgentLevel caps a user's level when an agent acts for them on a note with the given policy.
func AgentLevel(user Level, p Policy) Level {
	switch p {
	case PolicyRead:
		return min(user, Read)
	case PolicySuggest:
		return min(user, Comment)
	case PolicyEdit:
		return min(user, Write)
	default:
		return Deny
	}
}
