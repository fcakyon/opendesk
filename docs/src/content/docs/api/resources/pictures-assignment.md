---
title: Pictures, assignment and setup
description: Profile pictures and logos, agent availability, assignment rules, triage, business hours and the setup checklist.
---

| Method | Path | Description |
| --- | --- | --- |
| `PUT`, `DELETE` | `/v1/me/avatar` | Upload or remove your own picture |
| `POST` | `/v1/me/heartbeat` | Mark yourself as seen (204), for auto-away |
| `PATCH` | `/v1/members/{user_id}/availability` | Set availability and the assignment cap. `user_id` may be `me` |
| `PUT`, `DELETE` | `/v1/workspace/images/{slot}` | Workspace logo and brand images (admin) |
| `PUT`, `DELETE` | `/v1/contacts/{id}/avatar` | Upload or remove a contact picture (agent) |
| `PUT`, `DELETE` | `/v1/companies/{id}/avatar` | Upload or remove a company logo (agent) |
| `POST` | `/v1/contacts/{id}/avatar/refresh`, `/v1/companies/{id}/avatar/refresh` | Look the automatic sources up again (202) |
| `GET` | `/v1/images/{id}?s=256\|64` | The processed picture behind every `avatar_url` (public) |
| `GET`, `PATCH` | `/v1/assignment` | Workspace mode, per mailbox and team rules, auto-away, who hears about new unassigned tickets, follow-ups of closed tickets |
| `GET`, `PATCH` | `/v1/triage` | Ollie's triage settings |
| `GET`, `PUT` | `/v1/business-hours` | Opening hours, holidays and timezone |
| `GET` | `/v1/onboarding` | The setup checklist for the current workspace |
| `POST` | `/v1/onboarding/dismiss` | Hide the checklist for yourself (204) |

Reads need any member. Writes to assignment, triage, business hours and workspace images need an admin.

## Objects

```ts
type AvatarSource = "upload" | "oauth" | "gravatar" | "domain" | "widget";

// On User, Member.user, Contact, Company and Workspace. null means no picture: show initials.
avatar_url: string | null;
avatar_source: AvatarSource | null;

type Workspace = {
  // ...
  avatar_url: string | null; // the workspace logo
  avatar_source: "upload" | null;
  images: {
    help_center_logo: string | null;
    help_center_favicon: string | null;
    widget_avatar: string | null;
    widget_launcher: string | null;
  };
};

type Availability = "online" | "away" | "offline";
type Member = {
  // ...
  availability: Availability; // what the member set
  presence: Availability;     // availability, or "away" when auto-away applies
  max_open_tickets: number | null;
  open_tickets: number;
  last_seen_at: string | null;
};

type AssignMode = "none" | "round_robin" | "load_balanced";
type Assignment = {
  mode: AssignMode;
  rules: { target_type: "mailbox" | "team"; target_id: string; mode: AssignMode }[];
  auto_away_minutes: number; // 0 = off, else 10..1440
  new_ticket_notify: "auto" | "everyone" | "leads" | "off"; // who hears about a new unassigned ticket, default auto
  followup_keeps_assignee: boolean; // a customer's follow-up of a closed ticket goes to that ticket's assignee, default false
  chat_mode: AssignMode; // live chats' own rule, default none (chats follow the rules above)
  chat_skill_id: string | null; // the skill a member must hold to be given a chat; null for anyone in the pool
};

type TriageSettings = {
  auto_triage: boolean;
  fields: ("priority" | "severity" | "labels" | "team")[]; // default priority, severity, labels
  assign_after_triage: boolean;
  threshold: number; // 0.5..0.99, default 0.7: confidence at or above it applies a decision, below it leaves a suggestion
  engine: { provider: "typesafe" | "llm" | "none"; model: string; connected: boolean };
  available: boolean; // triage can run: AI or a decision engine is configured, and AI is on for the workspace
};

type BusinessHours = {
  enabled: boolean;
  timezone: string;
  schedule: Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", { start: string; end: string }[]>;
  holidays: { date: string; name: string }[];
};

type Onboarding = {
  steps: { id: string; title: string; description: string; done: boolean; href: string; requires: "admin" | "agent" }[];
  done_count: number;
  total: number;
  dismissed: boolean;
};
```

## Upload a picture

Uploads are `multipart/form-data` with one `file` field: PNG, JPEG, GIF or WebP, at most 5 MB and 4096 px a side.

```sh
curl -X PUT https://api.opendesk.sh/v1/me/avatar \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F file=@me.jpg
```

The response is the updated object. Every picture is decoded, cropped to a square (logos are fitted instead), resized to 256 and 64 px and re-encoded as PNG without metadata. The type is read from the content, not the file name or header.

| Status | Code | When |
| --- | --- | --- |
| 413 | `too_large` | The body is over 5 MB |
| 422 | `unsupported_image` | Not a PNG, JPEG, GIF or WebP image (SVG is refused) |
| 422 | `image_too_large` | Over 4096 px a side or 16 megapixels, or under 16 px |

Workspace slots are `logo`, `help_center_logo`, `help_center_favicon`, `widget_avatar` and `widget_launcher`:

```sh
curl -X PUT https://api.opendesk.sh/v1/workspace/images/help_center_logo \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "OD-Workspace: $WORKSPACE_ID" \
  -F file=@logo.png
```

`PATCH /v1/me` with `{"avatar_url": "https://..."}` copies a picture from a URL instead. It is fetched server-side, and `member.updated` follows when it is ready.

## Serving pictures

`GET /v1/images/{id}` needs no authentication. Ids are random and each image is immutable, so a new picture always gets a new URL. Responses carry `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. Add `?s=64` for the small size.

## Set availability

```sh
curl -X PATCH https://api.opendesk.sh/v1/members/me/availability \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "OD-Workspace: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{ "availability": "away" }'
```

Members set their own `availability`. Admins set anyone's, and `max_open_tickets` (1 to 1000, `null` clears). Viewers are never assigned, so a cap for a viewer is refused with 422.

## Configure assignment

```sh
curl -X PATCH https://api.opendesk.sh/v1/assignment \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "OD-Workspace: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{ "mode": "round_robin", "auto_away_minutes": 30,
        "rules": [{ "target_type": "team", "target_id": "TEAM_ID", "mode": "load_balanced" }] }'
```

`rules` replaces the whole list. `new_ticket_notify` decides who gets the `new_ticket` notification: `auto` (everyone on small teams, the leads on bigger ones), `everyone`, `leads` or `off`. `followup_keeps_assignee: true` gives the new ticket an email opens when it answers a closed ticket to the closed ticket's assignee, while they are still an owner, admin or agent who is not suspended and, for a private team, on that team. The ticket's activity then has an `assigned` entry with `via: "previous_ticket"` and the closed ticket's `previous_ticket_id` and `previous_ticket_number`, both `null` when the closed ticket is in another, private team. `chat_mode` gives live chats their own rule, among the members holding `chat_skill_id` (send `""` to clear it); with the answer bot on, a chat is assigned when the bot hands over. See [Triage and assignment](/guides/triage-and-assignment/) for how a ticket's mode and assignee are chosen.

## Configure triage

```sh
curl -X PATCH https://api.opendesk.sh/v1/triage \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "OD-Workspace: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{ "auto_triage": true, "fields": ["priority", "severity"], "threshold": 0.8, "assign_after_triage": true }'
```

`engine.provider` is `typesafe` when Ollie decides using Jev by TypeSafe, `llm` when the configured AI model decides (no confidence gate), or `none`.

## Set business hours

`PUT` takes the full object. Up to 3 ranges a day on the quarter hour, `24:00` ends a day, and up to 100 holidays.

```sh
curl -X PUT https://api.opendesk.sh/v1/business-hours \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "OD-Workspace: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": true, "timezone": "Europe/Budapest",
        "schedule": { "mon": [{ "start": "09:00", "end": "17:00" }], "tue": [{ "start": "09:00", "end": "17:00" }],
                      "wed": [{ "start": "09:00", "end": "17:00" }], "thu": [{ "start": "09:00", "end": "17:00" }],
                      "fri": [{ "start": "09:00", "end": "13:00" }], "sat": [], "sun": [] },
        "holidays": [{ "date": "2026-12-25", "name": "Christmas" }] }'
```

SLA policies with `business_hours: true` count only open minutes.

## Onboarding

Each step is computed from the workspace's real state, so it is done as soon as the thing exists. Step ids are `connect_mailbox`, `invite_teammate`, `upload_photo`, `install_widget`, `publish_article`, `setup_triage`, `create_label` and `try_ollie`.

## Events

| Event | When |
| --- | --- |
| `member.updated` | A member's picture, availability or cap changed |
| `contact.updated` | A contact's picture changed |
| `company.updated` | A company's logo changed |
| `workspace.updated` | The workspace logo, a brand image or settings changed |

Audit log actions: `user.avatar_updated`, `user.avatar_removed`, `contact.avatar_updated`, `contact.avatar_removed`, `company.avatar_updated`, `company.avatar_removed`, `workspace.image_updated`, `workspace.image_removed`, `member.assignment_cap_changed`, `assignment.updated`, `triage.updated` and `business_hours.updated`.
