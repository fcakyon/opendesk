import SwiftUI

extension WikiStore {
    /// Binds the shared store to the signed-in workspace and keeps it live while `listener` is held.
    func attach(_ env: AppEnvironment) {
        attach(api: env.session.api, workspaceID: env.session.workspace?.workspace.id, pagesOn: env.products.pages)
    }
}

@MainActor
enum WikiLink {
    /// The page on the web app, for copying and sharing: `/pages/<id>` for a page of Pages.
    static func url(_ id: String, in env: AppEnvironment) -> URL? {
        let area = WikiStore.shared.node(id)?.area ?? .wiki
        return env.session.instance.webURL(path: "\(area.path)/\(id)")
    }

    static func copy(_ id: String, in env: AppEnvironment) {
        guard let url = url(id, in: env) else { return }
        UIPasteboard.general.url = url
        Haptics.success()
        env.toasts.show("Link copied", kind: .success)
    }
}

/// A page's emoji, or a plain page mark (a table for a database) when it has none.
struct WikiPageIcon: View {
    let icon: String
    var size: CGFloat = 16
    var database = false

    var body: some View {
        Group {
            if icon.isEmpty {
                Image(systemName: database ? "tablecells" : "doc.text")
                    .font(.system(size: size * 0.82, weight: .regular))
                    .foregroundStyle(Theme.fg3)
            } else {
                Text(icon).font(.system(size: size))
            }
        }
        .frame(width: size + 6, height: size + 6)
        .accessibilityHidden(true)
    }
}

/// One page in the tree: indented by its level, with a disclosure for its subpages
/// beside the row that opens it (two buttons side by side, never one inside the other).
struct WikiTreeRow: View {
    let node: WikiNode
    let level: Int
    let subpages: Int
    let expanded: Bool
    let onToggle: () -> Void
    let onOpen: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Group {
                if subpages > 0 {
                    Button(action: onToggle) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.fg3)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                            .frame(width: 34, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(expanded ? "Hide subpages of \(node.displayTitle)" : "Show subpages of \(node.displayTitle)")
                } else {
                    Color.clear.frame(width: 34, height: 44)
                }
            }
            .padding(.leading, 4 + CGFloat(min(level, 6)) * 18)
            Button(action: onOpen) {
                HStack(spacing: 6) {
                    WikiPageIcon(icon: node.icon, size: 16, database: node.isDatabase)
                    Text(node.displayTitle)
                        .font(ODFont.sans(15, weight: level == 0 ? .medium : .regular))
                        .foregroundStyle(node.title.trimmingCharacters(in: .whitespaces).isEmpty ? Theme.fg3 : Theme.fg)
                        .lineLimit(1)
                    if node.verified { WikiVerifiedMark() }
                    Spacer(minLength: 6)
                    if subpages > 0 {
                        Text("\(subpages)")
                            .font(ODFont.mono(11.5))
                            .foregroundStyle(Theme.fg4)
                            .accessibilityLabel(Format.plural(subpages, "subpage"))
                    }
                }
                .padding(.trailing, 16)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle())
        }
    }
}

/// A recently edited page: icon, title, where it sits and when.
struct WikiRecentRow: View {
    let node: WikiNode
    let path: [WikiNode]

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                WikiPageIcon(icon: node.icon, size: 18, database: node.isDatabase)
                    .frame(width: 32, height: 32)
                    .background(Theme.hover, in: RoundedRectangle(cornerRadius: Theme.Radius.control - 2, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(node.displayTitle)
                        .font(ODFont.sans(15, weight: .medium))
                        .foregroundStyle(Theme.fg)
                        .lineLimit(1)
                    if !path.isEmpty {
                        Text(path.map(\.displayTitle).joined(separator: " / "))
                            .font(ODFont.sans(12.5))
                            .foregroundStyle(Theme.fg3)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                Text(Format.relShort(node.updatedAt))
                    .font(ODFont.sans(12))
                    .foregroundStyle(Theme.fg3)
                    .monospacedDigit()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Hairline(inset: 60)
        }
        .contentShape(Rectangle())
    }
}

/// A search result: the page, where it sits, and the text around the match.
struct WikiSearchRow: View {
    let hit: WikiSearchHit

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                WikiPageIcon(icon: hit.icon, size: 18)
                    .frame(width: 32, height: 32)
                    .background(Theme.hover, in: RoundedRectangle(cornerRadius: Theme.Radius.control - 2, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(hit.displayTitle)
                        .font(ODFont.sans(15, weight: .semibold))
                        .foregroundStyle(Theme.fg)
                        .lineLimit(1)
                    if !hit.path.isEmpty {
                        Text(hit.path.map(\.displayTitle).joined(separator: " / "))
                            .font(ODFont.sans(12))
                            .foregroundStyle(Theme.fg3)
                            .lineLimit(1)
                    }
                    if !hit.snippet.isEmpty {
                        Text(hit.snippet)
                            .font(ODFont.sans(13.5))
                            .foregroundStyle(Theme.fg2)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            Hairline(inset: 60)
        }
        .contentShape(Rectangle())
    }
}

/// "Last edited by Maya, 3 minutes ago": its own clock, so only this line redraws.
struct WikiEditedLine: View {
    let page: WikiPage

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            HStack(spacing: 7) {
                if let who = page.updatedBy {
                    Avatar(name: who.name, url: who.avatarURL, seed: who.id, size: 20)
                    Text("Last edited by \(who.displayName), \(Format.relLong(page.updatedAt, now: context.date))")
                } else {
                    Text("Last edited \(Format.relLong(page.updatedAt, now: context.date))")
                }
            }
            .font(ODFont.sans(12.5))
            .foregroundStyle(Theme.fg3)
            .lineLimit(1)
        }
    }
}

/// The page menu's actions shared by the tree and the page: add a subpage, move,
/// favorite, follow (on the page), copy the link, move to the trash (or why it can't go).
struct WikiPageMenu: View {
    let node: WikiNode
    let onAddSubpage: () -> Void
    let onMove: () -> Void
    /// Moves the page to the trash (contracts/wiki.md "Trash").
    let onDelete: () -> Void
    var onHistory: (() -> Void)?
    /// Whether the person follows the page, once its comments are loaded.
    var following: Bool?
    var onFollow: (() -> Void)?

    @Environment(AppEnvironment.self) private var env

    private var store: WikiStore { WikiStore.shared }

    var body: some View {
        let rule = store.deleteRule(node.id, role: env.session.role, me: env.session.user?.id)
        let favorite = store.isFavorite(node.id)
        if env.session.canWrite {
            // A database's subpages are its rows, added on the web.
            if !node.isDatabase {
                Button(action: onAddSubpage) { Label("Add a subpage", systemImage: "plus") }
            }
            Button(action: onMove) { Label("Move to…", systemImage: "folder") }
            // A page goes to the other area with its subpages (contracts/pages.md "Areas"); a
            // journal and a template stay where they are.
            if !node.journal, !node.template {
                if node.area == .wiki, env.products.pages {
                    Button { Task { await WikiCreate.move(node, to: .pages, env: env) } } label: {
                        Label("Move to Pages", systemImage: "doc.richtext")
                    }
                } else if node.area == .pages {
                    Button { Task { await WikiCreate.move(node, to: .wiki, env: env) } } label: {
                        Label("Move to the wiki", systemImage: "book.pages")
                    }
                }
            }
        }
        Button { toggleFavorite(!favorite) } label: {
            Label(favorite ? "Remove from favorites" : "Add to favorites", systemImage: favorite ? "star.slash" : "star")
        }
        if let following, let onFollow {
            Button(action: onFollow) {
                Label(following ? "Unfollow" : "Follow", systemImage: following ? "bell.slash" : "bell")
            }
        }
        Button { WikiLink.copy(node.id, in: env) } label: { Label("Copy link", systemImage: "link") }
        if let url = WikiLink.url(node.id, in: env) {
            ShareLink(item: url) { Label("Share", systemImage: "square.and.arrow.up") }
        }
        if let onHistory {
            Button(action: onHistory) { Label("History", systemImage: "clock.arrow.circlepath") }
        }
        if rule != .no {
            Divider()
            if let reason = rule.reason {
                Button {} label: {
                    Label("Move to trash", systemImage: "trash")
                    Text(reason)
                }
                .disabled(true)
            } else {
                Button(role: .destructive, action: onDelete) { Label("Move to trash", systemImage: "trash") }
            }
        }
    }

    private func toggleFavorite(_ on: Bool) {
        Haptics.selection()
        Task {
            do {
                try await store.setFavorite(node.id, on)
            } catch {
                env.toasts.error(error)
            }
        }
    }
}

/// Move to trash, with Undo (contracts/wiki.md "Trash"): no question first, as the trash
/// keeps the page and its subpages for 30 days.
@MainActor
enum WikiTrash {
    static func move(_ node: WikiNode, env: AppEnvironment, onMoved: @escaping () -> Void = {}) {
        Task {
            do {
                _ = try await WikiStore.shared.trash(node.id)
                Haptics.success()
                env.toasts.show(Toast(message: "Moved \u{201C}\(node.displayTitle)\u{201D} to the trash", kind: .success, actionTitle: "Undo", action: {
                    Task { _ = await restore(node, env: env) }
                }), seconds: 5)
                onMoved()
            } catch {
                refused(error, env: env)
            }
        }
    }

    /// Puts it back where it was; answers the restored page, or nil when it couldn't.
    static func restore(_ node: WikiNode, env: AppEnvironment) async -> WikiPage? {
        do {
            let page = try await WikiStore.shared.restoreFromTrash(node.id)
            Haptics.success()
            env.toasts.show("Restored \u{201C}\(node.displayTitle)\u{201D}", kind: .success)
            return page
        } catch {
            refused(error, env: env)
            return nil
        }
    }

    /// An agent's refusal says who can delete it (contracts/wiki.md "Access"); a page that went
    /// with the page above it says to restore that one.
    static func refused(_ error: Error, env: AppEnvironment) {
        Haptics.error()
        if let api = error as? APIError, api.status == 403 || api.status == 422, let detail = api.detail, !detail.isEmpty {
            env.toasts.show(detail, kind: .error)
        } else {
            env.toasts.error(error)
        }
    }
}

/// Asks before deleting a page from the trash for good, naming the subpages that go with it.
struct WikiDeleteConfirmation: ViewModifier {
    @Binding var node: WikiNode?
    /// How many pages go with it.
    let under: (WikiNode) -> Int
    let onDeleted: (WikiNode) -> Void

    @Environment(AppEnvironment.self) private var env

    func body(content: Content) -> some View {
        let under = node.map(self.under) ?? 0
        content.confirmationDialog(
            "Delete \u{201C}\(node?.displayTitle ?? "")\u{201D} for good?",
            isPresented: Binding(get: { node != nil }, set: { if !$0 { node = nil } }),
            titleVisibility: .visible,
            presenting: node
        ) { node in
            Button(under > 0 ? "Delete \(Format.plural(under + 1, "page")) for good" : "Delete for good", role: .destructive) { delete(node) }
        } message: { _ in
            Text(under == 0
                ? "The page and its history are deleted for good. This can't be undone."
                : under == 1
                ? "Its subpage goes with it. Both pages and their history are deleted for good. This can't be undone."
                : "Its \(under) subpages go with it. All of them and their history are deleted for good. This can't be undone.")
        }
    }

    private func delete(_ node: WikiNode) {
        Task {
            do {
                try await WikiStore.shared.delete(node.id)
                Haptics.success()
                env.toasts.show("Deleted \u{201C}\(node.displayTitle)\u{201D} for good", kind: .success)
                onDeleted(node)
            } catch {
                WikiTrash.refused(error, env: env)
            }
        }
    }
}

extension View {
    func wikiDeleteConfirmation(_ node: Binding<WikiNode?>, under: @escaping (WikiNode) -> Int, onDeleted: @escaping (WikiNode) -> Void = { _ in }) -> some View {
        modifier(WikiDeleteConfirmation(node: node, under: under, onDeleted: onDeleted))
    }
}

/// The check beside a verified page.
struct WikiVerifiedMark: View {
    var body: some View {
        Image(systemName: "checkmark.seal.fill")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Tone.green.solid)
            .accessibilityLabel("Verified")
    }
}

/// "Verified by Maya until Mar 3" under the title (contracts/wiki.md "Verified pages").
struct WikiVerifiedLine: View {
    let verification: WikiVerification

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: verification.expired ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(verification.expired ? Tone.amber.solid : Tone.green.solid)
            Text(text)
                .lineLimit(2)
        }
        .font(ODFont.sans(12.5, weight: .medium))
        .foregroundStyle(verification.expired ? Tone.amber.text : Tone.green.text)
        .accessibilityElement(children: .combine)
    }

    private var text: String {
        let who = verification.by?.displayName
        if verification.expired {
            return who.map { "Verified by \($0), but it has expired" } ?? "The verification has expired"
        }
        let by = who.map { "Verified by \($0)" } ?? "Verified"
        guard let until = verification.until else { return by }
        return "\(by) until \(Format.shortDate(until))"
    }
}

/// Creates a page and opens it with its title ready to type.
@MainActor
enum WikiCreate {
    static func page(_ body: WikiPageCreate, env: AppEnvironment) async {
        do {
            let page = try await WikiStore.shared.create(body)
            Haptics.tap()
            env.router.push(.wikiPage(page.id))
        } catch {
            Haptics.error()
            env.toasts.error(error)
        }
    }

    /// Opens the person's note of today in `area`, making it when there is none.
    static func today(in area: WikiArea, env: AppEnvironment) async {
        do {
            let page = try await WikiStore.shared.daily(.now, in: area)
            Haptics.tap()
            env.router.pick(.wikiPage(page.id))
        } catch {
            Haptics.error()
            env.toasts.error(error)
        }
    }

    /// A new page copied from a template, opened.
    static func fromTemplate(_ template: WikiNode, in area: WikiArea, parentID: String? = nil, space: String? = nil, teamID: String? = nil, env: AppEnvironment) async {
        do {
            let page = try await WikiStore.shared.use(template: template.id, in: area, parentID: parentID, space: space, teamID: teamID)
            Haptics.tap()
            env.router.push(.wikiPage(page.id))
        } catch {
            Haptics.error()
            env.toasts.error(error)
        }
    }

    /// Moves the page with its subpages to the other area, and says where it went.
    static func move(_ node: WikiNode, to area: WikiArea, env: AppEnvironment) async {
        do {
            _ = try await WikiStore.shared.move(node.id, to: area)
            Haptics.success()
            env.toasts.show(area == .pages ? "Moved \u{201C}\(node.displayTitle)\u{201D} to Pages" : "Moved \u{201C}\(node.displayTitle)\u{201D} to the wiki", kind: .success)
            env.router.pageLoaded(node.id, area: area)
        } catch {
            Haptics.error()
            env.toasts.error(error)
        }
    }
}
