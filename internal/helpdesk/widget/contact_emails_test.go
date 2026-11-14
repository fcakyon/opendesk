package widget_test

import "testing"

// An address a visitor types never links to a contact, and one a contact holds as an extra
// address is no exception: the visitor starts as a contact of their own.
func TestSessionWithAnExtraAddressOfAContact(t *testing.T) {
	e, ws := setup(t)
	e.Exec(`WITH c AS (INSERT INTO contacts (workspace_id, email, name) VALUES ($1, 'owner@work.example', 'Owner') RETURNING id)
		INSERT INTO contact_emails (workspace_id, contact_id, email) SELECT $1, id, 'owner@home.example' FROM c`, ws.ID)
	s := start(t, e, map[string]any{"key": ws.WidgetKey, "email": "Owner@Home.Example"})
	var email *string
	var widgetEmail string
	e.Scalar(`SELECT email FROM contacts WHERE id = $1`, &email, s.Contact.ID)
	e.Scalar(`SELECT coalesce(custom->>'widget_email', '') FROM contacts WHERE id = $1`, &widgetEmail, s.Contact.ID)
	if email != nil || widgetEmail != "owner@home.example" {
		t.Fatalf("the visitor took the address: email=%v widget_email=%q", email, widgetEmail)
	}
}
