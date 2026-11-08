import Foundation
import Observation

/// A page as a Space row names it (`GET /v1/wiki/pages`, the part a row needs).
struct SpacePage: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var parentID: String?
    var title: String
    var icon: String?
    /// "pages" or "wiki" (contracts/pages.md).
    var area: String
    var kind: String
    var teamID: String?
    var isPrivate: Bool

    enum CodingKeys: String, CodingKey {
        case id, title, icon, area, kind
        case parentID = "parent_id"
        case teamID = "team_id"
        case isPrivate = "private"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        parentID = c.lenient(String.self, forKey: .parentID)
        title = c.lenient(String.self, forKey: .title) ?? ""
        icon = c.lenient(String.self, forKey: .icon).flatMap { $0.isEmpty ? nil : $0 }
        area = c.lenient(String.self, forKey: .area) ?? "wiki"
        kind = c.lenient(String.self, forKey: .kind) ?? "page"
        teamID = c.lenient(String.self, forKey: .teamID)
        isPrivate = c.lenient(Bool.self, forKey: .isPrivate) ?? false
    }

    var displayTitle: String { SpaceRules.clean(title).isEmpty ? "Untitled" : title }

    /// The app path that opens it, in its own area.
    var path: String { (area == "pages" ? "/pages/" : "/wiki/") + id }

    /// What a page of its kind is drawn with, when it has no emoji of its own.
    var symbol: String {
        switch kind {
        case "database": "tablecells"
        case "canvas": "square.on.square.dashed"
        default: "doc.text"
        }
    }
}

/// What one workspace offers a Space's rows and its editor: teams, views, mail accounts and
/// their folders, ticket inboxes and pages, read with that workspace's `OD-Workspace`.
struct SpaceWorkspaceData: Sendable {
    var teams: [Team] = []
    var views: [SavedView] = []
    var accounts: [MailAccount] = []
    var folders: [String: [MailFolder]] = [:]
    var mailboxes: [InboxMailbox] = []
    /// Pages and the wiki's pages the person sees, each area in its tree order.
    var pages: [SpacePage] = []
    /// The workspace has Pages on (its list answered).
    var pagesOn = false
    var loaded = false
    var foldersLoaded = false

    var allFolders: [MailFolder] { folders.values.flatMap { $0 } }
}

/// Where a Space row goes, in its own workspace.
enum SpaceDestination: Hashable, Sendable {
    case folder(Folder)
    case team(String)
    case view(String)
    case mailBox(MailBox)
    case mailAccount(String)
    case mailFolder(id: String, account: String)
    case area(AppArea)
    /// An app path, opened as a link to it would be (`/pages/<id>`, `/inbox/unassigned?mailbox=<id>`).
    case path(String)
    /// An Everywhere list: of no workspace, it opens where you are.
    case everywhere(EverywhereList)
}

/// The person's Spaces (contracts/spaces.md): one list per user, the same in every workspace and
/// on every device, saved whole with `PUT /v1/me/spaces`. What is picked, a Space or the open
/// workspace, is remembered on this device per server and user.
@MainActor
@Observable
final class SpacesStore {
    static let shared = SpacesStore()

    private(set) var spaces: [Space] = []
    /// The person saved Spaces at least once (`saved` in the answer).
    private(set) var saved = false
    private(set) var loaded = false
    private(set) var error: String?
    private(set) var pickedID: String?
    private(set) var data: [String: SpaceWorkspaceData] = [:]
    /// Each workspace's starter Space, once asked for (nil inside: it has none).
    private(set) var starters: [String: Space?] = [:]
    private(set) var saving = false

    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var key: String?
    @ObservationIgnored private var pickedKey = ""
    @ObservationIgnored private var dataTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var pending: (workspace: String, destination: SpaceDestination)?

    // MARK: Lifecycle

    /// Starts for the signed-in person; a second call for the same one keeps what is loaded.
    func start(env: AppEnvironment) {
        guard let user = env.session.user?.id else { return }
        let api = env.session.api
        let key = "\(ObjectIdentifier(api).hashValue)/\(user)"
        guard key != self.key else { return }
        self.key = key
        self.api = api
        spaces = []
        saved = false
        loaded = false
        error = nil
        data = [:]
        starters = [:]
        for task in dataTasks.values { task.cancel() }
        dataTasks = [:]
        pickedKey = "spaces.picked." + api.instance.storageKey + "." + user
        pickedID = UserDefaults.standard.string(forKey: pickedKey)
        Task { await load() }
    }

    func load() async {
        guard let api else { return }
        do {
            let list: SpacesList = try await api.get("v1/me/spaces", workspace: .none)
            spaces = list.spaces
            saved = list.saved
            error = nil
        } catch {
            if !loaded { self.error = (error as? APIError)?.userMessage ?? "Couldn't load your Spaces." }
        }
        loaded = true
    }

    /// Reads the list again (the menu opened): another device may have changed it.
    func refresh() {
        guard loaded, !saving else { return }
        Task { await load() }
    }

    // MARK: Picking

    /// The picked Space, or nil: none picked, or the remembered one is gone (the workspace shows).
    var picked: Space? {
        guard let pickedID else { return nil }
        return spaces.first { $0.id == pickedID }
    }

    /// Picks a Space, or the open workspace (nil). Never switches the workspace.
    func pick(_ id: String?) {
        pickedID = id
        if let id { UserDefaults.standard.set(id, forKey: pickedKey) } else { UserDefaults.standard.removeObject(forKey: pickedKey) }
    }

    // MARK: Saving

    /// Replaces the whole list, shown at once and put back if the server refuses.
    @discardableResult
    func save(_ next: [Space]) async -> String? {
        guard let api else { return "Sign in again to save your Spaces." }
        let previous = spaces
        spaces = next
        saving = true
        defer { saving = false }
        struct Body: Encodable { let spaces: [Space] }
        do {
            var request = APIRequest(method: "PUT", path: "v1/me/spaces", body: try APICoding.encoder.encode(Body(spaces: next)))
            request.workspace = .none
            let answer: SpacesList = try await api.send(request)
            spaces = answer.spaces
            saved = answer.saved
            return nil
        } catch {
            spaces = previous
            return (error as? APIError)?.userMessage ?? "Couldn't save your Spaces."
        }
    }

    /// Adds `space` or replaces the one with its id.
    @discardableResult
    func upsert(_ space: Space) async -> String? {
        var next = spaces
        if let index = next.firstIndex(where: { $0.id == space.id }) { next[index] = space } else { next.append(space) }
        return await save(next)
    }

    @discardableResult
    func delete(_ id: String) async -> String? {
        let failure = await save(spaces.filter { $0.id != id })
        if failure == nil, pickedID == id { pick(nil) }
        return failure
    }

    @discardableResult
    func duplicate(_ id: String) async -> String? {
        guard let space = spaces.first(where: { $0.id == id }) else { return nil }
        var copy = space
        copy.id = UUID().uuidString.lowercased()
        copy.name = SpaceRules.uniqueName(space.name, in: spaces)
        return await save(spaces + [copy])
    }

    /// Moves a Space one place up (-1) or down (1) in the switcher.
    @discardableResult
    func move(_ id: String, by step: Int) async -> String? {
        guard let index = spaces.firstIndex(where: { $0.id == id }) else { return nil }
        let target = index + step
        guard spaces.indices.contains(target) else { return nil }
        var next = spaces
        next.swapAt(index, target)
        return await save(next)
    }

    /// A section folded or opened in the sheet, kept with the Space.
    func setCollapsed(_ collapsed: Bool, section: String, in spaceID: String) {
        guard var space = spaces.first(where: { $0.id == spaceID }), let index = space.sections.firstIndex(where: { $0.id == section }) else { return }
        space.sections[index].collapsed = collapsed
        Task { await upsert(space) }
    }

    // MARK: Workspace data

    /// Teams, views and mail accounts of `workspace` (and, with `folders`, the accounts' folders).
    func loadData(for workspace: String, collab: Bool, folders: Bool = false) {
        let current = data[workspace]
        if current?.loaded == true, !folders || current?.foldersLoaded == true || !collab { return }
        guard dataTasks[workspace] == nil, let api else { return }
        dataTasks[workspace] = Task { [weak self] in
            let scope = WorkspaceScope.id(workspace)
            async let teams: Page<Team>? = try? api.get("v1/teams", query: [URLQueryItem(name: "limit", value: "100")], workspace: scope)
            async let views: Page<SavedView>? = try? api.get("v1/views", query: [URLQueryItem(name: "limit", value: "100")], workspace: scope)
            async let accounts: [MailAccount]? = Self.accounts(api: api, scope: scope, collab: collab)
            async let mailboxes: Page<InboxMailbox>? = try? api.get("v1/mailboxes", workspace: scope)
            async let pages: Page<SpacePage>? = try? api.get("v1/wiki/pages", query: [URLQueryItem(name: "area", value: "pages")], workspace: scope)
            async let wiki: Page<SpacePage>? = try? api.get("v1/wiki/pages", query: [URLQueryItem(name: "area", value: "wiki")], workspace: scope)
            var next = current ?? SpaceWorkspaceData()
            if let page = await teams { next.teams = page.data.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending } }
            if let page = await views { next.views = page.data.sorted { ($0.position ?? 0) < ($1.position ?? 0) } }
            if let list = await accounts { next.accounts = list }
            if let page = await mailboxes { next.mailboxes = page.data }
            let pagesList = await pages
            let wikiList = await wiki
            next.pagesOn = pagesList != nil
            next.pages = (pagesList?.data ?? []) + (wikiList?.data ?? [])
            next.loaded = true
            if folders, collab {
                var byAccount: [String: [MailFolder]] = [:]
                await withTaskGroup(of: (String, [MailFolder]?).self) { group in
                    for account in next.accounts {
                        group.addTask {
                            let list: [MailFolder]? = try? await api.get("v1/collab/accounts/\(account.id)/folders", workspace: scope)
                            return (account.id, list)
                        }
                    }
                    for await (id, list) in group { byAccount[id] = list ?? [] }
                }
                next.folders = byAccount
                next.foldersLoaded = true
            }
            guard let self, !Task.isCancelled else { return }
            self.data[workspace] = next
            self.dataTasks[workspace] = nil
        }
    }

    private nonisolated static func accounts(api: APIClient, scope: WorkspaceScope, collab: Bool) async -> [MailAccount]? {
        guard collab else { return nil }
        return try? await api.get("v1/collab/accounts", workspace: scope)
    }

    /// Reads `workspace`'s data again on its next `loadData`, showing what it had meanwhile.
    func invalidate(_ workspace: String) {
        guard dataTasks[workspace] == nil else { return }
        data[workspace]?.loaded = false
        data[workspace]?.foldersLoaded = false
    }

    /// Reads every workspace's data again (pull to refresh).
    func reloadData() {
        for task in dataTasks.values { task.cancel() }
        dataTasks = [:]
        for key in data.keys {
            data[key]?.loaded = false
            data[key]?.foldersLoaded = false
        }
    }

    // MARK: Starter Spaces

    /// Each workspace's starter Space, for the New Space menu.
    func loadStarters(_ memberships: [Membership]) {
        guard let api else { return }
        for membership in memberships where starters[membership.id] == nil {
            let id = membership.id
            Task { [weak self] in
                let answer: StarterSpace? = try? await api.get("v1/sidebar/starter", workspace: .id(id))
                guard let self, let answer else { return }
                self.starters[id] = .some(answer.space)
            }
        }
    }

    func starter(of workspace: String) -> Space? { starters[workspace] ?? nil }

    /// Reads `workspace`'s starter Space again, for its settings page.
    func reloadStarter(_ workspace: String) async {
        guard let api, let answer: StarterSpace = try? await api.get("v1/sidebar/starter", workspace: .id(workspace)) else { return }
        starters[workspace] = .some(answer.space)
    }

    /// Publishes `space` as `workspace`'s starter Space (admins). The server sets every row's
    /// workspace to `workspace`.
    func saveStarter(_ space: Space, in workspace: String) async -> String? {
        guard let api else { return "Sign in again to save the starter Space." }
        do {
            var request = APIRequest(method: "PUT", path: "v1/sidebar/starter", body: try APICoding.encoder.encode(space))
            request.workspace = .id(workspace)
            let answer: StarterSpace = try await api.send(request)
            starters[workspace] = .some(answer.space)
            return nil
        } catch {
            return (error as? APIError)?.userMessage ?? "Couldn't save the starter Space."
        }
    }

    /// Takes `workspace`'s starter Space away. Spaces people already made from it stay theirs.
    func removeStarter(in workspace: String) async -> String? {
        guard let api else { return "Sign in again to remove the starter Space." }
        do {
            try await api.delete("v1/sidebar/starter", workspace: .id(workspace))
            starters[workspace] = .some(nil)
            return nil
        } catch {
            return (error as? APIError)?.userMessage ?? "Couldn't remove the starter Space."
        }
    }

    // MARK: Opening rows

    /// Opens a row: at once in the open workspace, or in its own after switching there (the
    /// picked Space stays picked).
    func open(_ destination: SpaceDestination, in workspace: String, env: AppEnvironment) {
        if case .everywhere = destination {
            perform(destination, env: env)
            return
        }
        if workspace == env.session.workspace?.id {
            perform(destination, env: env)
            return
        }
        guard let membership = env.session.memberships.first(where: { $0.id == workspace }) else {
            env.toasts.show("You're not a member of that workspace any more.")
            return
        }
        pending = (workspace, destination)
        env.switchWorkspace(to: membership)
    }

    /// A workspace is open: Spaces load with the session (so the menu shows the picked one at
    /// once), and a row that waited for this workspace opens now.
    func workspaceReady(_ env: AppEnvironment) {
        start(env: env)
        guard let pending, pending.workspace == env.session.workspace?.id else {
            pending = nil
            return
        }
        self.pending = nil
        perform(pending.destination, env: env)
    }

    private func perform(_ destination: SpaceDestination, env: AppEnvironment) {
        switch destination {
        case let .folder(folder):
            env.inbox.setScope(.folder(folder))
            env.router.show(.tickets, [])
        case let .team(id):
            env.inbox.setScope(.team(id, .unassigned))
            env.router.show(.tickets, [])
        case let .view(id):
            env.inbox.setScope(.view(id))
            env.router.show(.tickets, [])
        case let .mailBox(box):
            openMail(MailScope(box: box), env: env)
        case let .mailAccount(id):
            openMail(MailScope(box: .inbox, accountID: id), env: env)
        case let .mailFolder(id, account):
            openMail(MailScope(box: .inbox, folderID: id, accountID: account), env: env)
        case let .area(area):
            env.router.show(area, [])
        case let .path(path):
            guard let link = DeepLink.parse(path: path) else { return }
            env.router.open(DeepLink.Target(link: link, server: nil, workspaceID: nil))
        case let .everywhere(list):
            env.router.openEverywhere(list)
        }
    }

    /// Mail follows the workspace on screen: started for it first, so the scope is kept.
    private func openMail(_ scope: MailScope, env: AppEnvironment) {
        startMail(env: env)
        MailStore.shared.setScope(scope)
        env.router.show(.mail, [])
    }

    /// Starts the mail store for the open workspace, as the Mail list does when it appears.
    func startMail(env: AppEnvironment) {
        guard let workspace = env.session.workspace?.id, let me = env.session.user?.id else { return }
        let directory = env.directory
        MailDirectoryNames.shared.directory = directory
        MailStore.shared.onStatus = { status in directory.setCollab(status.availability) }
        MailStore.shared.start(api: env.session.api, realtime: env.realtime, workspaceID: workspace, me: me)
    }
}
