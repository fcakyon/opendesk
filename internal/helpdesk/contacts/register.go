// Package contacts serves contacts and companies.
package contacts

import (
	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"

	"github.com/useopendesk/opendesk/internal/deps"
)

// Register adds the contact and company routes.
func Register(d *deps.Deps, api huma.API, r chi.Router) {
	registerContacts(d, api)
	registerEmails(d, api)
	registerMerge(d, api)
	registerCompanies(d, api)
	registerBulk(d, api)
	registerAvatars(d, api)
	InstallImageHooks()
}

func op(id, method, path, summary, tag string, status int) huma.Operation {
	return huma.Operation{OperationID: id, Method: method, Path: path, Summary: summary, Tags: []string{tag}, DefaultStatus: status}
}
