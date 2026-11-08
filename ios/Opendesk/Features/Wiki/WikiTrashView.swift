import SwiftUI

/// An area's trash (contracts/wiki.md "Trash"), the wiki's or Pages': the pages moved there, last first, each
/// with where it was and when it goes for good. A page opens to read; agents and admins
/// restore it, and Delete for good follows the rule deleting a page always had.
struct WikiTrashView: View {
    var area: WikiArea = .wiki

    @Environment(AppEnvironment.self) private var env
    @State private var pages: [WikiTrashedPage] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var busy: String?
    @State private var deleting: WikiNode?

    private var store: WikiStore { WikiStore.shared }

    var body: some View {
        content
            .background(Theme.surface.ignoresSafeArea())
            .navigationTitle("Trash")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarVisibility(.visible, for: .navigationBar)
            .wikiDeleteConfirmation($deleting, under: { node in pages.first { $0.id == node.id }?.subpages ?? 0 }) { node in
                withAnimation(Motion.snappy) { pages.removeAll { $0.id == node.id } }
            }
            .onAppear {
                // Back from a page opened here: it may have been restored there.
                if loaded { Task { await load() } }
            }
            .task {
                store.attach(env)
                await load()
            }
    }

    @ViewBuilder
    private var content: some View {
        if !loaded && error == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error, pages.isEmpty {
            ErrorState(title: "Couldn't load the trash", message: error) { Task { await load() } }
                .frame(maxHeight: .infinity)
        } else if pages.isEmpty {
            ScrollView {
                EmptyState(symbol: "trash", title: "The trash is empty", message: "Pages moved to the trash stay here for 30 days, then they are deleted for good.")
                    .padding(.top, 60)
            }
            .refreshable { await load() }
        } else {
            List {
                Text("Pages stay here for 30 days, then they are deleted for good.")
                    .font(ODFont.sans(13))
                    .foregroundStyle(Theme.fg3)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Theme.surface)
                ForEach(pages) { page in row(page) }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .motion(Motion.snappy, value: pages.map(\.id))
            .refreshable { await load() }
        }
    }

    private func row(_ page: WikiTrashedPage) -> some View {
        let rule = store.purgeRule(page, role: env.session.role, me: env.session.user?.id)
        return Button { env.router.push(.wikiPage(page.id)) } label: {
            VStack(spacing: 0) {
                HStack(alignment: .top, spacing: 12) {
                    WikiPageIcon(icon: page.node.icon, size: 18, database: page.node.isDatabase)
                        .frame(width: 32, height: 32)
                        .background(Theme.hover, in: RoundedRectangle(cornerRadius: Theme.Radius.control - 2, style: .continuous))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(page.node.displayTitle)
                            .font(ODFont.sans(15, weight: .semibold))
                            .foregroundStyle(Theme.fg)
                            .lineLimit(1)
                        Text(place(page))
                            .font(ODFont.sans(12.5))
                            .foregroundStyle(Theme.fg3)
                            .lineLimit(1)
                        Text(detail(page))
                            .font(ODFont.sans(12.5))
                            .foregroundStyle(Theme.fg3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 6)
                    if busy == page.id { ProgressView().controlSize(.small) }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                Hairline(inset: 60)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .disabled(busy != nil)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(Theme.surface)
        .contextMenu { actions(page, rule: rule) }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if rule == .yes {
                Button { deleting = page.node } label: { Label("Delete for good", systemImage: "trash") }
                    .tint(Tone.red.solid)
            }
            if env.session.canWrite {
                Button { restore(page) } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
                    .tint(Tone.blue.solid)
            }
        }
    }

    @ViewBuilder
    private func actions(_ page: WikiTrashedPage, rule: WikiStore.DeleteRule) -> some View {
        Button { env.router.push(.wikiPage(page.id)) } label: { Label("Open", systemImage: "doc.text") }
        if env.session.canWrite {
            Button { restore(page) } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
        }
        if rule != .no {
            Divider()
            if let reason = rule.reason {
                Button {} label: {
                    Label("Delete for good", systemImage: "trash")
                    Text(reason)
                }
                .disabled(true)
            } else {
                Button(role: .destructive) { deleting = page.node } label: { Label("Delete for good", systemImage: "trash") }
            }
        }
    }

    /// Where it was when it went to the trash.
    private func place(_ page: WikiTrashedPage) -> String {
        if page.path.isEmpty { return page.node.isPrivate ? "Was in your private pages" : "Was at the top level" }
        return "Was in " + page.path.map(\.displayTitle).joined(separator: " / ")
    }

    /// "Moved here by Maya 3 days ago, with 2 subpages. Deleted for good on Dec 6."
    private func detail(_ page: WikiTrashedPage) -> String {
        let who = page.deletedBy.map { "Moved here by \($0.displayName)" } ?? "Moved here"
        let with = page.subpages > 0 ? ", with \(Format.plural(page.subpages, "subpage"))" : ""
        return "\(who) \(Format.relLong(page.deletedAt))\(with). Deleted for good on \(Format.shortDate(page.purgeAt))."
    }

    private func load() async {
        do {
            pages = try await store.trashed(in: area)
            error = nil
        } catch {
            guard !error.isCancellation else { return }
            self.error = error.userMessage
        }
        loaded = true
    }

    private func restore(_ page: WikiTrashedPage) {
        busy = page.id
        Task {
            defer { busy = nil }
            if await WikiTrash.restore(page.node, env: env) != nil {
                withAnimation(Motion.snappy) { pages.removeAll { $0.id == page.id } }
            }
        }
    }
}
