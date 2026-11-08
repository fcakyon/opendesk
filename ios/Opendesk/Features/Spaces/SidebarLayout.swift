import SwiftUI

// The workspace's own sidebar as the member arranged it (contracts/collab.md "Your own sections",
// "Names and icons", "Inboxes as sections", "Row order"): which sections show in what order, what
// each is called, and the rows each holds. The menu and the editor both read it.

/// One row of a section, with the member's name and icon on it.
struct SidebarRow: Identifiable {
    /// The row's key in `hidden`, `names` and `icons`.
    var key: String
    var model: SpaceRowModel
    /// The name it has without the member's own.
    var usualTitle: String
    /// It can be a favorite.
    var pin: SidebarPin?
    /// It can sit in a section of the member's own.
    var item: SidebarItem?
    /// The own section it sits in, when it is one of its rows.
    var ownSection: String?
    var hidden = false

    var id: String { model.id }

    func hidden(_ on: Bool) -> SidebarRow {
        var row = self
        row.hidden = on
        return row
    }
}

@MainActor
struct SidebarLayout {
    let env: AppEnvironment
    var prefs: SidebarPrefs

    init(env: AppEnvironment, prefs: SidebarPrefs? = nil) {
        self.env = env
        self.prefs = prefs ?? SidebarStore.shared.prefs
    }

    var builder: SpaceRowBuilder { SpaceRowBuilder(env: env) }
    var workspace: String { env.session.workspace?.id ?? "" }
    private var counts: TicketCounts? { env.directory.counts }

    // MARK: Sections

    var collab: Bool { env.directory.collab.enabled && env.products.mail }

    /// Whether the workspace offers what section `id` shows.
    func offers(_ id: String) -> Bool {
        switch id {
        case "inbox", "teams", "views": return env.products.tickets
        case "mail": return collab
        case "pages": return env.products.pages
        case "favorites", "workspace": return true
        default:
            if id.hasPrefix("custom:") { return prefs.section(String(id.dropFirst(7))) != nil }
            if let mailbox = Self.mailboxID(id) { return env.products.tickets && builder.mailboxes(workspace).contains { $0.id == mailbox } }
            if let team = Self.teamID(id) { return env.products.tickets && (team == InboxScope.myTeams || myTeams.contains { $0.id == team }) }
            return false
        }
    }

    static func mailboxID(_ id: String) -> String? { id.hasPrefix("mailbox:") ? String(id.dropFirst(8)) : nil }
    static func teamID(_ id: String) -> String? { id.hasPrefix("team:") ? String(id.dropFirst(5)) : nil }

    /// Every section the workspace offers, top to bottom, hidden ones included.
    var allSections: [String] {
        prefs.resolvedOrder { id in Self.mailboxID(id) != nil || Self.teamID(id) != nil }.filter(offers)
    }

    /// The sections the menu shows.
    var shownSections: [String] { allSections.filter { !isHidden(section: $0) } }

    func isHidden(section id: String) -> Bool { !id.hasPrefix("custom:") && prefs.isHidden("section:" + id) }

    /// The key a section's name and icon are saved under; own sections keep theirs on themselves.
    func nameKey(section id: String) -> String { "section:" + id }

    func usualTitle(section id: String) -> String {
        switch id {
        case "favorites": return "Favorites"
        case "inbox": return collab ? "Tickets" : "Inbox"
        case "mail": return "Mail"
        case "teams": return "Teams"
        case "views": return "Views"
        case "pages": return "Pages"
        case "workspace": return "Workspace"
        default:
            if id.hasPrefix("custom:") { return "Untitled section" }
            if let mailbox = Self.mailboxID(id), let found = builder.mailboxes(workspace).first(where: { $0.id == mailbox }) {
                return found.title
            }
            if let team = Self.teamID(id) {
                return team == InboxScope.myTeams ? "My teams" : myTeams.first { $0.id == team }?.name ?? "A team"
            }
            return "Section"
        }
    }

    func title(section id: String) -> String {
        if id.hasPrefix("custom:"), let own = prefs.section(String(id.dropFirst(7))) {
            return SpaceRules.clean(own.title).isEmpty ? "Untitled section" : own.title
        }
        return prefs.name(nameKey(section: id), usualTitle(section: id))
    }

    func icon(section id: String) -> String? {
        if id.hasPrefix("custom:") { return prefs.section(String(id.dropFirst(7)))?.icon }
        return prefs.icon(nameKey(section: id))
    }

    /// The symbol a section stands for in the editor's list.
    func symbol(section id: String) -> String {
        switch id {
        case "favorites": "star"
        case "inbox": "tray"
        case "mail": "envelope"
        case "teams": "person.3"
        case "views": "square.stack"
        case "pages": "doc.text"
        case "workspace": "square.grid.2x2"
        default: id.hasPrefix("mailbox:") ? "tray.2" : id.hasPrefix("team:") ? "person.2" : "rectangle.stack"
        }
    }

    /// Rows here keep the member's order: dragged rows are saved for the section.
    func canReorder(section id: String) -> Bool {
        ["inbox", "mail", "teams", "workspace", "favorites"].contains(id) || id.hasPrefix("custom:")
    }

    // MARK: Rows

    var myTeams: [Team] {
        guard let me = env.session.user?.id else { return [] }
        return env.directory.teams.filter { $0.memberIDs?.contains(me) == true }
    }

    /// The rows of section `id`, in the member's order; hidden ones only when asked for.
    func rows(of id: String, hidden includeHidden: Bool = false) -> [SidebarRow] {
        var out: [SidebarRow]
        switch id {
        case "favorites":
            out = prefs.pinned.compactMap { pin in builtIn(SpaceItemKind(rawValue: pin.kind), pin.id) }
            return out.map { row in
                var row = row
                row.model.id = "favorites/" + row.key
                return row
            }
        case "inbox":
            out = Folder.allCases.compactMap { builtIn(.ticketFolder, $0.rawValue) }
        case "mail":
            out = ["inbox", "shared", "assigned"].compactMap { builtIn(.box, $0) } + builder.accounts(workspace).compactMap { builtIn(.account, $0.id) }
        case "teams":
            let mine = myTeams
            out = mine.isEmpty ? [] : ([builtIn(.team, InboxScope.myTeams)] + mine.map { builtIn(.team, $0.id) }).compactMap { $0 }
        case "views":
            out = env.directory.views.compactMap { builtIn(.view, $0.id) }
        case "workspace":
            out = workspaceRows
        case "pages":
            out = pagesRows
        default:
            if id.hasPrefix("custom:") { return ownRows(String(id.dropFirst(7))) }
            if let mailbox = Self.mailboxID(id) { out = mailboxRows(mailbox) } else if let team = Self.teamID(id) { out = teamRows(team) } else { out = [] }
        }
        if canReorder(section: id) {
            let keys = prefs.ordered(out.map(\.key), in: id)
            out = keys.compactMap { key in out.first { $0.key == key } }
        }
        out = out.map { row in
            var row = row
            row.hidden = prefs.isHidden(row.key)
            row.model.id = id + "/" + row.key
            return row
        }
        return includeHidden ? out : out.filter { !$0.hidden }
    }

    /// A built-in row of `kind` and `id` as the workspace has it, or nil when it is gone.
    func builtIn(_ kind: SpaceItemKind, _ id: String) -> SidebarRow? {
        guard var model = builder.base(kind, id, in: workspace) else { return nil }
        let key = "\(kind.rawValue):\(id)"
        let usual = model.title
        model.title = prefs.name(key, usual)
        if let icon = prefs.icon(key) { model.mark = .emoji(icon) }
        let pinnable: Set<SpaceItemKind> = [.ticketFolder, .team, .view, .box, .account, .folder]
        return SidebarRow(
            key: key, model: model, usualTitle: usual,
            pin: pinnable.contains(kind) ? SidebarPin(kind: kind.rawValue, id: id) : nil,
            item: SidebarItem(kind: kind, itemID: id)
        )
    }

    /// A row of no Space kind (a part of Pages, a team's tab, a ticket inbox's folder).
    private func plain(_ key: String, _ title: String, _ mark: SpaceRowModel.Mark, count: Int? = nil, _ destination: SpaceDestination, selected: Bool = false) -> SidebarRow {
        var model = SpaceRowModel(id: key, title: prefs.name(key, title), mark: mark, count: count, workspaceID: workspace, destination: destination, selected: selected)
        if let icon = prefs.icon(key) { model.mark = .emoji(icon) }
        return SidebarRow(key: key, model: model, usualTitle: title)
    }

    private var workspaceRows: [SidebarRow] {
        let area = env.router.shownArea
        var out: [SidebarRow] = []
        for page in ["contacts", "companies", "knowledge", "wiki", "reports"] {
            if page == "reports", !env.products.tickets { continue }
            if page == "companies" {
                out.append(plain("page:companies", AppArea.companies.title, .symbol(AppArea.companies.symbol), .area(.companies), selected: area == .companies))
            } else if let row = builtIn(.page, page) {
                out.append(row)
            }
        }
        return out
    }

    private var pagesRows: [SidebarRow] {
        let pages = builder.pages(workspace)
        var out = [plain("pages:workspace", "All pages", .symbol("doc.text"), .path("/pages"), selected: env.router.shownArea == .pages && env.router.inboxPath.isEmpty)]
        let teamspaces = builder.teams(workspace).filter { team in pages.contains { $0.teamID == team.id && $0.area == "pages" } }
        out += teamspaces.compactMap { builtIn(.wikiSpace, $0.id) }
        out += pages.filter { $0.area == "pages" && $0.parentID == nil && $0.teamID == nil }.compactMap { builtIn(.wikiPage, $0.id) }
        out.append(plain("pages:templates", "Templates", .symbol("square.on.square"), .path("/pages/templates")))
        out.append(plain("pages:trash", "Trash", .symbol("trash"), .path("/pages/trash")))
        return out
    }

    private func mailboxRows(_ mailbox: String) -> [SidebarRow] {
        Folder.allCases.map { folder in
            plain("mailbox:\(mailbox):\(folder.rawValue)", folder.mailboxTitle, .symbol(folder.symbol), count: folder.count(in: counts, mailbox: mailbox),
                  .path("/inbox/\(folder.rawValue)?mailbox=\(mailbox)"), selected: env.router.shownArea == .tickets && env.inbox.scope == .mailbox(mailbox, folder))
        }
    }

    private func teamRows(_ team: String) -> [SidebarRow] {
        let count = team == InboxScope.myTeams ? counts?.myTeams : counts?.teams[team]
        return TeamTab.allCases.map { tab in
            let number: Int? = switch tab {
            case .unassigned: count?.unassigned
            case .open: count?.open
            default: nil
            }
            let selected = env.router.shownArea == .tickets && env.inbox.scope == .team(team, tab)
            return plain("team:\(team):\(tab.rawValue)", tab.title, .symbol(teamSymbol(tab)), count: number, .path("/teams/\(team)?tab=\(tab.rawValue)"), selected: selected)
        }
    }

    private func teamSymbol(_ tab: TeamTab) -> String {
        switch tab {
        case .unassigned: "tray"
        case .open: "circle"
        case .pending: "clock"
        case .all: "tray.full"
        }
    }

    private func ownRows(_ sectionID: String) -> [SidebarRow] {
        guard let section = prefs.section(sectionID) else { return [] }
        return section.items.compactMap { item in
            let spaceItem = item.spaceItem(in: workspace)
            guard builder.usable(spaceItem), let usual = builder.base(item.kind, item.itemID, in: workspace) else { return nil }
            var model = usual
            if let name = item.name { model.title = name }
            if let icon = item.icon { model.mark = .emoji(icon) }
            if item.badge == "none" { model.count = nil }
            model.id = "custom:\(sectionID)/\(item.key)"
            return SidebarRow(key: item.key, model: model, usualTitle: usual.title, item: item, ownSection: sectionID)
        }
    }

    /// The ticket inboxes listed under Tickets, one row each: the ones not shown as sections of
    /// their own, from two inboxes on.
    var listedInboxes: [SidebarRow] {
        let mailboxes = builder.mailboxes(workspace)
        guard env.products.tickets, mailboxes.count > 1 else { return [] }
        let sections = Set(allSections)
        return mailboxes.filter { !sections.contains("mailbox:" + $0.id) }.compactMap { mailbox in
            guard var row = builtIn(.mailbox, mailbox.id) else { return nil }
            row.model.id = "inboxes/" + row.key
            return row.hidden(prefs.isHidden(row.key))
        }.filter { !$0.hidden }
    }

    // MARK: What the menu adds above Inbox

    /// The red row on top of Inbox while visitors wait in live chat with nobody on it, when the
    /// member turned it on.
    var showsWaitingChats: Bool { prefs.showWaitingChats && env.products.tickets }
}

extension SidebarPrefs {
    /// Moves rows of section `id` in its saved order: `row_order` for built-ins, the items of an
    /// own section, the pins of Favorites.
    mutating func moveRows(in id: String, keys: [String], from: IndexSet, to: Int) {
        var keys = keys
        keys.move(fromOffsets: from, toOffset: to)
        if id == "favorites" {
            pinned = keys.compactMap { key in pinned.first { $0.key == key } } + pinned.filter { !keys.contains($0.key) }
        } else if id.hasPrefix("custom:") {
            update(section: String(id.dropFirst(7))) { section in
                let moved = keys.compactMap { key in section.items.first { $0.key == key } }
                section.items = moved + section.items.filter { !keys.contains($0.key) }
            }
        } else {
            rowOrder[id] = keys
        }
    }

    /// Takes row `key` out of section `id` of the member's own, or out of Favorites.
    mutating func remove(_ key: String, from id: String) {
        if id == "favorites" {
            pinned.removeAll { $0.key == key }
        } else if id.hasPrefix("custom:") {
            update(section: String(id.dropFirst(7))) { $0.items.removeAll { $0.key == key } }
        }
    }
}
