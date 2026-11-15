import Foundation

/// Where a link, a notification or a push takes the app.
///
/// Ticket URLs follow the web routes: `/inbox/<folder>/<ticket_id>` and
/// `/views/<view_id>/<ticket_id>` (the last segment is the ticket id). They
/// arrive as universal links on the instance's app origin, or as
/// `opendesk://open?path=/inbox/mine/<ticket_id>`.
enum DeepLink: Hashable, Sendable {
    case ticket(id: String, scope: InboxScope?)
    case scope(InboxScope)
    case notifications
    case contact(String?)
    case company(String?)
    /// Collab mail, optionally one conversation (`/mail/<box>/<thread_id>`).
    case mail(String?)
    case article(String?)
    case kb
    /// The knowledge base's changelog, optionally one entry (`/kb/changelog/<id>`).
    case changelog(String?)
    /// The wiki, optionally one page (`/wiki/<id>`).
    case wiki(String?)
    /// Pages, optionally one page (`/pages/<id>`; contracts/pages.md "Routes").
    case pages(String?)
    /// One of an area's own views: `/pages/trash`, `/wiki/templates`, `/pages/graph`, `/pages/tags`,
    /// or a teamspace's pages (`/pages?space=<team_id>`).
    case wikiPlace(WikiArea, WikiPlace)
    case reports

    /// From a push or a link that names its server and workspace.
    struct Target: Hashable, Sendable {
        var link: DeepLink
        var server: String?
        var workspaceID: String?
    }

    /// An app path such as `/inbox/mine/<id>`, `/views/<view>/<id>`, `/inbox/open`, `/inbox/unassigned?mailbox=<id>`, `/contacts/<id>`,
    /// `/companies/<id>`, `/mail/<box>/<thread_id>`, `/kb/articles/<id>`, `/kb/changelog/<id>`, `/wiki/<id>`,
    /// `/pages/<id>`, `/pages/trash` or `/reports`.
    static func parse(path raw: String) -> DeepLink? {
        let path = raw.split(separator: "?", maxSplits: 1).first.map(String.init) ?? raw
        let segments = path.split(separator: "/").map { String($0).removingPercentEncoding ?? String($0) }.filter { !$0.isEmpty }
        guard let head = segments.first else { return nil }
        switch head {
        case "inbox":
            let folder = segments.count > 1 ? Folder(rawValue: segments[1]) : nil
            // One ticket inbox's folder (`/inbox/<folder>[/<ticket_id>]?mailbox=<id>`), Unassigned by default.
            if let mailbox = URLComponents(string: raw)?.queryItems?.first(where: { $0.name == "mailbox" })?.value, !mailbox.isEmpty {
                let scope = InboxScope.mailbox(mailbox, folder ?? .unassigned)
                if segments.count >= 3, let id = segments.last { return .ticket(id: id, scope: scope) }
                return .scope(scope)
            }
            if segments.count >= 3, let id = segments.last {
                return .ticket(id: id, scope: folder.map(InboxScope.folder))
            }
            return .scope(.folder(folder ?? .mine))
        case "views":
            guard segments.count >= 2 else { return nil }
            let view = InboxScope.view(segments[1])
            if segments.count >= 3, let id = segments.last {
                return .ticket(id: id, scope: view)
            }
            return .scope(view)
        case "teams":
            // A team inbox (`/teams/<id|mine>[/<ticket_id>][?tab=open]`).
            guard segments.count >= 2 else { return nil }
            let tab = URLComponents(string: raw)?.queryItems?.first { $0.name == "tab" }?.value.flatMap(TeamTab.init(rawValue:)) ?? .unassigned
            let team = InboxScope.team(segments[1], tab)
            if segments.count >= 3, let id = segments.last { return .ticket(id: id, scope: team) }
            return .scope(team)
        case "notifications":
            return .notifications
        case "contacts":
            return .contact(segments.count > 1 ? segments[1] : nil)
        case "companies":
            return .company(segments.count > 1 ? segments[1] : nil)
        case "mail":
            return .mail(segments.count > 2 ? segments.last : nil)
        case "kb":
            if segments.count >= 3, segments[1] == "articles" { return .article(segments[2]) }
            if segments.count >= 2, segments[1] == "changelog" { return .changelog(segments.count >= 3 ? segments[2] : nil) }
            return .kb
        case "wiki", "pages":
            let area: WikiArea = head == "pages" ? .pages : .wiki
            if segments.count > 1 {
                if let place = WikiPlace(segment: segments[1]) { return .wikiPlace(area, place) }
                return area == .pages ? .pages(segments[1]) : .wiki(segments[1])
            }
            if let team = URLComponents(string: raw)?.queryItems?.first(where: { $0.name == "space" })?.value, !team.isEmpty {
                return .wikiPlace(area, .teamspace(team))
            }
            return area == .pages ? .pages(nil) : .wiki(nil)
        case "reports":
            return .reports
        default:
            return nil
        }
    }

    /// The views of an area that are not a page (web `areaPath`), and a teamspace.
    enum WikiPlace: Hashable, Sendable {
        case trash, templates, graph, tags
        case teamspace(String)

        init?(segment: String) {
            switch segment {
            case "trash": self = .trash
            case "templates": self = .templates
            case "graph": self = .graph
            case "tags": self = .tags
            default: return nil
            }
        }
    }

    /// A universal link on `instance`'s app origin, or an `opendesk://open?path=` link.
    static func parse(url: URL, instance: Instance) -> Target? {
        if url.scheme?.lowercased() == "opendesk" {
            guard url.host()?.lowercased() == "open",
                  let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let path = components.queryItems?.first(where: { $0.name == "path" })?.value,
                  let link = parse(path: path)
            else { return nil }
            let server = components.queryItems?.first(where: { $0.name == "server" })?.value
            let workspace = components.queryItems?.first(where: { $0.name == "workspace" })?.value
            return Target(link: link, server: server, workspaceID: workspace)
        }
        guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host()?.lowercased()
        else { return nil }
        // Links for another server are opened on the web instead.
        guard host == instance.appOrigin.host()?.lowercased(), let link = parse(path: url.path() + (url.query().map { "?" + $0 } ?? "")) else { return nil }
        return Target(link: link, server: instance.apiURL.absoluteString, workspaceID: nil)
    }
}
