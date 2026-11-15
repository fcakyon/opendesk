package wikiport

import (
	"encoding/json"
	"strings"
)

// splitFrontmatter takes the YAML front matter off a Markdown file: the keys at its top
// level, each with its values (a list's items, or the one value). It reads the shapes
// notes use (plain, quoted and list values); anything else is left out.
func splitFrontmatter(text string) (map[string][]string, string) {
	if !strings.HasPrefix(text, "---\n") {
		return nil, text
	}
	rest := text[4:]
	yaml, body, found := "", "", false
	offset := 0
	for _, l := range strings.SplitAfter(rest, "\n") {
		if t := strings.TrimRight(l, "\n "); t == "---" || t == "..." {
			yaml, body, found = rest[:offset], rest[offset+len(l):], true
			break
		}
		offset += len(l)
	}
	if !found {
		return nil, text
	}
	out := map[string][]string{}
	key := ""
	for _, l := range strings.Split(yaml, "\n") {
		if strings.TrimSpace(l) == "" || strings.HasPrefix(strings.TrimSpace(l), "#") {
			continue
		}
		if l[0] == ' ' || l[0] == '-' {
			t := strings.TrimSpace(l)
			if key != "" && strings.HasPrefix(t, "- ") {
				out[key] = append(out[key], yamlScalar(t[2:]))
			}
			continue
		}
		k, v, ok := strings.Cut(l, ":")
		if !ok {
			key = ""
			continue
		}
		key = strings.ToLower(strings.TrimSpace(k))
		v = strings.TrimSpace(v)
		switch {
		case v == "":
			out[key] = nil
		case strings.HasPrefix(v, "[") && strings.HasSuffix(v, "]"):
			for _, item := range splitFlow(v[1 : len(v)-1]) {
				out[key] = append(out[key], yamlScalar(item))
			}
		default:
			out[key] = []string{yamlScalar(v)}
		}
	}
	return out, body
}

// splitFlow splits a flow list's items on commas outside quotes.
func splitFlow(s string) []string {
	var out []string
	var cur strings.Builder
	quote := byte(0)
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case quote != 0:
			if c == '\\' && quote == '"' && i+1 < len(s) {
				cur.WriteByte(c)
				i++
				c = s[i]
			} else if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == ',':
			if t := strings.TrimSpace(cur.String()); t != "" {
				out = append(out, t)
			}
			cur.Reset()
			continue
		}
		cur.WriteByte(c)
	}
	if t := strings.TrimSpace(cur.String()); t != "" {
		out = append(out, t)
	}
	return out
}

// yamlScalar reads a plain, single- or double-quoted value.
func yamlScalar(v string) string {
	v = strings.TrimSpace(v)
	switch {
	case len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"':
		var s string
		if json.Unmarshal([]byte(v), &s) == nil {
			return s
		}
		return v[1 : len(v)-1]
	case len(v) >= 2 && v[0] == '\'' && v[len(v)-1] == '\'':
		return strings.ReplaceAll(v[1:len(v)-1], "''", "'")
	}
	if i := strings.Index(v, " #"); i >= 0 { // a comment
		v = strings.TrimSpace(v[:i])
	}
	return v
}

// yamlQuote writes a value as a YAML double-quoted string (JSON's escapes are YAML's).
func yamlQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
