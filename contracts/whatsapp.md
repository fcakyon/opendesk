# WhatsApp (`internal/whatsapp`)

A WhatsApp connection links a workspace's WhatsApp Business number to the helpdesk through
Meta's Cloud API. A customer's message opens a ticket on the `whatsapp` channel and lands in
its timeline; an agent's reply goes back out through the same number, as free-form text or
one file. Meta allows a free-form reply for 24 hours after the customer's latest message, so
outside that window the way to write first is an approved message template, synced from the
connection's WhatsApp Business account and sent from the ticket.

This is a customer channel like a mailbox or a phone number, not a support channel
(`contracts/support-channels.md`): those mirror tickets into chat tools where agents work
them, and their engine is built around threads, cards and commands. It is not an integration
(`contracts/integrations.md`) either: those give Ollie tools over MCP. The WhatsApp engine
reuses their patterns (sealed credentials, a verified webhook stored and queued in one
transaction, admin-only connect routes) in a small package of its own; the Meta protocol
lives in `client.go` and the webhook payload in `types.go`.

The cloud and self-host use the same code. There is no plan gate.

## Model and API

```ts
type WhatsAppConnection = { id: string; workspace_id: string; brand_id: string; name: string;
  phone_number_id: string;    // the number's Meta phone number ID
  waba_id: string;            // the WhatsApp Business account ID
  display_phone_number: string; verified_name: string;
  api_version: string;        // the Graph API version; v26.0 by default
  status: "connected" | "error"; last_error: string;
  last_event_at?: string | null;  // the last verified Meta delivery, whatever it held
  webhook_url?: string;           // admins only; a list includes it for the admin role and above
  created_at: string; updated_at: string };
type WhatsAppCredentials = { phone_number_id: string; waba_id: string; access_token: string;
  app_secret: string;       // signs the webhook deliveries
  verify_token?: string;    // the handshake echo; one is generated when empty and kept on update
  api_version?: string };   // the server's default when empty
type WhatsAppConnectBody = { name?: string /* the number's verified name when empty */;
  brand_id?: string /* the workspace's default brand when empty */;
  credentials: WhatsAppCredentials };
type WhatsAppUpdateBody = { name?: string; credentials?: WhatsAppCredentials };
type WhatsAppTemplate = { id: string; connection_id: string; meta_template_id: string;
  name: string; language: string; category: string;
  status: string;             // Meta's: APPROVED, PENDING, REJECTED, ...
  header_type: string;        // "", TEXT, IMAGE, VIDEO, DOCUMENT, ...
  header_content: string; body_content: string; footer_content: string;
  buttons: { type?: string; text?: string; url?: string; [key: string]: unknown }[];
  created_at: string; updated_at: string };
type WhatsAppTemplateSendBody = { template_id: string;
  params?: Record<string, string>;   // one value per body placeholder, by name or number
  header_text?: string;              // the value, not the approved text, of a text header variable
  header_media_id?: string;          // an uploaded attachment for an IMAGE/VIDEO/DOCUMENT header
  button_urls?: Record<string, string> }; // values for URL buttons, by button number
```

An outbound message's `delivery_meta` is the channel's own record of what Meta reported:

```ts
type WhatsAppDeliveryMeta = { provider_status?: "sent" | "delivered" | "read" | "failed";
  provider_status_updated_at?: string; provider_sent_at?: string; provider_failed_at?: string;
  provider_error?: string;       // Meta's safe reason, the text delivery_error also carries
  provider_error_code?: number;  // Meta's error code
  whatsapp_template?: { id?: string; name: string; language: string; body?: string;
    params?: Record<string, string>; header_type?: string; header_text?: string;
    header_attachment_id?: string; button_urls?: Record<string, string> } };
```

`messages.provider_message_id` is Meta's own message id (`wamid`); it ties delivery receipts
to the message they are about. Neither carries anything on an email message.
`messages.delivery_status` stays the coarse state (`pending`, `sent`, `failed`); the
`provider_status` in `delivery_meta` is what the app shows as one tick, two ticks or blue
ticks. A WhatsApp ticket records its conversation in `whatsapp_tickets`: the number the
customer wrote to (`phone_number_id`) and the `wa_id` they wrote from. Replies go to that
`wa_id` through whichever connection holds that number now, so a number disconnected and
connected again keeps its tickets.

```ts
type WhatsAppTicketState = {
  connection_id: string | null;   // the connection that holds the ticket's number now
  connection_name: string; display_phone_number: string;
  window_open: boolean;           // a free-form reply may go out now
  window_closes_at: string | null; // null when the customer never wrote to this number
};
```

| method | path | role | body → response |
| --- | --- | --- | --- |
| GET | `/v1/whatsapp/connections` | viewer, `settings:read` | → `{data: WhatsAppConnection[]}`; `webhook_url` only when the caller's role is admin or above |
| POST | `/v1/whatsapp/connections` | admin user | `{name?, brand_id?, credentials}` → 201 `WhatsAppConnection`; 409 `conflict` when the number is already connected; 422 `whatsapp_credentials_refused`; 422 `validation_failed`, 422 `invalid_name` |
| PATCH | `/v1/whatsapp/connections/{id}` | admin user | `{name?, credentials?}` → `WhatsAppConnection`; an empty body returns it unchanged; 404; 422 `whatsapp_credentials_refused`; 422 `validation_failed` when the credentials name another number; 422 `invalid_name` |
| POST | `/v1/whatsapp/connections/{id}/test` | admin user | checks the credentials with Meta and records the outcome → `WhatsAppConnection`; a refusal is also stored (`status: "error"`, `last_error`) and published; 404; 422 `whatsapp_credentials_refused` |
| POST | `/v1/whatsapp/connections/{id}/subscribe` | admin user | subscribes the Meta app and points the WABA's callback at this connection → `WhatsAppConnection`; 404; 422 `whatsapp_subscribe_refused`; 502 `whatsapp_subscribe_failed` |
| DELETE | `/v1/whatsapp/connections/{id}` | admin user | → 204; its tickets stay; 404 |
| GET | `/v1/whatsapp/hooks/{connection}` | Meta (public) | `hub.mode`, `hub.verify_token`, `hub.challenge` → 200 `text/plain` challenge; 403 wrong mode or token; 404 unknown connection |
| POST | `/v1/whatsapp/hooks/{connection}` | Meta (public, signed) | one raw delivery → 200 `{"status":"ok"}`; 400 a signed body that is not JSON; 401 bad signature; 403 no app secret; 404 unknown connection; 413 body over 1 MiB; 429 rate limited; 500 store failure |
| GET | `/v1/whatsapp/templates` | viewer, `settings:read` | `?connection_id` → `{data: WhatsAppTemplate[]}`; a bad id is 422 `validation_failed`, another workspace's id matches nothing |
| POST | `/v1/whatsapp/templates/sync` | admin user | `{connection_id?}` (optional body; empty syncs every connection) → `{data: WhatsAppTemplate[], synced: number}`; 404 unknown connection; 422 `whatsapp_templates_refused`; 502 `whatsapp_templates_failed` |
| GET | `/v1/tickets/{id}/whatsapp` | viewer, `tickets:read` | → `WhatsAppTicketState`, what the composer shows; 404 (a ticket the caller can't see too); 422 `not_whatsapp_ticket` |
| POST | `/v1/tickets/{id}/messages` | agent, `tickets:write` | the normal message body (`contracts/api.md`); on a WhatsApp ticket a `reply` is a free-form WhatsApp reply and returns 201 `Message` with `delivery_status: "pending"`; 404; 409 `whatsapp_no_conversation`, `whatsapp_disconnected`; 422 `whatsapp_window_closed`; 422 `validation_failed` (more than one file, 4096/1024 limits) |
| POST | `/v1/tickets/{id}/whatsapp-template` | agent, `tickets:write` | `WhatsAppTemplateSendBody` → 201 `Message`; 404 ticket or template; 409 `whatsapp_no_conversation`, `whatsapp_disconnected`; 422 `not_whatsapp_ticket`, `whatsapp_template_not_approved`, `whatsapp_template_params_missing`, `whatsapp_template_header_unsupported`, `whatsapp_template_file_missing`, `whatsapp_template_file_unsupported`, `validation_failed` |

"Admin user" routes need a workspace admin signed in as a person: connecting a number hands
its messages to Meta, so an API key gets `403` (an admin person's OAuth grant with
`settings:write` passes, as its role is the person's). A workspace may have several
connections, one per Meta phone number ID (`(workspace_id, phone_number_id)` is unique);
each owns the brand its tickets belong to, fixed when it connects. Reads take `settings:read`.
The ticket routes are the shared ones, so an API key with `tickets:write` may send a reply.

Errors use the API's usual problem body (`contracts/api.md`) with a stable `code`. The
channel's own codes are `whatsapp_credentials_refused`, `whatsapp_subscribe_refused` and
`whatsapp_templates_refused` (422: Meta refused, the detail is its wording),
`whatsapp_subscribe_failed` and `whatsapp_templates_failed` (502: Meta could not be reached),
`whatsapp_not_configured`, `whatsapp_no_conversation` and `whatsapp_disconnected` (409),
`whatsapp_window_closed`, `not_whatsapp_ticket`, `whatsapp_template_not_approved`,
`whatsapp_template_params_missing`, `whatsapp_template_header_unsupported`,
`whatsapp_template_file_missing` and `whatsapp_template_file_unsupported` (422). Elsewhere the
routes answer `validation_failed` (422), `invalid_name` (422), `conflict` (409), `not_found`
(404) and `forbidden` (403).

### Connections

Connecting checks the credentials at Meta before anything is stored: the number is read with
`GET /{phone_number_id}?fields=display_phone_number,verified_name`, and the WhatsApp Business
account's number list with `GET /{waba_id}/phone_numbers?fields=id&limit=100` must contain
that number (a WABA with more than 100 numbers is not supported by this check). The verified
name names the connection when no name is given, the brand is checked to be the workspace's
(default brand when empty), a verify token is generated when empty (16 random bytes, hex) and
the API version defaults to `v26.0`. The phone number ID and account ID must be digits and
the API version `vN.N`, since all three go into Graph API paths (else 422
`validation_failed`). The credentials are sealed and stored; Meta's refusal is
422 `whatsapp_credentials_refused` with Meta's own wording, and a second connection for the
same number is 409 `conflict`.

An update may rename the connection or replace its credentials for the same phone number
(credentials that name another number are 422 `validation_failed`). Replacement credentials
are checked with Meta first, then stored; the number's display name and verified name are
refreshed, an error state is cleared and the verify token is kept when the input leaves it
empty. `PATCH` with neither name nor credentials returns the connection as it is.

`test` probes the credentials and records the outcome: a success stores the number's display
name and verified name and clears the error, a refusal stores `status: "error"` with Meta's
wording in `last_error` and answers 422 `whatsapp_credentials_refused`. `subscribe` posts to
`/{waba_id}/subscribed_apps` twice: first to subscribe the app, then with
`override_callback_uri` (the connection's `webhook_url`) and `verify_token`, so Meta
delivers that WABA's messages to this connection. A refused subscription is 422
`whatsapp_subscribe_refused` with Meta's wording, a transport failure 502
`whatsapp_subscribe_failed`; neither records a new health state. A connection's
`webhook_url` is the configured API URL followed by `/v1/whatsapp/hooks/{id}`; it carries
no secret.

Deleting a connection removes its inbound events and templates with it. Its tickets and the
customers' windows stay with the number: while it is not connected, a reply or template send
on those tickets is 409 `whatsapp_disconnected`; connecting the same number again (a new
connection, for instance with a new token) picks them up where they were, window included.
To replace the token or app secret without disconnecting, `PATCH` the connection.

## Inbound deliveries

Meta posts every number of an app to the callback configured for the WhatsApp Business
account, so the URL names the connection by its opaque id and nothing else:
`/v1/whatsapp/hooks/{connection}`. `GET` answers Meta's verification handshake: `hub.mode`
must be `subscribe` and `hub.verify_token` must equal the connection's sealed verify token,
compared in constant time; the answer is `hub.challenge` as `text/plain`. A wrong mode or
token is `403`, an unknown or unparseable connection `404`.

`POST` reads the raw body capped at 1 MiB and loads the connection by that id, before a
workspace is known. The request must carry `X-Hub-Signature-256: sha256=<hex>`, the
HMAC-SHA256 of the raw body under the connection's app secret, compared in constant time; a
missing app secret is `403` and a missing or wrong signature `401`. Only then is the body
parsed. A request that names no connection or fails verification counts against its client
address (30 a minute, then that address gets `429` before any work); a verified delivery
counts against its connection (600 a minute), which is far above a busy number and keeps a
flood out of the queue. Nothing in the payload decides the workspace, the ticket or anyone's
access: the connection does, and an id that names no connection adds no limiter keys.

A verified delivery is stored whole, as jsonb like the phone and support channel events, in
`whatsapp_inbound_events`, keyed by the connection and the SHA-256 hex of the raw body, and its
`whatsapp.inbound` job is inserted in the same transaction. A signed body that is not JSON is
refused before it is stored. opendesk answers `200 {"status":"ok"}` at once, also to Meta's retry of a
delivery already stored (that retry is a no-op), so Meta keeps the webhook on; the job does
the work, with up to 10 attempts. Storing it also sets `last_event_at` and clears an error
state (`status: "connected"`, `last_error` empty). Applied deliveries are pruned a week after
receipt. A signed body that is not JSON is a 400 before it is stored, and a stored delivery
whose shape the job cannot parse is logged and dropped; a delivery whose job fails all its
attempts is not re-sent by Meta: the raw body stays until the prune and its messages are
lost.

A delivery for a suspended workspace is acknowledged and dropped: nothing changes tickets and
nothing is sent while the workspace is suspended, as the phone engine does. While the workspace
has Tickets off, the delivery is stored and acknowledged but not applied: the job snoozes until
Tickets is on again (`products.Reactivate` wakes it), as a held phone event does.

A delivery is an envelope of entries and changes; the engine flattens the changes of field
`messages` into customer messages and delivery receipts. A sender's profile name comes from
the change's `contacts` list (a single contact's name also covers a sender the list does not
name). Message kinds:

- `text` is its body; an `interactive` button or list answer is the chosen title; a template's
  quick reply `button` is its text.
- `image`, `video`, `document` and `sticker` carry one media id, MIME type, caption and, for a
  document, filename; `audio` and `voice` carry the media id and MIME type, never a caption.
- `location` becomes its name and address plus a Google Maps link; `contacts` becomes one
  "name phone" line per shared card, in sent order.
- `reaction`, `ephemeral`, `request_welcome` and `system` messages carry nothing the channel
  answers and are ignored. A kind this build does not map opens a message with a
  `[<type>]` placeholder, as the other kinds without text do (`[image]`, `[video]`,
  `[audio]`, `[document]`, `[sticker]`, `[location]`).

The payload's `metadata.phone_number_id` picks the connection: it must be the URL's
connection, else another connection of the same workspace with that number applies the
delivery (Meta may deliver a number of the same app to any connection's callback); a
delivery for a number this instance does not know, or one of another workspace, is
acknowledged and dropped.

### Contacts and tickets

A message's `from` is a `wa_id`, the sender's number in international digits. The engine
matches it to a contact on the contact's phone digits (with or without a `00` prefix, the
most recently updated wins); a new number creates a contact named after the sender's
WhatsApp profile name, else the number, and publishes `contact.created`. A blocked contact's
message opens no ticket and writes no message; the delivery is still stored and
acknowledged.

Every inbound message advances the 24-hour window of that `wa_id` on that number:
`whatsapp_contacts` maps `(workspace_id, phone_number_id, wa_id)` to the contact and stores
the latest `last_inbound_at` (an older message never moves it back) and the latest non-empty
profile name. The window is per number, not per connection or workspace, as Meta's is.

A message goes on the open WhatsApp ticket (open, pending or on hold, most recently active)
of the same conversation, the same `wa_id` writing to the same number; else it opens a
ticket: channel `whatsapp`, the connection's brand, routed like any new ticket
(`routing.Resolve` with channel `whatsapp`, so routing rules can send WhatsApp tickets to a
team), subject the first 80 characters of the text or "WhatsApp message" when it has none,
and its conversation recorded in `whatsapp_tickets`. The ticket is published as
`ticket.created`, and later replies and template sends go out from the number the customer
wrote to, to the `wa_id` they wrote from.

A delivery's messages are applied to the connection whose `phone_number_id` the payload
names, looked up in the URL connection's workspace only; a number that workspace has not
connected is dropped.

The message is stored as a `reply` with direction `inbound`, author the contact, one
attachment at most, delivery status `none`, and the text (`text`, else `caption`, else the
placeholder) cut to 10,000 characters. It moves the ticket forward as any customer reply
does: `last_message_at`, `last_customer_message_at`, `waiting_since`, `unanswered_count`,
a `pending`, `solved` or `on_hold` ticket reopens, `message.created` is published and, on a
ticket this message opened, the `ticket_created` work runs with the message as its body
(auto-triage, SLA policies, new-ticket notifications); a message on an open ticket queues
`customer_replied` instead. Its `created_at` is the customer's own message time, or the
receipt time when it has none.

Meta's retry of a message already applied is recognized by `messages.provider_message_id`
(unique per workspace) and skipped. A retry of a whole delivery is also a no-op at the event
table, so the two together make deliveries idempotent. If one message or receipt of a
delivery fails, the job is retried as a whole; messages applied before the failure are
skipped on the retry and receipts are applied again (idempotently).

### Messages and media

Inbound media is downloaded before the message's transaction: the message's media id is read
from the Graph API, the returned URL must be https on a Meta media host (`graph.facebook.com`
or `fbsbx.com`), and a download follows at most three redirects that stay on those hosts,
with the access token carried along. The file is capped by the message shape: image 5 MiB,
video 16 MiB, audio and voice 16 MiB, document 25 MiB (the WhatsApp cap for documents is
100 MiB, the instance's own attachment cap is 25 MiB and the smaller applies). Its type must
match the message's kind, except a document, which may be any file; its first bytes are
sniffed and an executable is refused. Files are named from a fixed type table (a document
keeps Meta's cleaned filename) and stored as the message's one attachment, unattached until
the message's transaction links it. A file that can never be used (expired media id, too
large, wrong type, executable, empty) is logged and left out, and the placeholder text stays;
a failure that may pass (network, Meta 5xx or a rate limit) returns the job for a retry. When
the transaction leaves no message for the stored file, the object is deleted.

Outbound, a reply carries free-form text or exactly one file. The file is read from the
ticket message's attachment, capped as above, uploaded to the Graph API (image, video, audio
or document by content type) and sent with the reply's text as caption (at most 1,024
characters; audio takes none) and a document's filename. More than one attachment fails the
message with "WhatsApp takes one file per message" (the API refuses it before the message is
written). Meta's `429` and `5xx` are retried; any other refusal fails the message with Meta's
own safe reason.

## The 24-hour window

Meta allows a free-form message for 24 hours after the customer's latest message. Meta's
window also counts a call from the customer, but this channel tracks messages only, so here
only a message opens or extends it. Every new inbound message advances the window; Meta's
retry of one already applied changes nothing, and a customer who never wrote to the number
has no window at all.

A free-form reply (`POST /v1/tickets/{id}/messages` with `kind: "reply"` on a WhatsApp
ticket) is checked when it is written and again when it is sent:

- The ticket needs its conversation (else 409 `whatsapp_no_conversation`, for example a
  ticket created on the `whatsapp` channel through the API) and a connection for its number
  (else 409 `whatsapp_disconnected`).
- A window that has closed is 422 `whatsapp_window_closed`: "The 24-hour WhatsApp reply
  window has closed. Send a template, or wait for the customer to message again."
  The send worker checks the window again, because the job can run seconds later, and fails
  the message with the same words if it closed in between.
- One file at most; a caption of at most 1,024 characters when the reply carries a file,
  else text of at most 4,096 characters.

The reply is stored with delivery status `pending` and the `whatsapp.send` job is queued in
the same transaction, with five attempts. A `direction: "inbound"` message records the
contact's own words and sends nothing; it does not need the window.

An approved template may go out at any time, in or outside the window; the separate route
below is the only way to send one.

## Delivery receipts and send outcomes

A successful send stores Meta's message id in `provider_message_id` and sets
`delivery_status: "sent"`, `delivery_meta.provider_status: "sent"` and
`provider_sent_at`. A delivery receipt (`sent`, `delivered`, `read`, `failed`) updates the
outbound message with that `provider_message_id`: `delivery_meta.provider_status` and
`provider_status_updated_at` always, and on a failure also `provider_error_code` and
`provider_error` (Meta's user-facing text first, then its details, then its message).
`delivery_status` becomes `failed` on a failed receipt and stays `sent` for the rest; once
failed it never changes again. Receipts only move forward, because Meta may deliver them out
of order: `sent`, then `delivered`, then `read`; `failed` replaces `sent` or `delivered` but
never `read`, and a receipt at or below the stored status changes nothing. A receipt of a
kind this channel does not show, or for a message this instance did not send, is ignored. Every applied receipt publishes `message.updated`, which is what moves the tick in
the ticket.

A send that never left, or that the window closed on, is failed: `delivery_status:
"failed"`, `delivery_error` the safe reason (at most 500 characters) and
`delivery_meta.provider_status: "failed"` with `provider_failed_at`. A send is not retried
once it may have reached Meta: only a `429` or `5xx` refusal, which means Meta accepted
nothing, is retried while the job has attempts left (five, free-form and template sends
alike), after which it fails too. A transport
error fails the message rather than retries it, for the same reason.

## Templates

A template's approval happens in Meta's template manager, never in opendesk. The channel
keeps a local copy of what the connection's WhatsApp Business account holds and syncs it on
demand and every six hours:

- A sync reads `GET /{waba_id}/message_templates?limit=100` from the Graph API, following
  Meta's pages (at most 50) and storing every template by `(connection_id, name, language)`:
  Meta's id, name, language, category, status (uppercased), header type and text, body,
  footer and buttons (Meta's own buttons array as JSON). A nameless or languageless template
  is skipped. A failed fetch stores nothing for that connection.
- A workspace sync with no `connection_id` syncs every connection; one connection whose
  token Meta rejects does not stop the others, and the route answers an error only when none
  succeeded. The answer is the templates after the sync and how many were stored.
- `GET /v1/whatsapp/templates` lists the stored copy, all of it or one connection's.
- A `message_template_status_update` delivery is applied as it arrives: the stored row's
  status becomes the event Meta sent (`APPROVED`, `PAUSED`, `REJECTED`, ...), so a template
  Meta paused or rejected stops being offered before the next sync.

Only a template whose stored status is `APPROVED` can be sent, and a send re-reads the row,
so a template Meta paused or rejected after the sync does not go out: the send fails with
"This WhatsApp template is no longer approved at Meta." The row is also re-read for its
name, language, body and header, so what Meta knows is what is sent.

`POST /v1/tickets/{id}/whatsapp-template` sends one template on a WhatsApp ticket:

- The ticket must be visible to the caller and on the `whatsapp` channel (else 422
  `not_whatsapp_ticket`). The template must be in the workspace, belong to the ticket's
  connection and be approved (404, 422 `validation_failed` or 422
  `whatsapp_template_not_approved`). The ticket's connection is the one that holds its number
  now (409 `whatsapp_no_conversation` or `whatsapp_disconnected` as for a reply).
- The template goes to the `wa_id` of the ticket's conversation.
- `params` fills the body's placeholders by name or number: at most 50 values, each at most
  1,024 characters, and every placeholder the body names must have a non-empty value (else
  422 `whatsapp_template_params_missing`). Extra keys are ignored.
- A `TEXT` header with a variable takes `header_text` (the value, never the approved text),
  at most 60 characters; a static header takes none. An `IMAGE`, `VIDEO` or `DOCUMENT`
  header takes `header_media_id`: the caller's own upload that no message holds yet (as
  `attachment_ids` on a reply), which the template reply then holds, or a file already on one
  of this ticket's messages. Any other file is 422 `whatsapp_template_file_missing`, so a
  file of a private team's ticket, a Collab message or another member's upload never goes out
  through a template. It must match the header's shape and stay inside its cap (image 5 MiB,
  video 16 MiB, document 25 MiB, else 422 `whatsapp_template_file_unsupported`). The send
  reads the file again, only from a message of this ticket. A header this channel cannot fill (for
  example a location header) is 422 `whatsapp_template_header_unsupported`.
- `button_urls` fills the URL buttons whose URL has a variable, keyed by the button's index
  in the template's buttons array: exactly those buttons, non-empty, at most 2,000
  characters each (422 `whatsapp_template_params_missing` for missing; 422
  `validation_failed` for a bad key or too long a value).
- The message's text is the template's body with the values filled in, so the timeline shows
  what the customer gets (this copy is filled here for display only; Meta fills the message
  the customer receives from its own approved template, so it is not customer-facing text
  in the `internal/templates` sense), and `delivery_meta.whatsapp_template` keeps the template's name,
  language, raw body, values, header and button values for the send. The message is stored
  as a pending reply and the `whatsapp.send` job is queued in the same transaction, without a
  window check.

The send re-reads the template, uploads a media header's file to the Graph API, and builds
Meta's components: the header (a text value, or the uploaded image, video or document), the
body's parameters in the order the placeholders appear, and the URL button values by button
index. A text header's variable and the body's variables are numbered separately at Meta, so
the send carries the header value under a placeholder the body does not use. A transient
Meta error (`429` or `5xx`) is retried, and its count is kept in
`delivery_meta.template_send_attempts` because the send helper is handed the message, not the
job; after five attempts, or on any other refusal, the message fails with the safe reason.
The file's type and size are checked again from the stored attachment row at send time,
because the file may change after the API checked it.

## Jobs and schedules

| job | when | retries |
| --- | --- | --- |
| `whatsapp.inbound` | one stored delivery, inserted in the webhook's transaction | 10 attempts |
| `whatsapp.send` | one outbound reply or template, inserted in the message's transaction | 5 attempts |
| `whatsapp.prune` | every 6 hours, global | deletes applied deliveries older than a week |
| `whatsapp.template_sync` | every 6 hours, every connection | refreshes the stored templates; failures stay on the connection |

`whatsapp.prune` and `whatsapp.template_sync` are global periodic jobs; the first deletes
`whatsapp_inbound_events` rows received more than seven days ago, whatever their connection,
and the second loops over every connection in every workspace exactly as an admin sync does,
skipping a suspended workspace's connections.

## Events and audit

The package publishes three events, to admins only (`events.Event.Admins`, so an API key and
a non-admin member never receive them), as the phone engine does:

- `whatsapp_connection.created` `{whatsapp_connection}`: a connection was created.
- `whatsapp_connection.updated` `{whatsapp_connection}`: a rename, replaced credentials, or
  the outcome of a test or webhook subscription (also when it records an error). The payload
  is the connection view the API returns, `webhook_url` included, and never credentials.
- `whatsapp_connection.deleted` `{whatsapp_connection_id}`.

Outside the package, the shared ticket paths publish the usual `ticket.created`,
`message.created` and `contact.created`; a delivery receipt publishes `message.updated` for
the outbound message it is about.

Audit entries, recorded in the same transaction as the change, with the acting person:

- `whatsapp.connected` on a new connection, with `phone_number_id`.
- `whatsapp.updated` on a rename or a credentials replacement, with `name` and/or
  `credentials: "replaced"`.
- `whatsapp.disconnected` on a disconnect, with `phone_number_id`.

Testing a connection, subscribing its webhook, syncing templates and sending a message record
no audit entry of their own; the first two only publish `whatsapp_connection.updated`.

## Security and invariants

- The connection's credentials (access token, app secret and verify token) are AES-GCM
  sealed with `d.Box` in `whatsapp_connections.credentials_enc`, registered in
  `internal/sealed` so a key rotation re-encrypts them. API responses, events, errors and
  logs never include them: the connection view has no credential field, and a refused
  credential's text is Meta's own wording, clipped to 300 characters.
- The access token is sent only in the Graph API's `Authorization` header, never in a URL,
  an error or a log line; the client's URLs are built from constants and ids, and transport
  errors drop the URL. Media downloads are restricted to https URLs on Meta's media hosts.
- The webhook is public and found by an opaque connection id, body-capped, and verified with
  the app secret before the body is parsed. A wrong signature stores nothing and changes
  nothing; a retry of a stored delivery changes nothing.
- The verify token is a bearer secret in the handshake query; the connection is loaded by id,
  never by workspace, and the token is compared in constant time. The bundled Caddy deletes
  `hub.verify_token` from its access log beside the other one-time values. A delivery's
  contents can choose another connection only when it carries that connection's phone number
  ID and that connection is in the same workspace as the URL's connection.
- The workspace is the connection's, for every read and write: the API scopes every lookup by
  workspace (another workspace's connection, template or ticket is a 404), and the job writes
  in the workspace of the verified delivery's connection.
- Credential inputs are bounded before they are sealed or sent to Meta: the phone number ID
  and WABA id to 64 characters, the access token to 1,000, the app secret to 200, the verify
  token to 200 and the API version to 32. An empty verify token gets a new 32-character hex
  one on create; on a credentials update an empty one keeps the connection's.
- Connect, update, test, subscribe and disconnect need a person with the admin role;
  API keys get `403`. Reading the list and the templates needs `settings:read`, and the
  `webhook_url` in a list response only reaches a caller with the admin role or above.
- Graph API clients have a 15-second timeout and do not follow redirects; only the media
  downloader follows redirects (at most three, on Meta's media hosts, with the token
  forwarded there). Base URLs are constants, never user input.
- Logs carry ids, event names and errors, never numbers, names, message content or
  credentials.
- The stored delivery holds the customer's messages and media ids for at most a week, then
  the prune deletes it.

## Migrations

- `000781_whatsapp` creates `whatsapp_connections` (one row per number, unique by
  `(workspace_id, phone_number_id)`, sealed `credentials_enc`, status and last error, the
  brand it opens tickets for), `whatsapp_inbound_events` (one verified delivery's jsonb body,
  unique by `(connection_id, external_event_id)`, cascade with the connection) and
  `whatsapp_contacts` (a `wa_id` writing to one of the workspace's numbers, its contact and
  the 24-hour window's `last_inbound_at`, primary key `(workspace_id, phone_number_id,
  wa_id)`, cascade with the workspace and the contact; a contact merge moves it) and
  `whatsapp_tickets` (a WhatsApp ticket's number and `wa_id`, cascade with the ticket). It also adds `messages.provider_message_id` and `messages.delivery_meta` and
  a unique index on `(workspace_id, provider_message_id)` where the id is set.
- `000782_whatsapp_channel` replaces the `tickets_channel_check` constraint so a ticket may
  be on the `whatsapp` channel beside email, chat, api, portal and phone. Its down migration
  restores the five channels and fails while a WhatsApp ticket exists, so those are resolved
  first.
- `000783_whatsapp_templates` creates `whatsapp_templates`, the local copy of Meta's
  templates: workspace and connection (both cascade), Meta's template id, name, language,
  category, status, header type, header content, body, footer and buttons (JSON), unique by
  `(connection_id, name, language)`, with a workspace index.

Tickets keep WhatsApp messages as `messages` rows, so a deleted ticket keeps its messages and
a deleted connection keeps the tickets its messages opened: the connection's own rows cascade,
the tickets and windows do not. A deleted contact clears `contact_id` on the messages, and
its window rows go.

## Limits and caveats

- A template is created, edited and approved in Meta's template manager. opendesk only reads
  it and sends it, and never changes Meta's copy.
- A template status delivery Meta sends for a template this instance does not hold is
  acknowledged and changes nothing.
- An inbound document over 25 MiB is dropped (the instance's attachment cap), though Meta
  accepts 100 MiB; the message keeps its placeholder.
- One file per message. An audio reply carries no caption, so text written with an audio
  file is not sent; text alone or one image, video or document is.
- A message's quoted context (`context.id`) is parsed but not stored, so replies are not
  threaded to the message they answer.
- A `system` message is ignored, so a customer's number change is not applied to the
  contact; a new number makes a new contact.
- A sticker is stored as an image (Meta serves it as WebP).
- opendesk does not send read receipts to the customer. Delivery receipts for opendesk's own
  messages are read and shown.
- An API version of the right shape that Meta does not know fails at Meta and shows as
  `whatsapp_credentials_refused` on connect or test.
- A test, a subscribe or a verified delivery can clear a connection's error state, and a
  refused subscription leaves the connection's status as it was.
- `last_event_at` moves for any verified delivery, including one that only carries a template
  review result.
- A connection's brand is fixed at connect; changing it means disconnecting and connecting
  again.
- The phone number ID is unique per workspace, not globally; Meta itself ensures a number
  belongs to one app.
- A customer who writes to two of the workspace's numbers has a ticket on each: a ticket is
  one conversation with one number, and its replies always leave from that number.
- A receipt that arrives before the send recorded Meta's message id finds no message and is
  dropped; Meta sends its receipts after it answered the send, so this is rare.
- Sending needs no person: an API key with `tickets:write` may reply and send templates.
- The default Graph API version is `v26.0`, and a connection may name another one. A number
  starts receiving deliveries only once its WhatsApp Business account is subscribed to the
  app, which the subscribe route does by pointing the WABA's callback at the connection's
  URL with its verify token; an admin may also set those at Meta by hand.

## Not yet

Creating, editing or approving templates in opendesk, quoted replies and message context,
read receipts to customers,
sending interactive messages, WhatsApp Flows or orders, more than one file per message,
contact number-change sync, and inbound kinds beyond the ones above.
