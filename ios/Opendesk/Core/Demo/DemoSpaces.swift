#if DEBUG
import Foundation

/// The demo's Spaces (contracts/spaces.md), starter Spaces, workspace preferences and the overview
/// across Margin and Lumen Labs (contracts/api.md "Several workspaces"), so the switcher, a Space's
/// rows, its editor and the Everywhere lists run their real code.
final class DemoSpacesState: @unchecked Sendable {
    static let shared = DemoSpacesState()

    struct State {
        var spaces: [Space]
        var saved = true
        var starters: [String: Space]
        /// The person's own keyboard shortcuts (`/v1/me/shortcuts`).
        var shortcuts: [String: JSONValue] = [:]
    }

    private let lock = NSLock()
    private var state = DemoSpacesState.seed()

    func with<T>(_ body: (inout State) throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body(&state)
    }

    private static func seed() -> State {
        let margin = DemoSeed.marginID
        let lumen = DemoSeed.lumenID
        func item(_ workspace: String, _ kind: SpaceItemKind, _ id: String, name: String? = nil) -> SpaceItem {
            SpaceItem(workspaceID: workspace, kind: kind, itemID: id, name: name)
        }
        let morning = Space(
            id: "0197a0c0-0101-7000-8000-000000000001", name: "Morning", icon: "sun", color: .amber,
            sections: [
                SpaceSection(id: "today", items: [
                    item(margin, .ticketFolder, "unassigned", name: "Margin, waiting"),
                    item(margin, .ticketFolder, "mine"),
                    item(lumen, .ticketFolder, "mine", name: "Lumen, mine"),
                    item(margin, .box, "inbox"),
                ]),
                SpaceSection(id: "everywhere", title: "Across workspaces", items: [
                    item("", .everywhere, "mine"),
                    item("", .everywhere, "mail"),
                ]),
            ]
        )
        let support = Space(
            id: "0197a0c0-0101-7000-8000-000000000002", name: "Support", icon: "headphones", color: .blue,
            sections: [
                SpaceSection(id: "margin", title: "Margin", items: [item(margin, .section, "inbox"), item(margin, .team, DemoSeed.support)]),
                SpaceSection(id: "lumen", title: "Lumen Labs", items: [item(lumen, .section, "inbox"), item(lumen, .page, "knowledge")]),
            ]
        )
        let mail = Space(
            id: "0197a0c0-0101-7000-8000-000000000003", name: "Mail", icon: "mail", color: .violet,
            sections: [SpaceSection(id: "main", items: [item(margin, .section, "mail")])]
        )
        let starter = Space(
            id: "0197a0c0-0101-7000-8000-000000000010", name: "Margin support", icon: "headphones", color: .teal,
            sections: [
                SpaceSection(id: "tickets", title: "Tickets", items: [item(margin, .section, "inbox")]),
                SpaceSection(id: "teams", title: "Teams", items: [item(margin, .team, DemoSeed.support), item(margin, .team, DemoSeed.billing)]),
                SpaceSection(id: "help", title: "Help", items: [item(margin, .page, "knowledge"), item(margin, .page, "wiki")]),
            ]
        )
        return State(spaces: [morning, support, mail], starters: [margin: starter])
    }
}

extension DemoBackend {
    /// Routes for Spaces and the overview, ahead of the workspace guard. The answer (nil inside
    /// for 204), or nil when the route isn't this area's.
    func spacesRoutes(_ call: Call) throws -> Data?? {
        let state = DemoSpacesState.shared
        if call.match("GET", "me/spaces") != nil {
            return .some(encode(state.with { SpacesList(spaces: $0.spaces, saved: $0.saved) }))
        }
        if call.match("PUT", "me/spaces") != nil {
            guard let list = try? call.body.decode(SpacesList.self) else { throw Failure(status: 422, code: "validation_failed", detail: "That isn't a list of Spaces.") }
            let members = Set(world.workspaces.map(\.id))
            guard list.spaces.count <= SpaceRules.spaces, Set(list.spaces.map(\.id)).count == list.spaces.count else {
                throw Failure(status: 422, code: "validation_failed", detail: "Keep to \(SpaceRules.spaces) Spaces, each once.")
            }
            for space in list.spaces {
                if let problem = SpaceRules.problem(in: space, members: members) { throw Failure(status: 422, code: "validation_failed", detail: problem) }
            }
            return .some(encode(state.with { s -> SpacesList in
                s.spaces = list.spaces
                s.saved = true
                return SpacesList(spaces: s.spaces, saved: true)
            }))
        }
        if call.match("GET", "me/overview") != nil {
            return .some(encode(JSONValue.object(["workspaces": .array(world.workspaces.map(overview))])))
        }
        if call.match("GET", "me/shortcuts") != nil {
            return .some(encode(JSONValue.object(["bindings": .object(state.with { $0.shortcuts })])))
        }
        if call.match("PUT", "me/shortcuts") != nil {
            let bindings = call.body["bindings"]?.object ?? [:]
            for (id, value) in bindings where value.string.map({ ShortcutBinding.steps($0) == nil }) ?? !value.isNull {
                throw Failure(status: 422, code: "validation_failed", detail: "\(id) needs keys the app can read.")
            }
            state.with { $0.shortcuts = bindings }
            return .some(encode(JSONValue.object(["bindings": .object(bindings)])))
        }
        if call.match("GET", "me/workspace-prefs") != nil {
            return .some(encode(JSONValue.object(["order": .array([]), "hidden": .array([]), "updated_at": .null])))
        }
        guard call.path.first == "sidebar", call.path.dropFirst().first == "starter" else { return nil }
        guard let wid = call.workspace, let ws = world.workspaces.first(where: { $0.id == wid }) else {
            throw Failure(status: 400, code: "workspace_required", detail: "Pick a workspace first.")
        }
        if call.match("GET", "sidebar/starter") != nil {
            return .some(encode(StarterSpace(space: state.with { $0.starters[wid] })))
        }
        guard ws.role.isAdmin else { throw Failure(status: 403, code: "forbidden", detail: "Only admins publish the starter Space.") }
        if call.match("PUT", "sidebar/starter") != nil {
            guard var space = try? call.body.decode(Space.self) else { throw Failure(status: 422, code: "validation_failed", detail: "That isn't a Space.") }
            for s in space.sections.indices {
                space.sections[s].items = space.sections[s].items.filter { !$0.isEverywhere }.map { var item = $0; item.workspaceID = wid; return item }
            }
            if let problem = SpaceRules.problem(in: space, members: [wid]) { throw Failure(status: 422, code: "validation_failed", detail: problem) }
            state.with { $0.starters[wid] = space }
            return .some(encode(StarterSpace(space: space)))
        }
        if call.match("DELETE", "sidebar/starter") != nil {
            state.with { $0.starters[wid] = nil }
            return .some(nil)
        }
        return nil
    }

    /// One workspace's sidebar numbers, as its own routes would answer.
    private func overview(_ ws: DemoWorkspace) -> JSONValue {
        let mail = ws.mail.enabled && ws.workspace.mailOn
        return .object([
            "id": .string(ws.id), "name": .string(ws.workspace.name), "slug": .string(ws.workspace.slug ?? ""),
            "avatar_url": .string(ws.workspace.avatarURL ?? ""), "role": .string(ws.role.rawValue), "suspended": .bool(false),
            "unread_notifications": .number(Double(ws.notifications.filter(\.isUnread).count)),
            "ticket_counts": counts(ws),
            "mail_counts": mail ? DemoSeed.json(ws.mail.counts()) : .null,
        ])
    }
}
#endif
