import SwiftUI

/// The screen for a route pushed on the Inbox or Notifications stack.
struct AppRouteDestination: View {
    let route: AppRoute

    var body: some View {
        switch route {
        case let .ticket(route): TicketView(route: route)
        case let .contact(id): ContactDetailView(id: id)
        case let .company(id): CompanyDetailView(id: id)
        case let .mailThread(id): MailThreadView(id: id)
        case let .article(id): ArticleView(id: id)
        case let .changelogEntry(id): ChangelogEntryView(id: id)
        case let .wikiPage(id): WikiPageView(id: id)
        case let .wikiTrash(area): WikiTrashView(area: area)
        case let .wikiTemplates(area): WikiTemplatesView(area: area)
        case let .wikiTeamspace(area, team): WikiTeamspaceView(area: area, teamID: team)
        case let .wikiGraph(area): WikiGraphView(area: area)
        case let .wikiTags(area): WikiTagsView(area: area)
        case .search: SearchView()
        }
    }
}

/// Beside an area's list in columns, before a row opens anything.
struct AreaPlaceholder: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        switch env.router.shownArea {
        case .tickets: ColumnPlaceholder(symbol: "tray", title: "Pick a ticket", message: "Its conversation opens here, beside the list.")
        case .mail: ColumnPlaceholder(symbol: "envelope", title: "Pick a conversation", message: "It opens here, beside your mail.")
        case .contacts: ColumnPlaceholder(symbol: "person.2", title: "Pick a contact", message: "Their details and tickets open here.")
        case .companies: ColumnPlaceholder(symbol: "building.2", title: "Pick a company", message: "Its people and tickets open here.")
        case .kb: ColumnPlaceholder(symbol: "book.closed", title: "Pick an article", message: "It opens here to read or edit.")
        case .wiki: ColumnPlaceholder(symbol: "book.pages", title: "Pick a page", message: "It opens here to read or edit.")
        case .pages: ColumnPlaceholder(symbol: "doc.richtext", title: "Pick a page", message: "Pages, databases and canvases open here.")
        case .reports: ColumnPlaceholder(symbol: "chart.bar.xaxis", title: "Reports", message: "Pick a report in the list.")
        case .everywhere: ColumnPlaceholder(symbol: "globe", title: "Pick a row", message: "This workspace's open here. Another workspace's open in that workspace.")
        }
    }
}

/// The Inbox tab's root for the area picked in the menu (the workspace's home while the
/// picked one is turned off).
struct AreaRootView: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        switch env.router.shownArea {
        case .tickets: InboxListView()
        case .mail: MailListView()
        case .contacts: ContactsListView()
        case .companies: CompaniesListView()
        case .kb: KBListView()
        case .wiki: WikiListView(area: .wiki)
        case .pages: WikiListView(area: .pages)
        case .reports: ReportsView()
        case .everywhere: EverywhereListView()
        }
    }
}
