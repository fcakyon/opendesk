import SwiftUI

// The workspace's own sidebar in the app's menu (`ScopeSheet`), as the member arranged it on any
// device: their sections in their order, their names and icons, rows of their own sections, and
// every section and row arranged where it is from its menu (contracts/collab.md "Arranging in place").

/// What a rename or icon change is about.
struct SidebarTarget: Identifiable, Hashable {
    enum Kind: Hashable {
        case section(String)
        case row(key: String, section: String)
    }

    var kind: Kind
    /// What it is called now, and without the member's own name.
    var title: String
    var usual: String
    var id: String {
        switch kind {
        case let .section(id): "section/" + id
        case let .row(key, section): section + "/" + key
        }
    }
}

extension SidebarPrefs {
    mutating func rename(_ target: SidebarTarget, to text: String) {
        switch target.kind {
        case let .section(id):
            if id.hasPrefix("custom:") {
                update(section: String(id.dropFirst(7))) { $0.title = String(SpaceRules.clean(text).prefix(SpaceRules.title)) }
            } else {
                setName("section:" + id, SpaceRules.clean(text) == target.usual ? nil : text)
            }
        case let .row(key, section):
            if section.hasPrefix("custom:") {
                update(section: String(section.dropFirst(7))) { own in
                    guard let at = own.items.firstIndex(where: { $0.key == key }) else { return }
                    let cleaned = SpaceRules.clean(text)
                    own.items[at].name = cleaned.isEmpty || cleaned == target.usual ? nil : cleaned
                }
            } else {
                setName(key, SpaceRules.clean(text) == target.usual ? nil : text)
            }
        }
    }

    mutating func setIcon(_ target: SidebarTarget, _ icon: String?) {
        switch target.kind {
        case let .section(id):
            if id.hasPrefix("custom:") {
                update(section: String(id.dropFirst(7))) { $0.icon = icon }
            } else {
                setIcon("section:" + id, icon)
            }
        case let .row(key, section):
            if section.hasPrefix("custom:") {
                update(section: String(section.dropFirst(7))) { own in
                    guard let at = own.items.firstIndex(where: { $0.key == key }) else { return }
                    own.items[at].icon = icon
                }
            } else {
                setIcon(key, icon)
            }
        }
    }

    /// Moves section `id` one place up (-1) or down (1) among `shown`, the sections as they show.
    mutating func moveSection(_ id: String, by step: Int, among shown: [String]) {
        guard let at = shown.firstIndex(of: id), shown.indices.contains(at + step) else { return }
        var next = shown
        next.swapAt(at, at + step)
        setOrder(next)
    }
}

/// The dialogs the sidebar's menus open, shared by every section and row.
@MainActor
@Observable
final class SidebarMenuModel {
    var renaming: SidebarTarget?
    var renameText = ""
    var iconFor: SidebarTarget?
    var addingRowsTo: String?
    /// A row waiting for the title of the new section it starts.
    var newSectionWith: SidebarItem?
    var newSectionOffered = false
    var newSectionTitle = ""
    var editing = false

    func rename(_ target: SidebarTarget) {
        renameText = target.title
        renaming = target
    }

    func newSection(with item: SidebarItem?) {
        newSectionWith = item
        newSectionTitle = ""
        newSectionOffered = true
    }
}

struct WorkspaceSidebar: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(InboxChatAlerts.self) private var alerts: InboxChatAlerts?
    /// A row was opened: the sheet closes.
    var onOpen: () -> Void

    @State private var menu = SidebarMenuModel()
    @State private var folded: Set<String> = []
    @State private var addingInbox = false

    private var store: SidebarStore { .shared }

    var body: some View {
        let layout = SidebarLayout(env: env)
        VStack(alignment: .leading, spacing: 18) {
            ForEach(layout.shownSections, id: \.self) { id in
                section(id, layout: layout)
            }
            Button {
                Haptics.tap()
                menu.editing = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "slider.horizontal.3").font(.system(size: 14, weight: .medium))
                    Text("Edit sidebar").font(ODFont.sans(14.5, weight: .medium))
                    Spacer()
                }
                .foregroundStyle(Theme.fg3)
                .padding(.horizontal, 6)
                .frame(height: 36)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Rename, reorder, hide and add sections and rows")
        }
        .environment(menu)
        .motion(Motion.snappy, value: layout.shownSections)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    Haptics.tap()
                    menu.editing = true
                } label: {
                    Label("Edit sidebar", systemImage: "slider.horizontal.3")
                }
            }
        }
        .task(id: "\(env.session.workspace?.id ?? "")/\(env.directory.loaded)") {
            store.start(env: env)
            guard let workspace = env.session.workspace?.id else { return }
            SpacesStore.shared.invalidate(workspace)
            SpacesStore.shared.loadData(for: workspace, collab: layout.collab)
        }
        .onAppear { folded = ViewSections.folded(key: foldedKey) }
        .sidebarMenuDialogs(menu)
        .sheet(isPresented: $menu.editing) {
            SidebarEditorSheet()
                .presentationDetents([.large])
                .presentationCornerRadius(Theme.Radius.sheet)
                .interactiveDismissDisabled()
        }
        .sheet(isPresented: $addingInbox) {
            AddInboxSheet { id in
                env.router.openMailbox(id)
                onOpen()
            }
            .presentationDetents([.large])
            .presentationCornerRadius(Theme.Radius.sheet)
        }
    }

    // MARK: Sections

    @ViewBuilder
    private func section(_ id: String, layout: SidebarLayout) -> some View {
        let rows = layout.rows(of: id)
        let own = id.hasPrefix("custom:") ? store.prefs.section(String(id.dropFirst(7))) : nil
        let collapsed = own?.collapsed ?? false
        let waiting = id == "inbox" && layout.showsWaitingChats ? (alerts?.waiting.count ?? 0) : 0
        if !rows.isEmpty || own != nil || waiting > 0 {
            VStack(alignment: .leading, spacing: 8) {
                SidebarSectionHeader(id: id, layout: layout, collapsed: own == nil ? nil : collapsed)
                if !collapsed {
                    Panel {
                        if waiting > 0 { waitingRow(waiting) }
                        if id == "views" {
                            viewRows(rows, layout: layout)
                        } else {
                            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                                if index > 0 || waiting > 0 { Hairline(inset: 46) }
                                rowButton(row, section: id)
                            }
                        }
                        if rows.isEmpty, own != nil { emptyOwnRow(id) }
                    }
                }
            }
        }
        if id == "inbox" { ticketInboxes(layout) }
    }

    /// The ticket inboxes not shown as sections, one row each (from two inboxes on), and for
    /// admins a way to add one.
    @ViewBuilder
    private func ticketInboxes(_ layout: SidebarLayout) -> some View {
        let rows = layout.listedInboxes
        if env.products.tickets, !rows.isEmpty || env.session.isAdmin {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("Ticket inboxes").padding(.leading, 4)
                Panel {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        if index > 0 { Hairline(inset: 46) }
                        rowButton(row, section: "inbox")
                    }
                    if env.session.isAdmin {
                        if !rows.isEmpty { Hairline(inset: 46) }
                        Button {
                            Haptics.selection()
                            addingInbox = true
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "plus").font(.system(size: 15)).foregroundStyle(Theme.fg3).frame(width: 20)
                                Text("Add a ticket inbox").font(ODFont.sans(15)).foregroundStyle(Theme.fg)
                                Spacer()
                            }
                            .padding(.horizontal, 14)
                            .frame(height: 46)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(RowPressStyle())
                        .accessibilityHint("Mail to a new address, or a Mail account, becomes tickets")
                    }
                }
            }
        }
    }

    private func rowButton(_ row: SidebarRow, section: String, nested: Bool = false) -> some View {
        Button {
            Haptics.selection()
            SpacesStore.shared.open(row.model.destination, in: row.model.workspaceID, env: env)
            onOpen()
        } label: {
            SpaceRowView(row: row.model).padding(.leading, nested ? 14 : 0)
        }
        .buttonStyle(RowPressStyle())
        .contextMenu { SidebarRowMenu(row: row, section: section) }
    }

    private func emptyOwnRow(_ id: String) -> some View {
        Button {
            Haptics.tap()
            menu.addingRowsTo = id
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "plus").font(.system(size: 14, weight: .medium)).frame(width: 20)
                Text("Add rows").font(ODFont.sans(15))
                Spacer()
            }
            .foregroundStyle(Theme.fg3)
            .padding(.horizontal, 14)
            .frame(height: 46)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
    }

    /// Visitors waiting in live chat with nobody on it (`show_waiting_chats`).
    private func waitingRow(_ count: Int) -> some View {
        Button {
            Haptics.selection()
            env.inbox.setScope(.folder(.unassigned))
            env.router.show(.tickets, [])
            onOpen()
        } label: {
            HStack(spacing: 12) {
                PingDot(color: Tone.red.solid, size: 8).frame(width: 20)
                Text(count == 1 ? "1 waiting in chat" : "\(count) waiting in chat")
                    .font(ODFont.sans(15, weight: .medium))
                    .foregroundStyle(Tone.red.text)
                Spacer()
            }
            .padding(.horizontal, 14)
            .frame(height: 46)
            .background(Tone.red.soft)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityHint("Opens Unassigned")
    }

    // MARK: Views, under their sections

    private var foldedKey: String {
        "inbox.viewSections.folded." + env.session.api.instance.storageKey + "." + (env.session.workspace?.id ?? "") + "." + (env.session.user?.id ?? "")
    }

    @ViewBuilder
    private func viewRows(_ rows: [SidebarRow], layout: SidebarLayout) -> some View {
        let shown = Set(rows.map(\.key))
        let views = env.directory.views.filter { shown.contains("view:" + $0.id) }
        ForEach(Array(ViewSections.group(views).enumerated()), id: \.element.id) { index, entry in
            if index > 0 { Hairline(inset: 46) }
            switch entry {
            case let .view(view):
                if let row = rows.first(where: { $0.key == "view:" + view.id }) { rowButton(row, section: "views") }
            case let .section(key, name, list):
                viewSectionRow(key: key, name: name, views: list)
                if !folded.contains(key) {
                    ForEach(list) { view in
                        if let row = rows.first(where: { $0.key == "view:" + view.id }) {
                            Hairline(inset: 46)
                            rowButton(row, section: "views", nested: true)
                        }
                    }
                }
            }
        }
    }

    /// A view section's heading: folds its views away; folded, it carries their count.
    private func viewSectionRow(key: String, name: String, views: [SavedView]) -> some View {
        let isFolded = folded.contains(key)
        let total = views.reduce(0) { $0 + (env.directory.counts?.views[$1.id] ?? 0) }
        return Button {
            Haptics.selection()
            withAnimation(Motion.snappy) {
                if isFolded { folded.remove(key) } else { folded.insert(key) }
            }
            ViewSections.setFolded(folded, key: foldedKey)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.fg3)
                    .rotationEffect(.degrees(isFolded ? 0 : 90))
                    .frame(width: 20)
                Text(name)
                    .font(ODFont.sans(13.5, weight: .semibold))
                    .foregroundStyle(Theme.fg2)
                    .lineLimit(1)
                Spacer()
                if isFolded, total > 0 {
                    Text("\(total)").font(ODFont.mono(12.5)).monospacedDigit().foregroundStyle(Theme.fg3)
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityLabel(name)
        .accessibilityValue(isFolded ? "Folded, \(Format.plural(views.count, "view"))" : "Open")
    }
}

/// A section's title in the menu: the member's name and emoji, a fold for their own sections, and
/// a menu that renames, moves, hides or deletes it.
struct SidebarSectionHeader: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(SidebarMenuModel.self) private var menu
    let id: String
    let layout: SidebarLayout
    /// Folded or open for a section of the member's own; nil for one that doesn't fold.
    var collapsed: Bool?

    var body: some View {
        let title = layout.title(section: id)
        HStack(spacing: 6) {
            if let icon = layout.icon(section: id) { Text(icon).font(.system(size: 12.5)) }
            Text(title)
                .font(ODFont.sans(12.5, weight: .medium))
                .foregroundStyle(Theme.fg3)
                .lineLimit(1)
            if let collapsed {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(Theme.fg4)
                    .rotationEffect(.degrees(collapsed ? 0 : 90))
            }
            Spacer()
            Menu {
                SidebarSectionMenu(id: id, layout: layout)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.fg4)
                    .frame(width: 30, height: 22)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Options for \(title)")
        }
        .padding(.leading, 4)
        .contentShape(Rectangle())
        .onTapGesture {
            guard let collapsed else { return }
            Haptics.selection()
            SidebarStore.shared.change { $0.update(section: String(id.dropFirst(7))) { $0.collapsed = !collapsed } }
        }
        .contextMenu { SidebarSectionMenu(id: id, layout: layout) }
        .accessibilityElement(children: .contain)
        .accessibilityValue(collapsed.map { $0 ? "Folded" : "Open" } ?? "")
    }
}

/// What a section's menu offers.
struct SidebarSectionMenu: View {
    @Environment(SidebarMenuModel.self) private var menu
    let id: String
    let layout: SidebarLayout

    var body: some View {
        let target = SidebarTarget(kind: .section(id), title: layout.title(section: id), usual: layout.usualTitle(section: id))
        let shown = layout.allSections
        let own = id.hasPrefix("custom:")
        Button { menu.rename(target) } label: { Label("Rename", systemImage: "pencil") }
        Button { menu.iconFor = target } label: { Label("Change icon", systemImage: "face.smiling") }
        if own {
            Button { menu.addingRowsTo = id } label: { Label("Add rows", systemImage: "plus") }
        }
        if let at = shown.firstIndex(of: id) {
            if at > 0 {
                Button { SidebarStore.shared.change { $0.moveSection(id, by: -1, among: shown) } } label: { Label("Move up", systemImage: "arrow.up") }
            }
            if at < shown.count - 1 {
                Button { SidebarStore.shared.change { $0.moveSection(id, by: 1, among: shown) } } label: { Label("Move down", systemImage: "arrow.down") }
            }
        }
        if !own, layout.prefs.names["section:" + id] != nil || layout.prefs.icons["section:" + id] != nil {
            Button {
                SidebarStore.shared.change {
                    $0.setName("section:" + id, nil)
                    $0.setIcon("section:" + id, nil)
                }
            } label: { Label("Use its usual name", systemImage: "arrow.uturn.backward") }
        }
        Divider()
        if own {
            Button(role: .destructive) { SidebarStore.shared.change { $0.deleteSection(String(id.dropFirst(7))) } } label: { Label("Delete section", systemImage: "trash") }
        } else if SidebarLayout.mailboxID(id) != nil || SidebarLayout.teamID(id) != nil {
            Button {
                SidebarStore.shared.change { $0.order.removeAll { $0 == id } }
            } label: { Label(SidebarLayout.mailboxID(id) != nil ? "Back into Tickets" : "Back into Teams", systemImage: "arrow.uturn.left") }
        } else {
            Button { SidebarStore.shared.change { $0.setHidden("section:" + id, true) } } label: { Label("Hide section", systemImage: "eye.slash") }
        }
        Button { menu.editing = true } label: { Label("Edit sidebar", systemImage: "slider.horizontal.3") }
    }
}

/// What a row's menu offers: rename, icon, hide, Favorites and the member's own sections.
struct SidebarRowMenu: View {
    @Environment(SidebarMenuModel.self) private var menu
    let row: SidebarRow
    let section: String

    var body: some View {
        let prefs = SidebarStore.shared.prefs
        let target = SidebarTarget(kind: .row(key: row.key, section: section), title: row.model.title, usual: row.usualTitle)
        let own = section.hasPrefix("custom:")
        Button { menu.rename(target) } label: { Label("Rename", systemImage: "pencil") }
        Button { menu.iconFor = target } label: { Label("Change icon", systemImage: "face.smiling") }
        if !own, section != "favorites", prefs.names[row.key] != nil || prefs.icons[row.key] != nil {
            Button {
                SidebarStore.shared.change {
                    $0.setName(row.key, nil)
                    $0.setIcon(row.key, nil)
                }
            } label: { Label("Use its usual name", systemImage: "arrow.uturn.backward") }
        }
        if let pin = row.pin, section != "favorites" {
            let pinned = prefs.isPinned(pin.kind, pin.id)
            Button {
                SidebarStore.shared.change { $0.setPinned(pin.kind, pin.id, !pinned) }
            } label: { Label(pinned ? "Remove from Favorites" : "Add to Favorites", systemImage: pinned ? "star.slash" : "star") }
        }
        if let item = row.item, item.kind == .mailbox, !SidebarStore.shared.inboxSections.contains(item.itemID) {
            Button {
                Task { try? await SidebarStore.shared.setInboxSection(item.itemID, true) }
            } label: { Label("Show as its own section", systemImage: "sidebar.left") }
        }
        if let item = row.item {
            Menu {
                ForEach(prefs.sections.filter { "custom:" + $0.id != section }) { target in
                    Button(SpaceRules.clean(target.title).isEmpty ? "Untitled section" : target.title) {
                        SidebarStore.shared.change { $0.add([item], to: target.id) }
                    }
                }
                Button { menu.newSection(with: item) } label: { Label("New section", systemImage: "plus") }
            } label: { Label(own ? "Move to a section" : "Add to a section", systemImage: "rectangle.stack.badge.plus") }
        }
        Divider()
        if own || section == "favorites" {
            Button(role: .destructive) {
                SidebarStore.shared.change { $0.remove(row.key, from: section) }
            } label: { Label(section == "favorites" ? "Remove from Favorites" : "Remove from this section", systemImage: "minus.circle") }
        } else {
            Button { SidebarStore.shared.change { $0.setHidden(row.key, true) } } label: { Label("Hide", systemImage: "eye.slash") }
        }
        Button { menu.editing = true } label: { Label("Edit sidebar", systemImage: "slider.horizontal.3") }
    }
}

// MARK: - Dialogs

private struct SidebarMenuDialogs: ViewModifier {
    @Environment(AppEnvironment.self) private var env
    @Bindable var menu: SidebarMenuModel

    func body(content: Content) -> some View {
        content
            .alert("Rename", isPresented: Binding(get: { menu.renaming != nil }, set: { if !$0 { menu.renaming = nil } })) {
                TextField(menu.renaming?.usual ?? "Name", text: $menu.renameText)
                Button("Save") {
                    if let target = menu.renaming {
                        let text = menu.renameText
                        SidebarStore.shared.change { $0.rename(target, to: text) }
                    }
                    menu.renaming = nil
                }
                Button("Cancel", role: .cancel) { menu.renaming = nil }
            } message: {
                Text("Only you see this name. Leave it empty for the usual one.")
            }
            .alert("New section", isPresented: $menu.newSectionOffered) {
                TextField("Section title", text: $menu.newSectionTitle)
                Button("Add") {
                    let title = menu.newSectionTitle
                    let items = menu.newSectionWith.map { [$0] } ?? []
                    SidebarStore.shared.change { $0.newSection(title: title, items: items) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("A section of your own, among the others in your sidebar.")
            }
            .sheet(item: $menu.iconFor) { target in
                SidebarIconSheet(title: target.title, current: currentIcon(target)) { icon in
                    SidebarStore.shared.change { $0.setIcon(target, icon) }
                }
                .presentationDetents([.medium])
                .presentationCornerRadius(Theme.Radius.sheet)
            }
            .sheet(item: Binding(get: { menu.addingRowsTo.map { AddTarget(id: $0) } }, set: { menu.addingRowsTo = $0?.id })) { target in
                SpaceAddRowsSheet(space: SidebarStore.shared.prefs.asSpace(workspace: env.session.workspace?.id ?? "", section: target.id), only: env.session.workspace?.id, rowsOnly: true) { items in
                    let rows = items.filter { $0.kind != .section && $0.kind != .everywhere }.map { SidebarItem(kind: $0.kind, itemID: $0.itemID) }
                    SidebarStore.shared.change { $0.add(rows, to: String(target.id.dropFirst(7))) }
                }
                .presentationDetents([.large])
                .presentationCornerRadius(Theme.Radius.sheet)
            }
    }

    private struct AddTarget: Identifiable {
        var id: String
    }

    private func currentIcon(_ target: SidebarTarget) -> String? {
        let prefs = SidebarStore.shared.prefs
        switch target.kind {
        case let .section(id):
            return id.hasPrefix("custom:") ? prefs.section(String(id.dropFirst(7)))?.icon : prefs.icon("section:" + id)
        case let .row(key, section):
            if section.hasPrefix("custom:") { return prefs.section(String(section.dropFirst(7)))?.items.first { $0.key == key }?.icon }
            return prefs.icon(key)
        }
    }
}

extension View {
    func sidebarMenuDialogs(_ menu: SidebarMenuModel) -> some View { modifier(SidebarMenuDialogs(menu: menu)) }
}

extension SidebarPrefs {
    /// An own section as a one-section Space, so the row picker marks what it already holds.
    func asSpace(workspace: String, section id: String) -> Space {
        let own = section(String(id.dropFirst(7)))
        return Space(id: "sidebar", name: "Sidebar", sections: [SpaceSection(id: id, items: (own?.items ?? []).map { $0.spaceItem(in: workspace) })])
    }
}

/// One emoji for a section or row: a few in one tap, any other from the emoji keyboard.
struct SidebarIconSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let current: String?
    let onPick: (String?) -> Void

    @State private var typed = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            AccountSheetHeader(title: "Icon for \(title)", subtitle: "Pick one, or type any emoji.") { dismiss() }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 8), spacing: 6) {
                ForEach(SidebarRules.suggestions, id: \.self) { emoji in
                    Button {
                        Haptics.selection()
                        pick(emoji)
                    } label: {
                        Text(emoji)
                            .font(.system(size: 20))
                            .frame(maxWidth: .infinity)
                            .frame(height: 38)
                            .background(current == emoji ? Theme.hover : Theme.sunken, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(current == emoji ? Theme.lineStrong : Theme.lineSoft, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(current == emoji ? .isSelected : [])
                }
            }
            HStack(spacing: 10) {
                ODTextField(label: "Any emoji", text: $typed, prompt: "Type or paste one", submitLabel: .done) {
                    if let emoji = SidebarRules.emoji(typed) { pick(emoji) }
                }
                .onChange(of: typed) { _, value in
                    if let emoji = SidebarRules.emoji(value), emoji != current { pick(emoji) }
                }
            }
            if current != nil {
                Button("Use its usual icon") { pick(nil) }
                    .buttonStyle(OutlineButtonStyle())
            }
            Spacer(minLength: 0)
        }
        .padding(22)
        .background(Theme.surface)
    }

    private func pick(_ emoji: String?) {
        onPick(emoji)
        dismiss()
    }
}
