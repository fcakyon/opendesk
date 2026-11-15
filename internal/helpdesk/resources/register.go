// Package resources serves the simple workspace resources: tags, saved replies, views,
// SLA policies and automations.
package resources

import (
	"strings"
	"unicode"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"

	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Register adds this package's routes.
func Register(d *deps.Deps, api huma.API, r chi.Router) {
	registerTags(d, api)
	registerTagGroups(d, api)
	registerCustomFields(d, api)
	registerSavedReplies(d, api)
	registerViews(d, api)
	registerViewSections(d, api)
	registerSLA(d, api)
	registerAutomations(d, api)
	registerRouting(d, api)
}

func op(id, method, path, summary, tag string, status int) huma.Operation {
	return huma.Operation{OperationID: id, Method: method, Path: path, Summary: summary, Tags: []string{tag}, DefaultStatus: status}
}

// cleanName trims a resource name: 1..max runes, single-spaced, no control characters or markup.
func cleanName(field, s string, max int) (string, error) {
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "", httpx.Validation(field + " is required")
	}
	if len([]rune(s)) > max {
		return "", httpx.Validation(field + " is too long")
	}
	for _, r := range s {
		if unicode.IsControl(r) || r == '<' || r == '>' {
			return "", httpx.Validation(field + " contains characters that are not allowed")
		}
	}
	return s, nil
}

// list wraps a full list in the page shape.
func list[T any](rows []T) httpx.Page[T] {
	if rows == nil {
		rows = []T{}
	}
	return httpx.Page[T]{Data: rows}
}
