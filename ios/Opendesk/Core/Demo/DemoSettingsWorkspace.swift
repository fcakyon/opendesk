#if DEBUG
import Foundation

/// The Workspace settings group in demo mode: General, Members and invitations, Teams,
/// Plan and billing, AI and Integrations, in the shapes of contracts/api.md. Members and
/// teams stay in `ws.members` / `ws.teams` so every other screen sees the change, and each
/// change publishes the event a server would.
struct DemoWorkspaceSettings: Sendable {
    /// The workspace's whole `settings` object, as `PATCH /v1/workspace` merges it.
    var settings: [String: JSONValue] = [:]
    var images: [String: String] = [:]
    var joined: [String: Date] = [:]
    var deleteRules: [String: String] = [:]
    var invitations: [DemoInvitation] = []
    var teams: [String: DemoTeamExtra] = [:]
    var billing: [String: JSONValue] = [:]
    var ai: [String: JSONValue] = [:]
    var assistantAuto: [String] = []
    var providerKey: JSONValue?
    var integrations: [JSONValue] = []

    static func seed(_ ws: DemoWorkspace) -> DemoWorkspaceSettings {
        var seed = DemoWorkspaceSettings()
        let margin = ws.id == DemoSeed.marginID
        var settings = (DemoSeed.json(ws.workspace.settings).object ?? [:]).filter { !$0.value.isNull }
        let extras: [String: JSONValue] = [
            "tickets_enabled": .bool(true), "mail_enabled": .bool(true), "pages_enabled": .bool(true), "locale": .string("en"), "locale_fixed": .bool(false),
            "help_center_enabled": .bool(true), "help_center_title": .string(margin ? "Margin help" : ""),
            "csat_enabled": .bool(margin), "undo_send_seconds": .number(5), "undo_send_chat_seconds": .number(0),
            "message_delete": .string("own"), "gravatar": .bool(false), "domain_logos": .bool(true),
            "agent_online_time": .bool(true), "severity_enabled": .bool(true), "label_creation": .string("anyone"),
            "auto_assign": .string(margin ? "round_robin" : "none"),
        ]
        for (key, value) in extras where settings[key] == nil { settings[key] = value }
        seed.settings = settings

        for (index, member) in ws.members.enumerated() {
            seed.joined[member.id] = DemoSeed.ago(Double(400 - index * 37) * 1440)
        }

        guard margin else {
            seed.billing = [
                "plan": .string("free"), "billing_enabled": .bool(true), "status": .string("none"),
                "seats": .number(0), "billed_seats": .number(0), "cancel_at_period_end": .bool(false),
                "limits": .object(["max_mailboxes": .number(1), "max_members": .number(3)]),
                "usage": .object(["mailboxes": .number(1), "members": .number(Double(ws.members.count))]),
                "ai": .object(["unlimited": .bool(false), "monthly_usd": .number(1), "used_usd": .number(0.84), "purchased_usd": .number(0), "remaining_usd": .number(0.16)]),
            ]
            seed.ai = [
                "enabled": .bool(true), "auto_triage": .bool(false), "auto_summarize": .bool(false), "widget_answers": .bool(false),
                "assistant": .bool(true), "assistant_peer": .bool(false), "draft_tools": .bool(true),
                "tone": .string("professional"), "reply_language": .string("customer"), "instructions": .string(""),
                "model": .string(""), "fast_model": .string(""),
            ]
            return seed
        }

        seed.deleteRules[DemoPerson.priya.id] = "all"
        let maya = UserRef(id: DemoPerson.maya.id, name: DemoPerson.maya.name, email: DemoPerson.maya.email, avatarURL: nil)
        let jonas = UserRef(id: DemoPerson.jonas.id, name: DemoPerson.jonas.name, email: DemoPerson.jonas.email, avatarURL: nil)
        seed.invitations = [
            DemoInvitation(id: demoID(.made, 9001), email: "dana" + "@" + "margin.app", role: .agent, createdAt: DemoSeed.ago(2 * 1440), expiresAt: DemoSeed.ago(-5 * 1440), invitedBy: maya),
            DemoInvitation(id: demoID(.made, 9002), email: "felix.ward" + "@" + "contractors.example", role: .viewer, createdAt: DemoSeed.ago(9 * 1440), expiresAt: DemoSeed.ago(2 * 1440), invitedBy: jonas),
        ]
        seed.teams = [
            DemoSeed.support: DemoTeamExtra(
                description: "First line for every customer question", color: "blue", isPrivate: false,
                roles: [DemoPerson.maya.id: "lead", DemoPerson.theo.id: "observer"],
                signatureHTML: "<p>The Margin support team</p>", hours: nil, assignMode: nil
            ),
            DemoSeed.billing: DemoTeamExtra(
                description: "Invoices, plans, refunds and VAT", color: "amber", isPrivate: false,
                roles: [DemoPerson.lea.id: "lead"], signatureHTML: "",
                hours: DemoTeamExtra.hours(timezone: "Europe/Berlin", start: "08:00", end: "16:00"), assignMode: "load_balanced"
            ),
            DemoSeed.partnerships: DemoTeamExtra(
                description: "Resellers, agencies and integration partners", color: "violet", isPrivate: true,
                roles: [DemoPerson.sam.id: "lead"], signatureHTML: "", hours: nil, assignMode: "none"
            ),
        ]
        let periodEnd = DemoSeed.ago(-18 * 1440).ISO8601Format()
        seed.billing = [
            "plan": .string("pro"), "billing_enabled": .bool(true), "status": .string("active"),
            "seats": .number(6), "billed_seats": .number(6),
            "current_period_end": .string(periodEnd), "cancel_at_period_end": .bool(false),
            "limits": .object(["max_mailboxes": .number(0), "max_members": .number(0)]),
            "usage": .object(["mailboxes": .number(2), "members": .number(Double(ws.members.count))]),
            "ai": .object([
                "unlimited": .bool(false), "monthly_usd": .number(30), "used_usd": .number(11.42),
                "purchased_usd": .number(10), "remaining_usd": .number(28.58), "period_end": .string(periodEnd),
            ]),
        ]
        seed.ai = [
            "enabled": .bool(true), "auto_triage": .bool(true), "auto_summarize": .bool(true), "widget_answers": .bool(true),
            "assistant": .bool(true), "assistant_peer": .bool(true), "draft_tools": .bool(true),
            "tone": .string("friendly"), "reply_language": .string("customer"),
            "instructions": .string("Sign off with the team's name. Link to the help center when an article answers the question."),
            "model": .string(""), "fast_model": .string(""),
        ]
        seed.assistantAuto = ["update_ticket", "add_note", "create_view"]
        seed.integrations = [
            integration(
                id: demoID(.made, 9101), provider: "linear", name: "Linear", host: "mcp.linear.app", auth: "oauth", status: "connected",
                tools: [
                    DemoTool("search_issues", "Search issues", "Find issues by text, team or state.", read: true),
                    DemoTool("get_issue", "Get an issue", "Read one issue with its comments.", read: true),
                    DemoTool("create_issue", "Create an issue", "File a new issue in a team."),
                    DemoTool("add_comment", "Comment on an issue", "Add a comment to an issue.", auto: true),
                ]
            ),
            integration(
                id: demoID(.made, 9102), provider: "stripe", name: "Stripe", host: "mcp.stripe.com", auth: "token", status: "connected",
                tools: [
                    DemoTool("list_customers", "Find a customer", "Look up customers by email.", read: true),
                    DemoTool("list_invoices", "List invoices", "A customer's invoices and their status.", read: true, ask: true),
                    DemoTool("create_refund", "Refund a payment", "Refund all or part of a charge."),
                ]
            ),
            integration(
                id: demoID(.made, 9103), provider: "notion", name: "Notion", host: "mcp.notion.com", auth: "oauth", status: "error",
                lastError: "The sign-in expired. Sign in again to keep using it.", tools: []
            ),
        ]
        return seed
    }

    struct DemoTool {
        var name: String
        var title: String
        var description: String
        var read = false
        var ask = false
        var auto = false

        init(_ name: String, _ title: String, _ description: String, read: Bool = false, ask: Bool = false, auto: Bool = false) {
            self.name = name
            self.title = title
            self.description = description
            self.read = read
            self.ask = ask
            self.auto = auto
        }
    }

    static func integration(id: String, provider: String, name: String, host: String, auth: String, status: String, lastError: String = "", tools: [DemoTool]) -> JSONValue {
        .object([
            "id": .string(id), "provider": .string(provider), "name": .string(name), "host": .string(host),
            "auth_type": .string(auth), "status": .string(status), "enabled": .bool(true), "last_error": .string(lastError),
            "synced_at": .string(DemoSeed.ago(90).ISO8601Format()),
            "tools": .array(tools.map { tool in
                .object([
                    "name": .string(tool.name), "title": .string(tool.title), "description": .string(tool.description),
                    "read_only": .bool(tool.read), "ask_first": .bool(tool.ask), "auto_run": .bool(tool.auto), "enabled": .bool(true),
                ])
            }),
        ])
    }
}

struct DemoInvitation: Sendable {
    var id: String
    var email: String
    var role: Role
    var createdAt: Date
    var expiresAt: Date
    var invitedBy: UserRef

    var json: JSONValue {
        .object([
            "id": .string(id), "email": .string(email), "role": .string(role.rawValue),
            "created_at": .string(createdAt.ISO8601Format()), "expires_at": .string(expiresAt.ISO8601Format()),
            "invited_by": DemoSeed.json(invitedBy),
        ])
    }
}

struct DemoTeamExtra: Sendable {
    var description = ""
    var color = "gray"
    var isPrivate = false
    var roles: [String: String] = [:]
    var signatureHTML = ""
    var hours: JSONValue?
    var assignMode: String?

    static func hours(timezone: String, start: String, end: String) -> JSONValue {
        var schedule: [String: JSONValue] = [:]
        for day in ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] {
            schedule[day] = day == "sat" || day == "sun" ? .array([]) : .array([.object(["start": .string(start), "end": .string(end)])])
        }
        return .object(["enabled": .bool(true), "timezone": .string(timezone), "schedule": .object(schedule), "holidays": .array([])])
    }
}

extension DemoBackend {
    func workspaceSettingsRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        if let answer = try wsGeneralRoutes(call, in: &ws) { return answer }
        if let answer = try wsMemberRoutes(call, in: &ws) { return answer }
        if let answer = try wsTeamRoutes(call, in: &ws) { return answer }
        if let answer = try wsBillingRoutes(call, in: &ws) { return answer }
        if let answer = try wsAIRoutes(call, in: &ws) { return answer }
        if let answer = try wsIntegrationRoutes(call, in: &ws) { return answer }
        return nil
    }

    private func wsRequireAdmin(_ ws: DemoWorkspace) throws {
        guard ws.role.isAdmin else { throw Failure(status: 403, code: "forbidden", detail: "Only admins can change this.") }
    }

    // MARK: General

    private func wsWorkspaceJSON(_ ws: DemoWorkspace) -> JSONValue {
        let extra = ws.settings.workspace
        var images: [String: JSONValue] = [:]
        for (slot, url) in extra.images { images[slot] = .string(url) }
        return .object([
            "id": .string(ws.id), "name": .string(ws.workspace.name), "slug": .string(ws.workspace.slug ?? ""),
            "avatar_url": ws.workspace.avatarURL.map(JSONValue.string) ?? .null,
            "settings": .object(extra.settings), "images": .object(images),
        ])
    }

    /// The typed settings every other screen reads, after the raw ones changed.
    private func wsSyncWorkspace(_ ws: inout DemoWorkspace) {
        if let typed = try? APICoding.decoder.decode(WorkspaceSettings.self, from: encode(JSONValue.object(ws.settings.workspace.settings))) {
            ws.workspace.settings = typed
        }
        publish("workspace.updated", ["workspace": wsWorkspaceJSON(ws)], in: &ws)
    }

    private func wsGeneralRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        if call.match("GET", "workspace") != nil { return .some(encode(wsWorkspaceJSON(ws))) }
        if call.match("PATCH", "workspace") != nil {
            try wsRequireAdmin(ws)
            if let name = call.string("name") {
                let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { throw Failure(status: 422, code: "validation_failed", detail: "Give the workspace a name.") }
                ws.workspace.name = String(trimmed.prefix(80))
            }
            if let patch = call.body["settings"]?.object {
                if let color = patch["brand_color"]?.string, !color.isEmpty, color.count != 7 || !color.hasPrefix("#") {
                    throw Failure(status: 422, code: "validation_failed", detail: "Use a hex colour like #0A0A0A.")
                }
                for (key, value) in patch { ws.settings.workspace.settings[key] = value }
            }
            wsSyncWorkspace(&ws)
            return .some(encode(wsWorkspaceJSON(ws)))
        }
        if let slot = call.match("PUT", "workspace/images/*")?.first {
            try wsRequireAdmin(ws)
            guard let url = wsSaveUpload(call.raw) else { throw Failure(status: 422, code: "invalid_image", detail: "That image couldn't be read.") }
            if slot == "logo" { ws.workspace.avatarURL = url } else { ws.settings.workspace.images[slot] = url }
            wsSyncWorkspace(&ws)
            return .some(encode(wsWorkspaceJSON(ws)))
        }
        if let slot = call.match("DELETE", "workspace/images/*")?.first {
            try wsRequireAdmin(ws)
            if slot == "logo" { ws.workspace.avatarURL = nil } else { ws.settings.workspace.images[slot] = nil }
            wsSyncWorkspace(&ws)
            return .some(encode(wsWorkspaceJSON(ws)))
        }
        if call.match("POST", "workspace/transfer") != nil {
            guard ws.role == .owner else { throw Failure(status: 403, code: "forbidden", detail: "Only the owner can transfer the workspace.") }
            guard let target = call.string("user_id"), target != world.user.id, let to = ws.members.firstIndex(where: { $0.id == target }) else { throw notFound("member") }
            guard ws.members[to].role != .viewer else { throw Failure(status: 422, code: "validation_failed", detail: "Make them an agent or admin first.") }
            ws.members[to].role = .owner
            if let mine = ws.members.firstIndex(where: { $0.id == world.user.id }) {
                ws.members[mine].role = .admin
                publish("member.updated", ["member": wsMemberJSON(ws.members[mine], in: ws)], in: &ws)
            }
            ws.role = .admin
            publish("member.updated", ["member": wsMemberJSON(ws.members[to], in: ws)], in: &ws)
            return .some(nil)
        }
        if call.match("DELETE", "workspace") != nil {
            guard ws.role == .owner else { throw Failure(status: 403, code: "forbidden", detail: "Only the owner can delete the workspace.") }
            guard call.string("confirm_name") == ws.workspace.name else { throw Failure(status: 422, code: "validation_failed", detail: "Type the workspace's name to confirm.") }
            throw Failure(status: 409, code: "demo", detail: "The demo keeps its workspaces. On a real workspace this deletes everything in it.")
        }
        return nil
    }

    /// The image part of a multipart upload, kept as a file for the run.
    private func wsSaveUpload(_ raw: Data) -> String? {
        guard let head = raw.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        var body = raw[head.upperBound...]
        if let tail = body.range(of: Data("\r\n--".utf8), options: .backwards) { body = body[..<tail.lowerBound] }
        guard !body.isEmpty else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("demo-\(made()).jpg")
        do {
            try Data(body).write(to: url)
            return url.absoluteString
        } catch {
            return nil
        }
    }

    // MARK: Members and invitations

    private func wsMemberJSON(_ member: Member, in ws: DemoWorkspace) -> JSONValue {
        var member = member
        member.openTickets = ws.tickets.filter { !$0.spam && !$0.status.isDone && $0.assignee?.id == member.id }.count
        var object = DemoSeed.json(member).object ?? [:]
        object["profile"] = DemoSeed.json(ws.accountExtras.profiles[member.id] ?? .empty)
        object["created_at"] = ws.settings.workspace.joined[member.id].map { .string($0.ISO8601Format()) } ?? .null
        object["message_delete"] = ws.settings.workspace.deleteRules[member.id].map(JSONValue.string) ?? .null
        return .object(object)
    }

    private func wsMemberRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        let myRole = ws.role
        if call.match("GET", "members") != nil {
            return .some(encode(ListBody(data: ws.members.map { wsMemberJSON($0, in: ws) })))
        }
        if let id = call.match("PATCH", "members/*")?.first, id != "me" {
            try wsRequireAdmin(ws)
            guard let index = ws.members.firstIndex(where: { $0.id == id }) else { throw notFound("member") }
            guard id != world.user.id else { throw Failure(status: 422, code: "validation_failed", detail: "You can't change your own role.") }
            let target = ws.members[index].role
            guard let role = call.string("role").flatMap(Role.init(rawValue:)), role != .owner else {
                throw Failure(status: 422, code: "validation_failed", detail: "Choose admin, agent or viewer.")
            }
            let allowed = target != .owner && (myRole == .owner || ((target == .agent || target == .viewer) && role != .admin))
            guard allowed else { throw Failure(status: 403, code: "forbidden", detail: "Only the owner can change an admin's role or make someone an admin.") }
            ws.members[index].role = role
            if role != .agent { ws.settings.workspace.deleteRules[id] = nil }
            publish("member.updated", ["member": wsMemberJSON(ws.members[index], in: ws)], in: &ws)
            return .some(encode(wsMemberJSON(ws.members[index], in: ws)))
        }
        if let id = call.match("PATCH", "members/*/permissions")?.first {
            try wsRequireAdmin(ws)
            guard let index = ws.members.firstIndex(where: { $0.id == id }) else { throw notFound("member") }
            guard ws.members[index].role == .agent else { throw Failure(status: 422, code: "validation_failed", detail: "Only agents take their own rule.") }
            let rule = call.string("message_delete") ?? "default"
            guard ["default", "off", "own", "all"].contains(rule) else { throw Failure(status: 422, code: "validation_failed", detail: "Choose default, off, own or all.") }
            ws.settings.workspace.deleteRules[id] = rule == "default" ? nil : rule
            publish("member.updated", ["member": wsMemberJSON(ws.members[index], in: ws)], in: &ws)
            return .some(encode(wsMemberJSON(ws.members[index], in: ws)))
        }
        if let id = call.match("PATCH", "members/*/profile")?.first, id != "me" {
            guard let index = ws.members.firstIndex(where: { $0.id == id }) else { throw notFound("member") }
            let target = ws.members[index].role
            let allowed = id == world.user.id || myRole == .owner || (myRole == .admin && (target == .agent || target == .viewer))
            guard allowed else { throw Failure(status: 403, code: "forbidden", detail: "You can't change this member's profile.") }
            var profile = ws.accountExtras.profiles[id] ?? .empty
            if let value = call.string("title") { profile.title = String(value.prefix(80)) }
            if let value = call.string("phone") { profile.phone = String(value.prefix(40)) }
            if let value = call.string("pronouns") { profile.pronouns = String(value.prefix(40)) }
            if let value = call.string("signature_html") { profile.signatureHTML = value }
            ws.accountExtras.profiles[id] = profile
            publish("member.updated", ["member": wsMemberJSON(ws.members[index], in: ws)], in: &ws)
            return .some(encode(wsMemberJSON(ws.members[index], in: ws)))
        }
        if let id = call.match("DELETE", "members/*")?.first {
            let target = id == "me" ? world.user.id : id
            guard let index = ws.members.firstIndex(where: { $0.id == target }) else { throw notFound("member") }
            if ws.members[index].role == .owner {
                throw Failure(status: 409, code: "owner_cannot_leave", detail: "The owner can't leave. Transfer the workspace first.")
            }
            if target == world.user.id {
                throw Failure(status: 409, code: "demo", detail: "The demo keeps you in its workspaces. In a real one you'd lose access right away.")
            }
            try wsRequireAdmin(ws)
            if ws.members[index].role == .admin && myRole != .owner {
                throw Failure(status: 403, code: "forbidden", detail: "Only the owner can remove an admin.")
            }
            ws.members.remove(at: index)
            for team in ws.teams.indices { ws.teams[team].memberIDs?.removeAll { $0 == target } }
            for ticket in ws.tickets.indices where ws.tickets[ticket].assignee?.id == target {
                ws.tickets[ticket].assignee = nil
            }
            publish("member.removed", ["user_id": .string(target)], in: &ws)
            return .some(nil)
        }

        if call.match("GET", "invitations") != nil {
            try wsRequireAdmin(ws)
            return .some(encode(ListBody(data: ws.settings.workspace.invitations.map(\.json))))
        }
        if call.match("POST", "invitations") != nil {
            try wsRequireAdmin(ws)
            let email = (call.string("email") ?? "").trimmingCharacters(in: .whitespaces).lowercased()
            let parts = email.split(separator: "@")
            guard parts.count == 2, parts[1].contains(".") else { throw Failure(status: 422, code: "validation_failed", detail: "Enter a valid email address.") }
            guard let role = call.string("role").flatMap(Role.init(rawValue:)), role != .owner else {
                throw Failure(status: 422, code: "validation_failed", detail: "Choose admin, agent or viewer.")
            }
            guard role != .admin || myRole == .owner else { throw Failure(status: 403, code: "forbidden", detail: "Only the owner can invite admins.") }
            if ws.members.contains(where: { $0.user.email?.lowercased() == email }) {
                throw Failure(status: 409, code: "already_member", detail: "Already a member of this workspace.")
            }
            ws.settings.workspace.invitations.removeAll { $0.email == email }
            let invite = DemoInvitation(id: made(), email: email, role: role, createdAt: now(), expiresAt: DemoMode.anchor.addingTimeInterval(7 * 86400), invitedBy: me)
            ws.settings.workspace.invitations.insert(invite, at: 0)
            return .some(encode(invite.json))
        }
        if let id = call.match("DELETE", "invitations/*")?.first {
            try wsRequireAdmin(ws)
            guard ws.settings.workspace.invitations.contains(where: { $0.id == id }) else { throw notFound("invitation") }
            ws.settings.workspace.invitations.removeAll { $0.id == id }
            return .some(nil)
        }
        if let id = call.match("POST", "invitations/*/link")?.first {
            try wsRequireAdmin(ws)
            guard let index = ws.settings.workspace.invitations.firstIndex(where: { $0.id == id }) else { throw notFound("invitation") }
            ws.settings.workspace.invitations[index].expiresAt = DemoMode.anchor.addingTimeInterval(7 * 86400)
            let url = DemoMode.instance.appOrigin.appendingPathComponent("invite").appendingPathComponent("demo-\(id.suffix(6))").absoluteString
            return .some(encode(JSONValue.object(["url": .string(url), "expires_at": .string(ws.settings.workspace.invitations[index].expiresAt.ISO8601Format())])))
        }
        if let id = call.match("POST", "invitations/*/resend")?.first {
            try wsRequireAdmin(ws)
            guard let index = ws.settings.workspace.invitations.firstIndex(where: { $0.id == id }) else { throw notFound("invitation") }
            ws.settings.workspace.invitations[index].expiresAt = DemoMode.anchor.addingTimeInterval(7 * 86400)
            return .some(nil)
        }
        return nil
    }

    // MARK: Teams

    private func wsTeamJSON(_ team: Team, in ws: DemoWorkspace) -> JSONValue {
        let extra = ws.settings.workspace.teams[team.id] ?? DemoTeamExtra()
        let ids = team.memberIDs ?? []
        let open = ws.tickets.filter { $0.teamID == team.id && !$0.spam && !$0.status.isDone }
        return .object([
            "id": .string(team.id), "name": .string(team.name), "description": .string(extra.description),
            "color": .string(extra.color), "private": .bool(extra.isPrivate),
            "member_ids": .array(ids.map(JSONValue.string)),
            "members": .array(ids.map { .object(["user_id": .string($0), "role": .string(extra.roles[$0] ?? "member")]) }),
            "signature_html": .string(extra.signatureHTML),
            "business_hours": extra.hours ?? .null,
            "assign_mode": extra.assignMode.map(JSONValue.string) ?? .null,
            "open_count": .number(Double(open.count)),
            "unassigned_count": .number(Double(open.filter { $0.assignee == nil }.count)),
        ])
    }

    private func wsTeamChanged(_ index: Int, created: Bool = false, in ws: inout DemoWorkspace) {
        publish(created ? "team.created" : "team.updated", ["team": wsTeamJSON(ws.teams[index], in: ws)], in: &ws)
    }

    private func wsTeamRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        if call.match("GET", "teams") != nil {
            return .some(encode(ListBody(data: ws.teams.map { wsTeamJSON($0, in: ws) })))
        }
        if let id = call.match("GET", "teams/*")?.first {
            guard let team = ws.teams.first(where: { $0.id == id }) else { throw notFound("team") }
            return .some(encode(wsTeamJSON(team, in: ws)))
        }
        if call.match("POST", "teams") != nil {
            try wsRequireAdmin(ws)
            let name = (call.string("name") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { throw Failure(status: 422, code: "validation_failed", detail: "Give the team a name.") }
            guard !ws.teams.contains(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) else {
                throw Failure(status: 409, code: "name_taken", detail: "A team with this name already exists.")
            }
            let id = made()
            var extra = DemoTeamExtra(description: call.string("description") ?? "", color: call.string("color") ?? "blue", isPrivate: call.body["private"]?.bool ?? false)
            var ids: [String] = []
            for entry in call.body["members"]?.array ?? [] {
                guard let user = entry["user_id"]?.string, ws.members.contains(where: { $0.id == user }) else { continue }
                ids.append(user)
                extra.roles[user] = entry["role"]?.string ?? "member"
            }
            ws.settings.workspace.teams[id] = extra
            ws.teams.append(Team(id: id, name: String(name.prefix(60)), memberIDs: ids))
            wsTeamChanged(ws.teams.count - 1, created: true, in: &ws)
            return .some(encode(wsTeamJSON(ws.teams[ws.teams.count - 1], in: ws)))
        }
        if let id = call.match("PATCH", "teams/*")?.first {
            try wsRequireAdmin(ws)
            guard let index = ws.teams.firstIndex(where: { $0.id == id }) else { throw notFound("team") }
            var extra = ws.settings.workspace.teams[id] ?? DemoTeamExtra()
            let body = call.body
            if let name = body["name"]?.string {
                let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { throw Failure(status: 422, code: "validation_failed", detail: "Give the team a name.") }
                ws.teams[index].name = String(trimmed.prefix(60))
            }
            if let value = body["description"]?.string { extra.description = String(value.prefix(280)) }
            if let value = body["color"]?.string { extra.color = value }
            if let value = body["private"]?.bool { extra.isPrivate = value }
            if let value = body["signature_html"]?.string { extra.signatureHTML = value }
            if let value = body["business_hours"] { extra.hours = value.isNull ? nil : value }
            if let value = body["assign_mode"] { extra.assignMode = value.string }
            if let members = body["members"]?.array {
                var ids: [String] = []
                var roles: [String: String] = [:]
                for entry in members {
                    guard let user = entry["user_id"]?.string, ws.members.contains(where: { $0.id == user }), !ids.contains(user) else { continue }
                    ids.append(user)
                    roles[user] = entry["role"]?.string ?? "member"
                }
                ws.teams[index].memberIDs = ids
                extra.roles = roles
            }
            ws.settings.workspace.teams[id] = extra
            wsTeamChanged(index, in: &ws)
            return .some(encode(wsTeamJSON(ws.teams[index], in: ws)))
        }
        if let id = call.match("DELETE", "teams/*")?.first {
            try wsRequireAdmin(ws)
            guard let index = ws.teams.firstIndex(where: { $0.id == id }) else { throw notFound("team") }
            let moveTo = call.query["move_to"].flatMap { target in ws.teams.contains { $0.id == target && $0.id != id } ? target : nil }
            for ticket in ws.tickets.indices where ws.tickets[ticket].teamID == id {
                ws.tickets[ticket].teamID = ws.tickets[ticket].status.isDone ? nil : moveTo
            }
            ws.teams.remove(at: index)
            ws.settings.workspace.teams[id] = nil
            publish("team.deleted", ["team_id": .string(id)], in: &ws)
            return .some(nil)
        }
        if let id = call.match("POST", "teams/*/join")?.first {
            guard ws.role.canWrite else { throw Failure(status: 403, code: "forbidden", detail: "Viewers can't join teams.") }
            guard let index = ws.teams.firstIndex(where: { $0.id == id }) else { throw notFound("team") }
            if ws.settings.workspace.teams[id]?.isPrivate == true && !ws.role.isAdmin {
                throw Failure(status: 403, code: "forbidden", detail: "Only admins add people to a private team.")
            }
            if !(ws.teams[index].memberIDs ?? []).contains(world.user.id) {
                ws.teams[index].memberIDs = (ws.teams[index].memberIDs ?? []) + [world.user.id]
            }
            wsTeamChanged(index, in: &ws)
            return .some(nil)
        }
        if let id = call.match("POST", "teams/*/leave")?.first {
            guard let index = ws.teams.firstIndex(where: { $0.id == id }) else { throw notFound("team") }
            ws.teams[index].memberIDs?.removeAll { $0 == world.user.id }
            ws.settings.workspace.teams[id]?.roles[world.user.id] = nil
            wsTeamChanged(index, in: &ws)
            return .some(nil)
        }
        return nil
    }

    // MARK: Billing

    private func wsBillingRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        if call.match("GET", "billing") != nil {
            var billing = ws.settings.workspace.billing
            let pending = ws.settings.workspace.invitations.filter { $0.expiresAt > DemoMode.anchor }.count
            billing["usage"] = .object([
                "mailboxes": billing["usage"]?["mailboxes"] ?? .number(0),
                "members": .number(Double(ws.members.count + pending)),
            ])
            return .some(encode(JSONValue.object(billing)))
        }
        if call.match("GET", "billing/usage") != nil {
            try wsRequireAdmin(ws)
            return .some(encode(wsUsage(call.query, in: ws)))
        }
        return nil
    }

    private func wsUsage(_ query: [String: String], in ws: DemoWorkspace) -> JSONValue {
        let format = Date.ISO8601FormatStyle()
        let to = query["to"].flatMap { try? format.parse($0) } ?? DemoMode.anchor
        let from = query["from"].flatMap { try? format.parse($0) } ?? to.addingTimeInterval(-30 * 86400)
        let days = Swift.max(1, Int(to.timeIntervalSince(from) / 86400))
        let scale = ws.id == DemoSeed.marginID ? 1.0 : 0.08
        let calendar = Calendar(identifier: .gregorian)
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_US_POSIX")
        day.timeZone = TimeZone(identifier: "UTC")
        day.dateFormat = "yyyy-MM-dd"
        func cents(_ value: Double) -> Double { (value * 100).rounded() / 100 }
        var byDay: [JSONValue] = []
        var total = 0.0
        for offset in 0 ..< days {
            let date = from.addingTimeInterval(Double(offset) * 86400)
            let weekday = calendar.component(.weekday, from: date)
            let base = weekday == 1 || weekday == 7 ? 0.12 : 0.38
            let usd = cents((base + Double((offset * 37) % 23) / 100) * scale)
            total += usd
            byDay.append(.object(["date": .string(day.string(from: date)), "usd": .number(usd)]))
        }
        let calls = Int(total * 140)
        let features: [(String, Double)] = [("draft_reply", 0.34), ("assistant", 0.22), ("triage", 0.16), ("summarize", 0.12), ("answer", 0.1), ("rewrite", 0.04), ("translate", 0.02)]
        let people = Array(ws.members.filter { $0.role != .viewer }.prefix(5))
        let shares = [0.36, 0.24, 0.18, 0.12, 0.1]
        var byMember: [JSONValue] = people.enumerated().map { index, member in
            .object([
                "user": .object(["id": .string(member.id), "name": .string(member.user.name)]),
                "usd": .number(cents(total * shares[index] * 0.8)),
                "calls": .number(Double(Int(Double(calls) * shares[index] * 0.8))),
            ])
        }
        byMember.append(.object(["user": .null, "usd": .number(cents(total * 0.2)), "calls": .number(Double(calls / 5))]))
        return .object([
            "total_usd": .number(cents(total)),
            "total_calls": .number(Double(calls)),
            "own_key_calls": .number(0),
            "by_feature": .array(features.map { feature, share in
                .object(["feature": .string(feature), "usd": .number(cents(total * share)), "calls": .number(Double(Int(Double(calls) * share)))])
            }),
            "by_member": .array(byMember),
            "by_model": .array([
                .object(["model": .string("claude-sonnet"), "source": .string("instance"), "usd": .number(cents(total * 0.82)), "calls": .number(Double(calls / 2))]),
                .object(["model": .string("claude-haiku"), "source": .string("instance"), "usd": .number(cents(total * 0.18)), "calls": .number(Double(calls / 2))]),
            ]),
            "by_day": .array(byDay),
        ])
    }

    // MARK: AI

    private static let wsAIKeys: Set<String> = [
        "enabled", "auto_triage", "auto_summarize", "widget_answers", "assistant", "assistant_peer", "assistant_auto",
        "draft_tools", "tone", "reply_language", "instructions", "model", "fast_model",
    ]

    private func wsAIConfig(_ ws: DemoWorkspace) -> JSONValue {
        let extra = ws.settings.workspace
        var features = extra.ai
        // The AI agent pages' own settings (`widget_*`, DemoSettingsAgent.swift) ride in the same config.
        for (key, value) in ws.settings.agent.behaviour where features[key] == nil { features[key] = value }
        features["assistant_auto"] = .array(extra.assistantAuto.map(JSONValue.string))
        let costs: [String: Double] = [
            "summarize": 0.0042, "rewrite": 0.0011, "translate": 0.0013, "triage": 0.0021, "copilot": 0.0068,
            "draft_reply": 0.0093, "answer": 0.0081, "kb_draft": 0.024, "assistant": 0.0115, "assistant_peer": 0.0052,
        ]
        return .object([
            "enabled": .bool(features["enabled"]?.bool ?? true), "provider": .string(extra.providerKey == nil ? "anthropic" : "openrouter"),
            "models": .object(["default": .string(DemoAgentSettings.defaultModel), "fast": .string(DemoAgentSettings.defaultModel)]),
            "embeddings": .bool(true), "features": .object(features),
            "costs": .object(costs.mapValues(JSONValue.number)),
            "metered": .bool(true), "assistant_name": .string("Ollie"), "own_key": .bool(extra.providerKey != nil),
        ])
    }

    private func wsAIRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        if call.match("GET", "ai/config") != nil { return .some(encode(wsAIConfig(ws))) }
        if call.match("PATCH", "ai/settings") != nil {
            // Settings of other pages (the widget agent's) are their own area's.
            guard let patch = call.body.object, patch.keys.allSatisfy(Self.wsAIKeys.contains) else { return nil }
            try wsRequireAdmin(ws)
            if let tone = patch["tone"]?.string, tone.trimmingCharacters(in: .whitespaces).isEmpty || tone.count > 200 {
                throw Failure(status: 422, code: "validation_failed", detail: "Describe the tone in up to 200 characters.")
            }
            for (key, value) in patch {
                if key == "assistant_auto" {
                    ws.settings.workspace.assistantAuto = value.array?.compactMap(\.string) ?? []
                } else {
                    ws.settings.workspace.ai[key] = value
                }
            }
            publish("workspace.updated", [:], in: &ws)
            return .some(encode(JSONValue.object(ws.settings.workspace.ai)))
        }
        // The model list is the AI agent pages' (DemoSettingsAgent.swift).
        if call.match("GET", "ai/provider") != nil {
            try wsRequireAdmin(ws)
            return .some(encode(JSONValue.object([
                "mode": .string(ws.settings.workspace.providerKey == nil ? "instance" : "own"),
                "instance_provider": .string("anthropic"), "billing": .bool(true),
                "key": ws.settings.workspace.providerKey ?? .null,
            ])))
        }
        if call.match("POST", "ai/provider/test") != nil {
            try wsRequireAdmin(ws)
            guard (call.string("api_key") ?? "").count >= 8 else {
                return .some(encode(JSONValue.object(["ok": .bool(false), "reason": .string("invalid_key"), "message": .string("The provider refused this key."), "models": .array([])])))
            }
            return .some(encode(JSONValue.object(["ok": .bool(true), "models": .array(["claude-sonnet", "claude-haiku", "gpt-5", "mistral/large"].map(JSONValue.string))])))
        }
        if call.match("PUT", "ai/provider") != nil {
            try wsRequireAdmin(ws)
            let key = call.string("api_key") ?? ""
            guard key.count >= 8 else { throw Failure(status: 422, code: "invalid_key", detail: "The provider refused this key.") }
            let host = call.string("base_url").flatMap { URL(string: $0)?.host() } ?? ""
            ws.settings.workspace.providerKey = .object([
                "kind": .string(call.string("kind") ?? "openrouter"), "base_url_host": .string(host), "last4": .string(String(key.suffix(4))),
                "model": .string(call.string("model") ?? ""), "status": .string("ok"),
                "created_by": DemoSeed.json(me), "created_at": .string(now().ISO8601Format()),
            ])
            publish("workspace.updated", [:], in: &ws)
            return .some(encode(ws.settings.workspace.providerKey ?? .null))
        }
        if call.match("DELETE", "ai/provider") != nil {
            try wsRequireAdmin(ws)
            ws.settings.workspace.providerKey = nil
            publish("workspace.updated", [:], in: &ws)
            return .some(nil)
        }
        return nil
    }

    // MARK: Integrations

    private static let wsCatalog: [JSONValue] = {
        let entries: [(String, String, String, String, String)] = [
            ("linear", "Linear", "issues", "Find and file issues, and comment on them.", "oauth"),
            ("github", "GitHub", "issues", "Search issues and pull requests across your repositories.", "oauth"),
            ("atlassian", "Jira and Confluence", "issues", "Issues in Jira and pages in Confluence.", "oauth"),
            ("sentry", "Sentry", "issues", "Errors and the releases they started in.", "oauth"),
            ("notion", "Notion", "docs", "Search and read your team's pages.", "oauth"),
            ("slack", "Slack", "chat", "Read channels and post updates.", "oauth"),
            ("intercom", "Intercom", "crm", "Customer conversations and profiles.", "oauth"),
            ("stripe", "Stripe", "payments", "Customers, invoices, subscriptions and refunds.", "token"),
            ("shopify", "Shopify", "payments", "Orders, customers and fulfilment.", "token"),
            ("box", "Box", "files", "Search and read files.", "oauth"),
            ("zapier", "Zapier", "automation", "Run your Zaps as tools.", "token"),
        ]
        return entries.map { key, name, category, description, auth in
            var object: [String: JSONValue] = [
                "key": .string(key), "name": .string(name), "category": .string(category),
                "description": .string(description), "auth": .string(auth), "url": .string("https://mcp.\(key).example/mcp"),
            ]
            if auth == "token" {
                object["token_help"] = .string("Create a restricted key with read access in \(name)'s dashboard, under Developers.")
            }
            return .object(object)
        }
    }()

    private func wsIntegration(_ id: String, in ws: DemoWorkspace) throws -> (Int, [String: JSONValue]) {
        guard let index = ws.settings.workspace.integrations.firstIndex(where: { $0["id"]?.string == id }),
              let object = ws.settings.workspace.integrations[index].object else { throw notFound("integration") }
        return (index, object)
    }

    private func wsIntegrationRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        if call.match("GET", "integrations") != nil { return .some(encode(ListBody(data: ws.settings.workspace.integrations))) }
        if call.match("GET", "integrations/catalog") != nil { return .some(encode(ListBody(data: Self.wsCatalog))) }
        if call.match("POST", "integrations") != nil {
            try wsRequireAdmin(ws)
            let provider = call.string("provider") ?? "custom"
            var name = call.string("name") ?? ""
            var host = ""
            var auth = "none"
            if provider == "custom" {
                guard let raw = call.string("url"), raw.hasPrefix("https://"), let found = URL(string: raw)?.host() else {
                    throw Failure(status: 422, code: "validation_failed", detail: "Use the server's HTTPS address.")
                }
                host = found
                auth = call.string("auth") ?? "none"
                if name.isEmpty { name = found }
            } else {
                guard let entry = Self.wsCatalog.first(where: { $0["key"]?.string == provider }) else { throw notFound("provider") }
                name = entry["name"]?.string ?? provider
                auth = entry["auth"]?.string ?? "oauth"
                host = URL(string: entry["url"]?.string ?? "")?.host() ?? ""
            }
            if auth == "token", (call.string("token") ?? "").isEmpty {
                throw Failure(status: 422, code: "validation_failed", detail: "Paste an access token.")
            }
            let pending = auth == "oauth"
            let integration = DemoWorkspaceSettings.integration(
                id: made(), provider: provider, name: name, host: host, auth: auth, status: pending ? "pending" : "connected",
                tools: pending ? [] : [
                    .init("search", "Search", "Search \(name).", read: true),
                    .init("get", "Read an item", "Read one item with its details.", read: true),
                    .init("create", "Create an item", "Create a new item in \(name)."),
                ]
            )
            ws.settings.workspace.integrations.append(integration)
            var answer: [String: JSONValue] = ["integration": integration]
            if pending { answer["authorize_url"] = .string("https://\(host)/authorize") }
            return .some(encode(JSONValue.object(answer)))
        }
        if let id = call.match("PATCH", "integrations/*")?.first {
            try wsRequireAdmin(ws)
            var (index, object) = try wsIntegration(id, in: ws)
            if let enabled = call.body["enabled"]?.bool { object["enabled"] = .bool(enabled) }
            if call.body["token"]?.string != nil {
                object["status"] = .string("connected")
                object["last_error"] = .string("")
            }
            let disabled = call.body["disabled_tools"]?.array.map { Set($0.compactMap(\.string)) }
            let ask = call.body["ask_tools"]?.array.map { Set($0.compactMap(\.string)) }
            let auto = call.body["auto_tools"]?.array.map { Set($0.compactMap(\.string)) }
            object["tools"] = .array((object["tools"]?.array ?? []).map { tool in
                guard var tool = tool.object, let name = tool["name"]?.string else { return tool }
                if let disabled { tool["enabled"] = .bool(!disabled.contains(name)) }
                if let ask { tool["ask_first"] = .bool(ask.contains(name)) }
                if let auto { tool["auto_run"] = .bool(auto.contains(name) && !(ask?.contains(name) ?? false)) }
                return .object(tool)
            })
            ws.settings.workspace.integrations[index] = .object(object)
            return .some(encode(JSONValue.object(object)))
        }
        if let id = call.match("POST", "integrations/*/sync")?.first {
            try wsRequireAdmin(ws)
            var (index, object) = try wsIntegration(id, in: ws)
            guard object["status"]?.string == "connected" else {
                throw Failure(status: 409, code: "not_connected", detail: "Sign in to \(object["name"]?.string ?? "it") first.")
            }
            object["synced_at"] = .string(now().ISO8601Format())
            ws.settings.workspace.integrations[index] = .object(object)
            return .some(encode(JSONValue.object(object)))
        }
        if let id = call.match("DELETE", "integrations/*")?.first {
            try wsRequireAdmin(ws)
            ws.settings.workspace.integrations.removeAll { $0["id"]?.string == id }
            return .some(nil)
        }
        return nil
    }
}
#endif
