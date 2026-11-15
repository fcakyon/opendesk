---
title: Views, labels and saved replies
description: The resources that organize the inbox.
---

| Method | Path | Description |
| --- | --- | --- |
| `GET`, `POST` | `/v1/tags` | List or create labels ([details](/api/resources/labels-fields/)) |
| `GET`, `PATCH`, `DELETE` | `/v1/tags/{id}` | |
| `GET`, `POST` | `/v1/views` | List or create views |
| `GET`, `PATCH`, `DELETE` | `/v1/views/{id}` | |
| `PATCH` | `/v1/view-sections` | Give a view section an icon, or rename it |
| `GET`, `POST` | `/v1/saved-replies` | List or create saved replies |
| `GET`, `PATCH`, `DELETE` | `/v1/saved-replies/{id}` | |

## Objects

```ts
type View = {
  id: string;
  name: string;
  shared: boolean;
  position: number;
  section: string | null; // sidebar heading, at most 60 characters
  icon: {
    kind: "emoji" | "icon" | "text";
    value: string; // the emoji, the icon's name, or one or two letters or digits
    color: LabelColor | null; // tints an icon or text; null for an emoji
  } | null; // null: the default icon
  section_icon: View["icon"]; // its section's icon, the same on every view of the section; null: none
  filters: {
    status?: TicketStatus[];
    priority?: Priority[];
    assignee?: "me" | "none" | string;
    team_id?: string;
    mailbox_id?: string;
    contact_not?: string; // comma-separated contact ids: leaves out their tickets
    company_not?: string; // comma-separated company ids: leaves out their contacts' tickets
    tag?: string;
    channel?: Channel;
    q?: string;
    fields?: { key: string; op: FieldOp; value: string }[]; // custom field filters
  };
};

type SavedReply = { id: string; title: string; shortcut: string; body_html: string; created_at: string; updated_at: string };
```

## Create a view

```sh
curl https://api.opendesk.sh/v1/views \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "OD-Workspace: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Urgent, unassigned", "shared": true, "filters": { "status": ["open"], "priority": ["urgent"], "assignee": "none" } }'
```

`section` groups views under a sidebar heading, matched without regard to case. Spaces collapse; `null` or blank removes the section. A `PATCH` without `section` keeps it.

List tickets in a view with `GET /v1/tickets?view_id=<id>`.

`icon` is written whole: `{ "kind": "emoji", "value": "🔥" }`, `{ "kind": "icon", "value": "truck", "color": "teal" }` or `{ "kind": "text", "value": "PO", "color": "violet" }`. An icon is one of the names the app offers in its picker, the lucide names listed in [`viewIcons.ts`](https://github.com/useopendesk/opendesk/blob/main/web/src/components/tickets/viewIcons.ts); text is one or two letters or digits; `color` is a [label colour](/api/resources/labels-fields/) and is dropped for an emoji. Anything else is `422 validation_failed`. Send `null` to go back to the default icon; a `PATCH` without `icon` keeps it.

## Give a section an icon

```sh
curl -X PATCH https://api.opendesk.sh/v1/view-sections   -H "Authorization: Bearer od_live_..."   -H "Content-Type: application/json"   -d '{ "section": "After sales", "icon": { "kind": "emoji", "value": "⭐" } }'
```

A section's icon shows beside its heading in the sidebar. It belongs to the section's name in the workspace, matched without regard to case: every view that names the section carries it as `section_icon`, and a view moved into the section takes it. It is written like a view's `icon`; `null` clears it. Add `"name"` to rename the section on every view you see in it; the icon goes with it. The answer is `{ "name", "icon", "views" }`, `views` being how many of your views name the section. It needs an admin or a key with `settings:write`, and is `404` when none of your views names the section.

## Create a saved reply

```sh
curl https://api.opendesk.sh/v1/saved-replies \
  -H "Authorization: Bearer od_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "title": "Password reset", "shortcut": "reset", "body_html": "<p>You can reset your password from the sign-in page.</p>" }'
```

`body_html` takes [template variables](/guides/email-templates/variables/). An unknown variable or a tag that does not parse is `422 validation_failed`. To insert a saved reply filled for a ticket, use [`POST /v1/tickets/{id}/render`](/api/resources/templates/#ticket-values).

## Events

`view.*` and `saved_reply.*` (`created`, `updated`, `deleted`). Label events are listed under [Labels and custom fields](/api/resources/labels-fields/#events).

Labels, label groups and custom fields have [their own page](/api/resources/labels-fields/).
