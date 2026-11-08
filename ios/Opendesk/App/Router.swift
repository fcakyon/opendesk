import Observation
import SwiftUI

/// A ticket pushed on the inbox stack. `seed` shows the row's copy while the full ticket loads.
struct TicketRoute: Hashable {
    let id: String
    var seed: Ticket?

    static func == (lhs: TicketRoute, rhs: TicketRoute) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// Anything pushed on the Inbox or Notifications stack (`AppRouteDestination` draws it).
enum AppRoute: Hashable {
    case ticket(TicketRoute)
    case contact(String)
    case company(String)
    /// A Collab conversation.
    case mailThread(String)
    /// A knowledge base article; `"new"` starts one.
    case article(String)
    /// A changelog entry; `"new"` starts one.
    case changelogEntry(String)
    /// A page of the wiki or of Pages (the page says which).
    case wikiPage(String)
    /// An area's trash.
    case wikiTrash(WikiArea)
    /// The templates new pages start from (shared by both areas, made in this one).
    case wikiTemplates(WikiArea)
    /// One teamspace's pages in an area.
    case wikiTeamspace(WikiArea, String)
    /// An area's graph of pages and links.
    case wikiGraph(WikiArea)
    /// An area's tags and their pages.
    case wikiTags(WikiArea)
    case search

    static func ticket(_ ticket: Ticket) -> AppRoute { .ticket(TicketRoute(id: ticket.id, seed: ticket)) }
}

/// What the Inbox tab shows at its root, chosen from the menu.
enum AppArea: String, CaseIterable, Identifiable, Sendable {
    case tickets, mail, contacts, companies, kb, wiki, pages, reports
    /// An Everywhere list across workspaces (`Router.everywhere` says which).
    case everywhere

    var id: String { rawValue }

    var title: String {
        switch self {
        case .tickets: "Tickets"
        case .mail: "Mail"
        case .contacts: "Contacts"
        case .companies: "Companies"
        case .kb: "Knowledge base"
        case .wiki: "Wiki"
        case .pages: "Pages"
        case .reports: "Reports"
        case .everywhere: "Everywhere"
        }
    }

    var symbol: String {
        switch self {
        case .tickets: "tray"
        case .mail: "envelope"
        case .contacts: "person.2"
        case .companies: "building.2"
        case .kb: "book.closed"
        case .wiki: "book.pages"
        case .pages: "doc.richtext"
        case .reports: "chart.bar.xaxis"
        case .everywhere: "globe"
        }
    }
}

/// Tabs, the stacks, and links from outside the app (universal links,
/// `opendesk://open?path=`, notification taps).
@MainActor
@Observable
final class Router {
    var tab: AppTab = .inbox
    var area: AppArea = .tickets
    /// The Everywhere list the Inbox tab shows while `area` is `.everywhere`.
    var everywhere: EverywhereList = .mine
    var inboxPath: [AppRoute] = []
    var notificationsPath: [AppRoute] = []
    var accountPath: [AccountRoute] = []
    var showOllie = false
    /// The ticket on screen, so a push for it stays quiet in the foreground.
    var visibleTicketID: String?
    /// On while the window is wide enough for a list beside what it opened (iPhone Duo open).
    var wide = false
    /// The tab on screen shows its list and its stack side by side (`AdaptiveStack`): in a wide
    /// window, for every tab but Reports, which is one page of its own.
    var columns: Bool { wide && !(tab == .inbox && shownArea == .reports) }
    /// The list column's width while `columns` is on.
    var listWidth: CGFloat = 360

    @ObservationIgnored weak var environment: AppEnvironment?
    @ObservationIgnored private var pending: DeepLink.Target?

    func reset() {
        area = .tickets
        inboxPath = []
        notificationsPath = []
        accountPath = []
        visibleTicketID = nil
        showOllie = false
    }

    /// A URL the app was asked to open.
    func handle(url: URL) {
        guard let env = environment else { return }
        // OAuth callbacks are answered by the web authentication session itself.
        if url.scheme == "opendesk", url.host() == "auth" { return }
        #if DEBUG
        if url.scheme == "opendesk", url.host() == "demo" {
            if DemoMode.isOn { return openDemo(url.path()) }
            // `opendesk://demo` on the sign-in screen opens the demo workspace.
            if env.session.phase == .signedOut { Task { await env.session.enterDemo() } }
            return
        }
        #endif
        guard let target = DeepLink.parse(url: url, instance: env.session.instance) else {
            if url.scheme == "opendesk" { env.toasts.show("That link isn't one the app can open.") }
            return
        }
        open(target)
    }

    func open(_ target: DeepLink.Target) {
        guard let env = environment else { return }
        let session = env.session
        guard session.phase == .ready else {
            pending = target
            return
        }
        if let server = target.server, let url = URL(string: server), PushPayload.origin(url) != PushPayload.origin(session.instance.apiURL) {
            // An account signed in on that server opens first (SessionStore accounts).
            if let account = session.accounts.first(where: { PushPayload.origin($0.instance.apiURL) == PushPayload.origin(url) }) {
                pending = target
                Task { await session.switchAccount(to: account.id) }
                return
            }
            env.toasts.show("That's from another opendesk server (\(url.host() ?? server)). Add an account there in Account to open it.")
            return
        }
        if let workspaceID = target.workspaceID, workspaceID != session.workspace?.id {
            guard let membership = session.memberships.first(where: { $0.id == workspaceID }) else {
                env.toasts.show("You're not a member of that workspace.")
                return
            }
            pending = DeepLink.Target(link: target.link, server: nil, workspaceID: nil)
            env.switchWorkspace(to: membership)
            return
        }
        go(target.link)
    }

    /// Opens what waited for sign-in or a workspace switch.
    func workspaceReady() {
        keepAreaAvailable()
        #if DEBUG
        if let screen = pendingDemoScreen {
            pendingDemoScreen = nil
            openDemo(screen)
        }
        #endif
        if let env = environment { SpacesStore.shared.workspaceReady(env) }
        guard let target = pending else { return }
        pending = nil
        open(target)
    }

    private func go(_ link: DeepLink) {
        guard let env = environment else { return }
        showOllie = false
        switch link {
        case let .ticket(id, scope):
            // The link's folder or view becomes the list behind the ticket, as on the web.
            if let scope { env.inbox.setScope(scope) }
            show(.tickets, [.ticket(TicketRoute(id: id))])
        case let .scope(scope):
            env.inbox.setScope(scope)
            show(.tickets, [])
        case .notifications:
            tab = .notifications
            notificationsPath = []
        case let .contact(id):
            show(.contacts, id.map { [.contact($0)] } ?? [])
        case let .company(id):
            show(.companies, id.map { [.company($0)] } ?? [])
        case let .mail(thread):
            show(.mail, thread.map { [.mailThread($0)] } ?? [])
        case let .article(id):
            show(.kb, id.map { [.article($0)] } ?? [])
        case .kb:
            show(.kb, [])
        case let .changelog(id):
            KBStore.shared.mode = .changelog
            show(.kb, id.map { [.changelogEntry($0)] } ?? [])
        case let .wiki(id):
            if let id { openPage(id, area: .wiki) } else { show(.wiki, []) }
        case let .pages(id):
            if let id { openPage(id, area: .pages) } else { show(.pages, []) }
        case let .wikiPlace(area, place):
            switch place {
            case .trash: show(area.appArea, [.wikiTrash(area)])
            case .templates: show(area.appArea, [.wikiTemplates(area)])
            case let .teamspace(team): show(area.appArea, [.wikiTeamspace(area, team)])
            case .graph: show(area.appArea, [.wikiGraph(area)])
            case .tags: show(area.appArea, [.wikiTags(area)])
            }
        case .reports:
            show(.reports, [])
        }
    }

    /// The Inbox tab at `area` with `path` on top of it. An area the workspace has turned off
    /// gives way to its home, without the tickets that were to open in it (as the web redirects).
    func show(_ area: AppArea, _ path: [AppRoute]) {
        let products = environment?.products ?? Products()
        if products.allows(area) {
            self.area = area
            inboxPath = path
        } else {
            self.area = products.home
            inboxPath = path.filter { if case .ticket = $0 { false } else { true } }
            if path.contains(where: { if case .ticket = $0 { true } else { false } }) {
                environment?.toasts.show("Tickets are turned off in this workspace.")
            }
        }
        tab = .inbox
    }

    /// Opens a page of the wiki or of Pages with its area's list behind it. A link may name the
    /// other area (contracts/pages.md "Routes"): the tree's own answer wins, and a page not in it
    /// yet moves to its area once it loads (`pageLoaded`).
    func openPage(_ id: String, area: WikiArea) {
        let known = WikiStore.shared.node(id)?.area ?? area
        show(known.appArea, [.wikiPage(id)])
    }

    /// A page opened from a link reads its own area: the Inbox tab moves to that area's list
    /// when it was opened under the other one, as the web redirects `/wiki/<id>` and `/pages/<id>`.
    func pageLoaded(_ id: String, area: WikiArea) {
        guard tab == .inbox, shownArea == .wiki || shownArea == .pages, shownArea != area.appArea,
              inboxPath.first == .wikiPage(id), environment?.products.allows(area.appArea) ?? true
        else { return }
        self.area = area.appArea
    }

    /// Never leaves the Inbox tab on an area the workspace no longer offers (a switch, or a
    /// product turned off while it was open).
    func keepAreaAvailable() {
        let products = environment?.products ?? Products()
        guard !products.allows(area) else { return }
        area = products.home
        inboxPath = []
    }

    /// The area the Inbox tab draws: the picked one, or the workspace's home while it is off.
    var shownArea: AppArea {
        let products = environment?.products ?? Products()
        return products.allows(area) ? area : products.home
    }

    /// Pushes `route` on the stack of the tab on screen.
    func push(_ route: AppRoute) {
        switch tab {
        case .notifications: notificationsPath.append(route)
        default: inboxPath.append(route)
        }
    }

    /// Opens `route` from the list at the root of the tab on screen: beside the list in
    /// `columns`, in place of what was open there, and pushed on the stack otherwise.
    func pick(_ route: AppRoute) {
        guard columns else { return push(route) }
        switch tab {
        case .notifications: notificationsPath = [route]
        default: inboxPath = [route]
        }
    }

    /// Opens an Account page from the tab's home, as `pick` does.
    func pick(_ route: AccountRoute) {
        if columns { accountPath = [route] } else { accountPath.append(route) }
    }

    /// What the list at the root of the tab on screen has open beside it.
    var picked: AppRoute? {
        guard columns else { return nil }
        return tab == .notifications ? notificationsPath.first : inboxPath.first
    }

    /// Whether `ticket` is open beside its list; a link may name it by id or by number.
    func isPicked(_ ticket: Ticket) -> Bool {
        guard case let .ticket(route)? = picked else { return false }
        return route.id == ticket.id || route.id == String(ticket.number)
    }

    /// What Ollie is told about the screen behind it (contracts/ai.md page context).
    var assistantContext: AssistantPageContext {
        guard let env = environment else { return AssistantPageContext(page: "inbox") }
        let top = tab == .notifications ? notificationsPath.last : inboxPath.last
        if case let .ticket(route)? = top {
            return AssistantPageContext(page: "ticket", path: env.inbox.scope.webPath(ticketID: route.id), ticketID: route.id)
        }
        if case let .wikiPage(id)? = top {
            let area = WikiStore.shared.node(id)?.area ?? (shownArea == .pages ? .pages : .wiki)
            return AssistantPageContext(page: "wiki", path: "\(area.path)/\(id)", wikiPageID: id)
        }
        switch (tab, shownArea) {
        case (.inbox, .tickets):
            var context = AssistantPageContext(page: "inbox", path: env.inbox.scope.webPath())
            switch env.inbox.scope {
            case let .folder(folder), let .mailbox(_, folder): context.folder = folder.rawValue
            case let .view(id):
                context.page = "view"
                context.viewID = id
            case .team: break
            }
            return context
        case (.inbox, .contacts), (.inbox, .companies): return AssistantPageContext(page: "contacts", path: "/" + area.rawValue)
        case (.inbox, .kb): return AssistantPageContext(page: "kb", path: "/kb")
        case (.inbox, .wiki): return AssistantPageContext(page: "wiki", path: "/wiki")
        case (.inbox, .pages): return AssistantPageContext(page: "wiki", path: "/pages")
        case (.inbox, .reports): return AssistantPageContext(page: "reports", path: "/reports")
        case (.inbox, .mail): return AssistantPageContext(page: "mail", path: "/mail")
        case (.account, _): return AssistantPageContext(page: "settings", path: "/settings/profile")
        default: return AssistantPageContext(page: "inbox", path: env.inbox.scope.webPath())
        }
    }

    #if DEBUG
    @ObservationIgnored private var pendingDemoScreen: String?

    /// A screen state the QA harness asked for (`/demo/<action>`, e.g. `/demo/ticket-details`).
    /// Screens with sheets or modes no path names watch this and clear it once handled.
    var demoAction: String?

    /// Demo mode takes app paths without the system's "Open in" prompt, for the QA harness:
    /// `OPENDESK_DEMO_OPEN=<path>` at launch, and during a run the path written to the app's
    /// `tmp/opendesk-demo-open` followed by the Darwin notification `sh.opendesk.demo.open`.
    func startDemoLinks() {
        if let path = AppInfo.debugValue("OPENDESK_DEMO_OPEN") { openDemo(path) }
        DemoLinks.watch { [weak self] path in self?.openDemo(path) }
    }

    /// Any path `DeepLink` reads (`/inbox/unassigned/<id>`, `/views/<id>`, `/notifications`),
    /// an `opendesk://` URL, or a screen no link names: `/account`, `/ollie`.
    func openDemo(_ raw: String) {
        let path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if path.hasPrefix("opendesk://"), let url = URL(string: path) { return handle(url: url) }
        guard environment?.session.phase == .ready else {
            pendingDemoScreen = path
            return
        }
        let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let parts = trimmed.split(separator: "/").map(String.init)
        switch parts.first ?? "" {
        case "account":
            showOllie = false
            tab = .account
            accountPath = AccountRoute.stack(from: Array(parts.dropFirst()))
        case "ollie":
            showOllie = true
        case "inbox" where parts.count == 1:
            showOllie = false
            show(.tickets, [])
        case "mail" where parts.count == 1:
            showOllie = false
            show(.mail, [])
        case "companies" where parts.count == 1:
            showOllie = false
            show(.companies, [])
        case "search":
            showOllie = false
            show(area, [.search])
        case "everywhere":
            showOllie = false
            openEverywhere(parts.count > 1 ? EverywhereList(rawValue: parts[1]) ?? .mine : .mine)
        case "demo":
            demoAction = parts.dropFirst().joined(separator: "/")
        default:
            guard let link = DeepLink.parse(path: path) else { return }
            open(DeepLink.Target(link: link, server: nil, workspaceID: nil))
        }
    }
    #endif

    func openTicket(_ ticket: Ticket) {
        push(.ticket(ticket))
    }
}
