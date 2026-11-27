package whatsapp

import (
	"context"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// SetGraphURL points the engine at a fake Graph API.
func (s *Service) SetGraphURL(u string) { s.graphURL = u }

// Install makes s the engine For(d) answers, so the ticket routes reach a test's fake Meta.
func Install(d *deps.Deps, s *Service) { services.Store(d, s) }

// ProcessInbound runs the inbound job's work, which the tests drive in place of the queue.
func (s *Service) ProcessInbound(ctx context.Context, a jobs.WhatsAppInboundArgs) error {
	return (&inboundWorker{s: s}).Work(ctx, &river.Job[jobs.WhatsAppInboundArgs]{Args: a})
}

// Send runs the send job's work as its last attempt, so a refusal fails the message.
func (s *Service) Send(ctx context.Context, a jobs.WhatsAppSendArgs) error {
	job := &river.Job[jobs.WhatsAppSendArgs]{Args: a}
	job.JobRow = &rivertype.JobRow{Attempt: jobs.WhatsAppSendAttempts, MaxAttempts: jobs.WhatsAppSendAttempts}
	return (&sendWorker{s: s}).Work(ctx, job)
}
