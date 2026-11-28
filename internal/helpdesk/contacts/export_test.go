package contacts

import (
	"context"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/deps"
)

// RunImport runs a contact import to its end, as the worker does.
func RunImport(ctx context.Context, d *deps.Deps, id uuid.UUID) error { return runImport(ctx, d, id) }
