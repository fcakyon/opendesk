import SwiftUI

/// "Wiki" in a ticket's details (contracts/wiki.md "Ticket backlinks"): the pages of the
/// person's tree that mention the ticket, last edited first, each opening the page; nothing
/// when there are none. Kept live from `wiki_page.*` events while the details are open.
struct TicketWikiSection: View {
    let ticketID: String
    let onOpen: (String) -> Void

    @Environment(AppEnvironment.self) private var env
    @State private var pages: [WikiNode] = []
    @State private var listener: UUID?

    var body: some View {
        Group {
            if !pages.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel("Wiki")
                    Panel {
                        ForEach(Array(pages.enumerated()), id: \.element.id) { index, page in
                            if index > 0 { Hairline(inset: 44) }
                            Button { onOpen(page.id) } label: {
                                HStack(spacing: 10) {
                                    WikiPageIcon(icon: page.icon, size: 16, database: page.isDatabase)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(page.displayTitle).font(ODFont.sans(15)).foregroundStyle(Theme.fg).lineLimit(1)
                                        Text("Edited \(Format.relLong(page.updatedAt))").font(ODFont.sans(12)).foregroundStyle(Theme.fg3)
                                    }
                                    Spacer(minLength: 6)
                                    Chevron()
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(RowPressStyle())
                        }
                    }
                }
            }
        }
        .task(id: ticketID) { await load() }
        .onAppear {
            guard listener == nil else { return }
            listener = env.realtime.subscribe { update in
                guard case let .envelope(envelope) = update, envelope.type.hasPrefix("wiki_page.") else { return }
                Task { await load() }
            }
        }
        .onDisappear {
            env.realtime.unsubscribe(listener)
            listener = nil
        }
    }

    private func load() async {
        let id = ticketID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ticketID
        guard let found: Page<WikiNode> = try? await env.session.api.get("v1/tickets/\(id)/wiki") else { return }
        pages = found.data
    }
}
