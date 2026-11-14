import Foundation
import Observation

/// The wiki and Pages of the open workspace (contracts/wiki.md, contracts/pages.md): every
/// page of both areas without its body, as two trees (each node says its area), kept live
/// from `wiki_page.*` events while a wiki screen is up, and the savers of the pages being
/// edited. One store per workspace, shared by the lists and the page screens (`WikiStore.shared`).
@MainActor
@Observable
final class WikiStore {
    static let shared = WikiStore()

    private(set) var nodes: [WikiNode] = []
    private(set) var loading = false
    private(set) var loadedOnce = false
    private(set) var error: String?
    /// Pages showing their subpages in the tree.
    var expanded: Set<String> = []
    /// Pages made here a moment ago: they open with the title focused.
    @ObservationIgnored var fresh: Set<String> = []
    /// The person's favorite pages, in their order (contracts/wiki.md "Favorites").
    private(set) var favorites: [String] = []
    /// A comment thread a notification asked to open, by page: the page opens its comments.
    /// Set before the page (and so the store) may be attached, so `attach` keeps them.
    var commentRequests: [String: String] = [:]
    /// Moves on `wiki_comment.changed`, by page: a page showing its comments fetches them again.
    private(set) var commentChanges: [String: Int] = [:]
    /// A comment typed and not sent yet, by page: it waits for the page's comments to open again.
    @ObservationIgnored var unsentComments: [String: String] = [:]

    @ObservationIgnored private(set) var api: APIClient?
    @ObservationIgnored private(set) var workspaceID: String?
    /// Whether the workspace has Pages on: its tree is read only then (contracts/pages.md "The product").
    @ObservationIgnored private(set) var pagesOn = true
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var savers: [String: WikiSaver] = [:]

    /// Binds the store to the session's workspace; a new workspace starts from nothing.
    func attach(api: APIClient, workspaceID: String?, pagesOn: Bool = true) {
        if self.workspaceID == workspaceID, self.api === api {
            // Pages turned on or off while the store was up: its tree comes or goes.
            if self.pagesOn != pagesOn {
                self.pagesOn = pagesOn
                reload()
            }
            return
        }
        flushAll()
        self.api = api
        self.workspaceID = workspaceID
        self.pagesOn = pagesOn
        nodes = []
        expanded = []
        fresh = []
        savers = [:]
        favorites = []
        commentChanges = [:]
        unsentComments = [:]
        loadedOnce = false
        error = nil
        reload()
    }

    // MARK: Loading

    func reload() {
        loadTask?.cancel()
        loadTask = Task { await load() }
    }

    func refresh() async {
        loadTask?.cancel()
        await load()
    }

    private func load() async {
        guard let api else { return }
        loading = true
        defer { loading = false }
        let pagesOn = self.pagesOn
        do {
            async let favorite: Page<WikiNode>? = try? api.get("v1/wiki/favorites")
            async let pages = Self.pagesTree(api, on: pagesOn)
            let wiki = try await Self.tree(api, .wiki)
            let favored = await favorite
            let ownPages = await pages
            guard !Task.isCancelled else { return }
            // Pages' tree that couldn't be read this time stays as it was.
            nodes = wiki + (ownPages ?? nodes.filter { $0.area == .pages })
            if let favored { favorites = favored.data.map(\.id) }
            error = nil
            loadedOnce = true
        } catch {
            guard !error.isCancellation, !Task.isCancelled else { return }
            self.error = error.userMessage
        }
    }

    /// One area's tree. A page that says no area is the wiki's, so a server from before Pages
    /// answering the wiki's tree to `area=pages` adds nothing to Pages.
    private nonisolated static func tree(_ api: APIClient, _ area: WikiArea) async throws -> [WikiNode] {
        let page: Page<WikiNode> = try await api.get("v1/wiki/pages", query: [URLQueryItem(name: "area", value: area.rawValue)])
        return page.data.filter { $0.area == area }
    }

    /// Pages' tree: none while the workspace has it off, nil when it couldn't be read.
    private nonisolated static func pagesTree(_ api: APIClient, on: Bool) async -> [WikiNode]? {
        guard on else { return [] }
        return try? await tree(api, .pages)
    }

    // MARK: Tree

    /// The pages of `area` (templates included).
    func nodes(in area: WikiArea) -> [WikiNode] { nodes.filter { $0.area == area } }

    func node(_ id: String?) -> WikiNode? {
        guard let id else { return nil }
        return nodes.first { $0.id == id }
    }

    /// The pages under `parentID` (nil: the top level), in order.
    func children(of parentID: String?) -> [WikiNode] {
        nodes.filter { $0.parentID == parentID }.sorted { $0.position != $1.position ? $0.position < $1.position : $0.id < $1.id }
    }

    /// The subpages the tree shows: never templates, and none under a database (its rows
    /// show in its views, contracts/wiki.md "Databases").
    func treeChildren(of parentID: String?) -> [WikiNode] {
        if let parentID, node(parentID)?.isDatabase == true { return [] }
        return children(of: parentID).filter { !$0.template }
    }

    /// Where a top-level page lives; its subpages live there too.
    func section(of node: WikiNode) -> WikiSection {
        if node.isPrivate { return .personal }
        if let team = node.teamID { return .team(team) }
        return .workspace
    }

    /// The top-level pages of `section`, in order; with `area`, of that tree alone.
    func roots(of section: WikiSection, in area: WikiArea? = nil) -> [WikiNode] {
        treeChildren(of: nil).filter { self.section(of: $0) == section && (area == nil || $0.area == area) }
    }

    /// The teamspaces with pages, in the order their first page sits; with `area`, in that tree.
    var teamspaces: [String] { teamspaces(in: nil) }

    func teamspaces(in area: WikiArea?) -> [String] {
        var out: [String] = []
        for root in treeChildren(of: nil) where area == nil || root.area == area {
            if case let .team(id) = section(of: root), !out.contains(id) { out.append(id) }
        }
        return out
    }

    /// Its ancestors, the top-level page first.
    func ancestors(of id: String) -> [WikiNode] {
        var out: [WikiNode] = []
        var seen: Set<String> = [id]
        var current = node(id)?.parentID
        while let parent = current, !seen.contains(parent), let found = node(parent) {
            out.insert(found, at: 0)
            seen.insert(parent)
            current = found.parentID
        }
        return out
    }

    /// Every page under it, at any depth.
    func descendants(of id: String) -> [WikiNode] {
        var out: [WikiNode] = []
        var queue = [id]
        while let next = queue.popLast() {
            for child in children(of: next) {
                out.append(child)
                queue.append(child.id)
            }
        }
        return out
    }

    /// Levels from the top: a top-level page is 1.
    func depth(of id: String) -> Int { ancestors(of: id).count + 1 }

    /// Levels the page and its subpages take: a page with none is 1.
    func height(of id: String) -> Int {
        1 + (children(of: id).map { height(of: $0.id) }.max() ?? 0)
    }

    /// The newest edits first.
    var recent: [WikiNode] { nodes.sorted { $0.updatedAt > $1.updatedAt } }

    /// The newest edits of one area first.
    func recent(in area: WikiArea) -> [WikiNode] { recent.filter { $0.area == area } }

    /// The tree flattened in reading order with each page's level, following `expanded`
    /// (or every page with `all`); with `section`, only the pages living there, and with
    /// `area`, only that tree's.
    func outline(all: Bool = false, in section: WikiSection? = nil, area: WikiArea? = nil) -> [WikiOutlineItem] {
        var out: [WikiOutlineItem] = []
        func walk(_ parent: String?, _ level: Int) {
            for child in treeChildren(of: parent) {
                if level == 0, let section, self.section(of: child) != section { continue }
                if level == 0, let area, child.area != area { continue }
                out.append(WikiOutlineItem(node: child, level: level))
                if all || expanded.contains(child.id) { walk(child.id, level + 1) }
            }
        }
        walk(nil, 0)
        return out
    }

    /// Pages `id` may move under (contracts/wiki.md "Tree"): not itself, not its subpages,
    /// and not so deep that it and its subpages would pass the depth limit.
    func moveTargets(for id: String) -> [WikiOutlineItem] {
        let blocked = Set([id] + descendants(of: id).map(\.id))
        let tall = height(of: id)
        return outline(all: true, area: node(id)?.area).filter { !blocked.contains($0.node.id) && depth(of: $0.node.id) + tall <= WikiText.maxDepth }
    }

    func expand(_ ids: [String]) {
        expanded.formUnion(ids)
    }

    func toggle(_ id: String) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
    }

    // MARK: Who may delete

    enum DeleteRule: Equatable {
        case yes, no
        /// Someone else created the page.
        case page
        /// Someone else created a page under it.
        case subpages

        var reason: String? {
            switch self {
            case .page: "Someone else created this page, so only an admin can delete it."
            case .subpages: "Someone else created pages under this one, so only an admin can delete it."
            default: nil
            }
        }
    }

    /// Deleting a page in the trash for good follows the same rule; the pages that went with
    /// it are no longer in the tree, so the server checks those.
    func purgeRule(_ page: WikiTrashedPage, role: Role, me: String?) -> DeleteRule {
        guard role.canWrite else { return .no }
        if role.isAdmin { return .yes }
        guard let me, page.node.createdByID == me else { return .page }
        return .yes
    }

    /// Admins delete any page; agents a page they created along with every page under it; viewers none.
    func deleteRule(_ id: String, role: Role, me: String?) -> DeleteRule {
        guard role.canWrite else { return .no }
        if role.isAdmin { return .yes }
        guard let node = node(id) else { return .yes }
        guard let me, node.createdByID == me else { return .page }
        return descendants(of: id).allSatisfy { $0.createdByID == me } ? .yes : .subpages
    }

    // MARK: Pages

    func page(_ id: String) async throws -> WikiPage {
        guard let api else { throw APIError.signedOut }
        let page: WikiPage = try await api.get("v1/wiki/pages/\(id)")
        // A page read from the trash stays out of the tree.
        if !page.inTrash { upsert(page.node) }
        return page
    }

    func create(_ body: WikiPageCreate) async throws -> WikiPage {
        guard let api else { throw APIError.signedOut }
        let page: WikiPage = try await api.post("v1/wiki/pages", body: body)
        upsert(page.node)
        if let parent = page.parentID { expand([parent] + ancestors(of: parent).map(\.id)) }
        fresh.insert(page.id)
        return page
    }

    /// Saves a change with the version it edited; `409 page_changed` when someone else saved first.
    func update(_ id: String, _ patch: WikiPagePatch, workspaceID: String?) async throws -> WikiPage {
        guard let api else { throw APIError.signedOut }
        let page: WikiPage = try await api.patch("v1/wiki/pages/\(id)", body: patch, workspace: workspaceID.map(WorkspaceScope.id) ?? .current)
        if workspaceID == nil || workspaceID == self.workspaceID { upsert(page.node) }
        return page
    }

    /// Puts the page last under `parentID` (nil: the top level), with its subpages.
    func move(_ id: String, under parentID: String?) async throws -> WikiPage {
        guard let api else { throw APIError.signedOut }
        let position = children(of: parentID).filter { $0.id != id }.count
        let before = nodes
        if let index = nodes.firstIndex(where: { $0.id == id }) {
            let oldParent = nodes[index].parentID
            nodes[index].parentID = parentID
            nodes[index].position = position
            renumber(oldParent)
        }
        do {
            let page: WikiPage = try await api.post("v1/wiki/pages/\(id)/move", body: WikiMove(parentID: parentID, position: position))
            if let parentID { expand([parentID]) }
            return page
        } catch {
            nodes = before
            throw error
        }
    }

    /// Moves a top-level page, or one out of its parent, to the other area's top level with its
    /// subpages (contracts/pages.md "Areas"), last among that area's pages. Not for a journal or a template.
    func move(_ id: String, to area: WikiArea) async throws -> WikiPage {
        guard let api else { throw APIError.signedOut }
        let position = roots(of: node(id).map(section(of:)) ?? .workspace, in: area).count
        let before = nodes
        let moved = Set([id] + descendants(of: id).map(\.id))
        if let index = nodes.firstIndex(where: { $0.id == id }) {
            let oldParent = nodes[index].parentID
            nodes[index].parentID = nil
            nodes[index].position = position
            renumber(oldParent)
        }
        for index in nodes.indices where moved.contains(nodes[index].id) { nodes[index].area = area }
        do {
            let page: WikiPage = try await api.post("v1/wiki/pages/\(id)/move", body: WikiMove(parentID: nil, position: position, area: area))
            upsert(page.node)
            return page
        } catch {
            nodes = before
            throw error
        }
    }

    /// Opens the person's note of `date` in `area`, making it (and their journal) when there is
    /// none (contracts/wiki.md "Journal"). A new journal joins the tree with the note.
    func daily(_ date: Date, in area: WikiArea) async throws -> WikiPage {
        guard let api else { throw APIError.signedOut }
        let day = Self.dayFormatter.string(from: date)
        let title = date.formatted(.dateTime.weekday(.wide).month(.wide).day())
        let page: WikiPage = try await api.post("v1/wiki/daily", body: WikiDailyOpen(date: day, title: title, journalTitle: "Journal", area: area))
        if let parent = page.parentID, node(parent) == nil {
            await refresh()
        } else {
            upsert(page.node)
        }
        if let parent = page.parentID { expand([parent]) }
        return page
    }

    /// The person's daily note of today in `area`, when the tree holds it.
    func today(in area: WikiArea) -> WikiNode? {
        let day = Self.dayFormatter.string(from: .now)
        return nodes.first { $0.area == area && $0.dailyDate == day }
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// The templates the person may use, in either area (contracts/wiki.md "Templates").
    func templates() async throws -> [WikiNode] {
        guard let api else { throw APIError.signedOut }
        let page: Page<WikiNode> = try await api.get("v1/wiki/templates")
        return page.data
    }

    /// A new page of the tree copied from a template, with its subpages: at the top level of
    /// `area`, or under `parentID`.
    func use(template id: String, in area: WikiArea, parentID: String? = nil, space: String? = nil, teamID: String? = nil) async throws -> WikiPage {
        guard let api else { throw APIError.signedOut }
        let body = WikiDuplicate(parentID: parentID, space: parentID == nil ? space : nil, teamID: parentID == nil ? teamID : nil, area: parentID == nil ? area : nil, template: false)
        let page: WikiPage = try await api.post("v1/wiki/pages/\(id)/duplicate", body: body)
        // Its subpages came with it: read the tree again for them.
        upsert(page.node)
        reload()
        return page
    }

    /// Deletes the page and every page under it, for good.
    func delete(_ id: String) async throws {
        guard let api else { throw APIError.signedOut }
        try await api.delete("v1/wiki/pages/\(id)")
        remove([id] + descendants(of: id).map(\.id))
    }

    /// Moves the page and its subpages to the trash; restored with `restoreFromTrash`.
    func trash(_ id: String) async throws -> WikiPage {
        guard let api else { throw APIError.signedOut }
        let page: WikiPage = try await api.post("v1/wiki/pages/\(id)/trash")
        remove([id] + descendants(of: id).map(\.id))
        return page
    }

    /// Puts a page from the trash back with what went with it, then reads the tree again.
    func restoreFromTrash(_ id: String) async throws -> WikiPage {
        guard let api else { throw APIError.signedOut }
        let page: WikiPage = try await api.post("v1/wiki/pages/\(id)/restore")
        upsert(page.node)
        reload()
        return page
    }

    /// The pages in an area's trash, last trashed first.
    func trashed(in area: WikiArea = .wiki) async throws -> [WikiTrashedPage] {
        guard let api else { throw APIError.signedOut }
        let page: Page<WikiTrashedPage> = try await api.get("v1/wiki/trash", query: [URLQueryItem(name: "area", value: area.rawValue)])
        return page.data
    }

    // MARK: Favorites

    func isFavorite(_ id: String) -> Bool { favorites.contains(id) }

    /// The favorite pages in the tree, in order.
    var favoriteNodes: [WikiNode] { favorites.compactMap { node($0) } }

    /// The favorite pages of one area, in order.
    func favoriteNodes(in area: WikiArea) -> [WikiNode] { favoriteNodes.filter { $0.area == area } }

    /// Adds the page last to the favorites, or takes it out; shown at once.
    func setFavorite(_ id: String, _ on: Bool) async throws {
        guard let api else { throw APIError.signedOut }
        let before = favorites
        var next = favorites.filter { $0 != id }
        if on { next.append(id) }
        favorites = next
        do {
            let body = try APICoding.encoder.encode(["page_ids": next])
            let saved: Page<WikiNode> = try await api.send(APIRequest(method: "PUT", path: "v1/wiki/favorites", body: body))
            favorites = saved.data.map(\.id)
        } catch {
            favorites = before
            throw error
        }
    }

    // MARK: Comments and following

    func comments(_ pageID: String) async throws -> WikiComments {
        guard let api else { throw APIError.signedOut }
        return try await api.get("v1/wiki/pages/\(pageID)/comments")
    }

    /// A new thread on the page, or a reply in `thread`.
    func comment(on pageID: String, bodyHTML: String, thread: String?) async throws -> WikiThread {
        guard let api else { throw APIError.signedOut }
        return try await api.post("v1/wiki/pages/\(pageID)/comments", body: WikiCommentCreate(bodyHTML: bodyHTML, threadID: thread))
    }

    func resolve(thread: String, _ resolved: Bool) async throws -> WikiThread {
        guard let api else { throw APIError.signedOut }
        return try await api.post("v1/wiki/threads/\(thread)/resolve", body: ["resolved": resolved])
    }

    /// Follows or unfollows the page; answers whether the person follows it now.
    func follow(_ pageID: String, _ on: Bool) async throws -> Bool {
        guard let api else { throw APIError.signedOut }
        let body = try APICoding.encoder.encode(WikiFollowing(following: on))
        let answer: WikiFollowing = try await api.send(APIRequest(method: "PUT", path: "v1/wiki/pages/\(pageID)/follow", body: body))
        return answer.following
    }

    // MARK: Databases

    /// A database's rows, in order, with their values.
    func rows(of databaseID: String) async throws -> [WikiDbRow] {
        guard let api else { throw APIError.signedOut }
        let rows: WikiDbRows = try await api.get("v1/wiki/databases/\(databaseID)/rows")
        return rows.data
    }

    /// Pages of both areas matching `text` (each hit says its area), or of `area` alone.
    func search(_ text: String, area: WikiArea? = nil) async throws -> [WikiSearchHit] {
        guard let api else { throw APIError.signedOut }
        var query = [URLQueryItem(name: "q", value: text), URLQueryItem(name: "limit", value: "30")]
        if let area { query.append(URLQueryItem(name: "area", value: area.rawValue)) }
        let page: Page<WikiSearchHit> = try await api.get("v1/wiki/search", query: query)
        return page.data
    }

    // MARK: History

    func revisions(_ id: String) async throws -> [WikiRevision] {
        guard let api else { throw APIError.signedOut }
        let page: Page<WikiRevision> = try await api.get("v1/wiki/pages/\(id)/revisions")
        return page.data
    }

    func revision(_ id: String, _ revisionID: String) async throws -> WikiRevision {
        guard let api else { throw APIError.signedOut }
        return try await api.get("v1/wiki/pages/\(id)/revisions/\(revisionID)")
    }

    /// Puts the revision's title, icon and body back as a new version.
    func restore(_ id: String, _ revisionID: String) async throws -> WikiPage {
        guard let api else { throw APIError.signedOut }
        let page: WikiPage = try await api.post("v1/wiki/pages/\(id)/revisions/\(revisionID)/restore")
        upsert(page.node)
        return page
    }

    // MARK: Savers

    /// The saver of a page, one per page, so typing survives leaving the page:
    /// an idle one takes `page` when it is newer.
    func saver(for page: WikiPage) -> WikiSaver {
        if let current = savers[page.id] {
            if !current.busy, current.status == .saved, current.isNewer(page.version) { current.rebase(page) }
            return current
        }
        let saver = WikiSaver(page: page, workspaceID: workspaceID, store: self)
        savers[page.id] = saver
        return saver
    }

    func openSaver(_ id: String) -> WikiSaver? { savers[id] }

    func forgetSaver(_ id: String) {
        savers[id]?.cancel()
        savers[id] = nil
    }

    /// Sends what every page holds unsent (the app going to the background).
    func flushAll() {
        for saver in savers.values where saver.busy && !saver.final {
            Task { await saver.flush() }
        }
    }

    // MARK: Cache

    private func upsert(_ node: WikiNode) {
        if let index = nodes.firstIndex(where: { $0.id == node.id }) {
            let parentChanged = nodes[index].parentID != node.parentID
            let old = nodes[index].parentID
            nodes[index] = node
            if parentChanged { renumber(old) }
        } else {
            nodes.append(node)
        }
    }

    private func remove(_ ids: [String]) {
        let gone = Set(ids)
        let parents = Set(nodes.filter { gone.contains($0.id) }.map(\.parentID))
        nodes.removeAll { gone.contains($0.id) }
        expanded.subtract(gone)
        favorites.removeAll { gone.contains($0) }
        for id in ids { forgetSaver(id) }
        for parent in parents { renumber(parent) }
    }

    /// Numbers the subpages of `parentID` again from 0, as the server does after a move or delete.
    private func renumber(_ parentID: String?) {
        let ordered = children(of: parentID)
        for (position, child) in ordered.enumerated() {
            if let index = nodes.firstIndex(where: { $0.id == child.id }), nodes[index].position != position { nodes[index].position = position }
        }
    }

    // MARK: Realtime

    func handle(_ update: RealtimeUpdate) {
        switch update {
        case .resync:
            reload()
        case let .envelope(envelope):
            switch envelope.type {
            case "wiki_page.created", "wiki_page.updated":
                if let node = envelope.member("wiki_page", as: WikiNode.self) { upsert(node) }
            case "wiki_page.moved", "wiki_page.restored":
                reload()
            case "wiki_page.deleted":
                var ids = envelope.data["wiki_page_ids"]?.array?.compactMap(\.string) ?? []
                if let id = envelope.string("wiki_page_id"), !ids.contains(id) { ids.append(id) }
                remove(ids)
            case "wiki_comment.changed":
                if let page = envelope.string("page_id") { commentChanges[page, default: 0] += 1 }
            default:
                break
            }
        }
    }
}

/// Where top-level pages live (contracts/wiki.md "Private pages and teamspaces").
enum WikiSection: Hashable {
    case workspace
    /// The person's own pages.
    case personal
    /// A team's teamspace.
    case team(String)
}

/// A page in the flattened tree, with how deep it sits (0: the top level).
struct WikiOutlineItem: Identifiable, Hashable {
    let node: WikiNode
    let level: Int
    var id: String { node.id }
}

/// Autosave for one wiki page (contracts/wiki.md "Editing together", web `lib/wiki/saver.ts`).
/// Holds what was typed and sends it a moment after typing stops, one request at a
/// time, each with the version it edited. Only edits are sent: loading a version is
/// never a save. A `403` or `404` stops it for good, keeping the typing to copy.
@MainActor
@Observable
final class WikiSaver {
    enum Status: Equatable {
        /// Nothing left to send.
        case saved
        /// Typed, waiting for the pause.
        case dirty
        /// A request is out.
        case saving
        /// The last one failed; it is retried.
        case error
        /// Someone else saved first.
        case conflict
        /// The person may not edit the page (403).
        case forbidden
        /// The page is gone (404).
        case deleted

        var halted: Bool { self == .conflict || self == .forbidden || self == .deleted }
    }

    struct Draft: Equatable {
        var title: String
        var icon: String
        var body: String
    }

    static let delay: Duration = .milliseconds(800)
    static let retryDelay: Duration = .seconds(4)

    let id: String
    private(set) var version: Int
    /// What the person sees.
    private(set) var draft: Draft
    private(set) var status: Status = .saved
    private(set) var lastSavedAt: Date?
    /// The page as the last save or load left it.
    private(set) var page: WikiPage

    /// What the server holds, as this saver last sent or loaded it.
    @ObservationIgnored private var base: Draft
    @ObservationIgnored private var force = false
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var inflight: Task<Void, Never>?
    @ObservationIgnored private let workspaceID: String?
    @ObservationIgnored private weak var store: WikiStore?

    init(page: WikiPage, workspaceID: String?, store: WikiStore) {
        id = page.id
        version = page.version
        self.page = page
        self.workspaceID = workspaceID
        self.store = store
        base = Self.draft(of: page)
        draft = base
    }

    /// A page's fields as the editor holds them: the body in the form the text editor
    /// writes back, so opening the editor alone never counts as a change.
    static func draft(of page: WikiPage) -> Draft {
        Draft(title: page.title, icon: page.icon, body: normalize(page.bodyHTML))
    }

    static func normalize(_ html: String) -> String {
        KBMarkdown.markdown(from: html).map { KBMarkdown.html(from: $0) } ?? html
    }

    /// There is typing the server has not stored yet.
    var pending: Bool { force || draft != base }
    var busy: Bool { inflight != nil || pending }
    /// Saving stopped for good: what is pending can only be copied.
    var final: Bool { status == .forbidden || status == .deleted }

    func edit(title: String? = nil, icon: String? = nil, body: String? = nil) {
        var next = draft
        if let title { next.title = String(title.prefix(WikiText.maxTitle)) }
        if let icon { next.icon = icon }
        if let body { next.body = body }
        guard next != draft else { return }
        draft = next
        if !status.halted, status != .saving { status = pending ? .dirty : .saved }
        schedule(Self.delay)
    }

    private func schedule(_ delay: Duration) {
        timer?.cancel()
        guard !status.halted else { return }
        timer = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.flush()
        }
    }

    /// Sends what is pending now.
    func flush() async {
        timer?.cancel()
        guard !status.halted else { return }
        if let inflight {
            await inflight.value
            return await flush()
        }
        let patch = makePatch()
        guard !patch.isEmpty else {
            if status != .saved { status = .saved }
            return
        }
        let sending = draft
        status = .saving
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                guard let store else { throw APIError.signedOut }
                let saved = try await store.update(id, patch, workspaceID: workspaceID)
                version = saved.version
                page = saved
                base = sending
                force = false
                lastSavedAt = .now
                status = pending ? .dirty : .saved
            } catch {
                let api = error as? APIError
                status = switch (api?.status, api?.code) {
                case (409, _), (_, "page_changed"?): .conflict
                case (_, "page_in_trash"?): .deleted
                case (403, _): .forbidden
                case (404, _): .deleted
                default: .error
                }
            }
            inflight = nil
            if status == .dirty { schedule(Self.delay) }
            if status == .error { schedule(Self.retryDelay) }
        }
        inflight = task
        await task.value
    }

    private func makePatch() -> WikiPagePatch {
        var patch = WikiPagePatch(version: version)
        if force || draft.title != base.title { patch.title = draft.title }
        if force || draft.icon != base.icon { patch.icon = draft.icon }
        if force || draft.body != base.body { patch.bodyHTML = draft.body }
        return patch
    }

    /// Takes a page someone else saved (or a restored version) as it is.
    func rebase(_ page: WikiPage) {
        timer?.cancel()
        self.page = page
        version = page.version
        force = false
        base = Self.draft(of: page)
        draft = base
        status = .saved
    }

    /// After a conflict: keeps what was typed and saves it over the newer version.
    func overwrite(latest: WikiPage) {
        page = latest
        version = latest.version
        force = true
        status = .dirty
        Task { await flush() }
    }

    func isNewer(_ version: Int) -> Bool { version > self.version }

    /// The page's look, aliases, lock, verification or values changed, which keeps its version:
    /// taken as it is, and what was typed is left alone.
    func takeLook(_ fresh: WikiPage) {
        guard fresh.id == id else { return }
        var next = page
        next.extras = fresh.extras
        next.locked = fresh.locked
        next.verification = fresh.verification
        page = next
    }

    func cancel() {
        timer?.cancel()
    }
}
