import Foundation

/// What the open workspace offers (contracts/api.md, `settings.tickets_enabled`,
/// `mail_available` and `settings.pages_enabled`; web `lib/products.ts`): each until the
/// workspace says otherwise.
struct Products: Equatable, Sendable {
    var tickets = true
    var mail = true
    var pages = true

    init(tickets: Bool = true, mail: Bool = true, pages: Bool = true) {
        self.tickets = tickets
        self.mail = mail
        self.pages = pages
    }

    init(_ workspace: Workspace?) {
        tickets = workspace?.ticketsOn ?? true
        mail = workspace?.mailOn ?? true
        pages = workspace?.pagesOn ?? true
    }

    /// Whether `area` is there: Tickets off takes the ticket list and Reports away, Mail off
    /// takes Mail, Pages off takes Pages (contracts/pages.md "The product").
    func allows(_ area: AppArea) -> Bool {
        switch area {
        case .tickets, .reports: tickets
        case .mail: mail
        case .pages: pages
        default: true
        }
    }

    /// Where a member lands: the inbox, else Mail, else Pages, else the workspace's people.
    var home: AppArea {
        if tickets { return .tickets }
        if mail { return .mail }
        if pages { return .pages }
        return .contacts
    }

    /// The tree a new page goes in when nothing inside an area asked: Pages', or the wiki's
    /// while the workspace has Pages off (web `useDefaultArea`).
    var newPageArea: WikiArea { pages ? .pages : .wiki }
}

@MainActor
extension AppEnvironment {
    var products: Products { Products(session.workspace?.workspace) }

    /// A change to the workspace's settings can turn a product on or off: read the
    /// membership again so `products` follows it live.
    func productsHeard(_ update: RealtimeUpdate) {
        guard case let .envelope(envelope) = update, envelope.type == "workspace.updated" else { return }
        Task { await session.membershipChanged() }
    }
}
