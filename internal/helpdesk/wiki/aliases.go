package wiki

import (
	"context"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/httpx"
)

// Aliases (contracts/wiki.md "Aliases"): other names a page goes by, as Obsidian's. Links
// and page search find the page by them, unlinked mentions look for them as for its title,
// and search weighs them as its title. Like the page's look, changing them keeps the version
// and adds no revision.
const (
	maxAliases     = 10
	maxAliasLength = 100
)

// cleanAliases folds each alias's whitespace as a title's, drops empty ones and repeats (in
// any case), and refuses more than 10 or one over 100 characters.
func cleanAliases(raw []string) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, a := range raw {
		a = strings.Join(strings.Fields(a), " ")
		if a == "" {
			continue
		}
		if utf8.RuneCountInString(a) > maxAliasLength {
			return nil, httpx.Validation("an alias is at most 100 characters")
		}
		k := strings.ToLower(a)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, a)
	}
	if len(out) > maxAliases {
		return nil, httpx.Validation("a page has at most 10 aliases")
	}
	return out, nil
}

// applyAliases replaces the page's aliases as the patch asks; it reports whether they changed.
func applyAliases(ctx context.Context, tx pgx.Tx, wid, id uuid.UUID, raw *[]string) (bool, error) {
	if raw == nil {
		return false, nil
	}
	next, err := cleanAliases(*raw)
	if err != nil {
		return false, err
	}
	var cur []string
	if err := tx.QueryRow(ctx, `SELECT aliases FROM wiki_pages WHERE workspace_id = $1 AND id = $2`, wid, id).Scan(&cur); err != nil {
		return false, err
	}
	if strings.Join(cur, "\x00") == strings.Join(next, "\x00") {
		return false, nil
	}
	_, err = tx.Exec(ctx, `UPDATE wiki_pages SET aliases = $3 WHERE workspace_id = $1 AND id = $2`, wid, id, next)
	return true, err
}

// pageNames are what a page is called: its title, then its aliases, without empty ones.
func pageNames(title string, aliases []string) []string {
	out := []string{}
	if t := strings.TrimSpace(title); t != "" {
		out = append(out, t)
	}
	for _, a := range aliases {
		if a = strings.TrimSpace(a); a != "" {
			out = append(out, a)
		}
	}
	return out
}

// namedIn is the first of names that text has (any case), or "".
func namedIn(text string, names []string) string {
	lower := strings.ToLower(strings.Join(strings.Fields(text), " "))
	for _, n := range names {
		if strings.Contains(lower, strings.ToLower(n)) {
			return n
		}
	}
	return ""
}

// phraseQuery is a tsquery matching any of names as a phrase, its texts from $first on:
// one phraseto_tsquery per name, joined with ||.
func phraseQuery(names []string, first int) string {
	parts := make([]string, len(names))
	for i := range names {
		parts[i] = "phraseto_tsquery('simple', $" + strconv.Itoa(first+i) + ")"
	}
	return "(" + strings.Join(parts, " || ") + ")"
}
