package tickets

import (
	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

// Search is search, for tests that call it as a principal the HTTP harness can't sign in
// (a person acting through an OAuth grant).
var Search = search

// SetSummaryCap lowers the most tickets GET /v1/tickets/summary counts, until the returned
// function puts it back.
func SetSummaryCap(n int) func() {
	old := summaryCap
	summaryCap = n
	return func() { summaryCap = old }
}

// SearchSQL is the query that picks the tickets of GET /v1/tickets?q=, for tests that
// EXPLAIN it.
func SearchSQL(wid uuid.UUID, q string) (string, []any, error) {
	b := &sqlBuilder{}
	err := applyFilters(b, wid, nil, listQuery{TicketFilters: hd.TicketFilters{Q: q}})
	return "SELECT t.id FROM tickets t" + b.sql(), b.args, err
}
