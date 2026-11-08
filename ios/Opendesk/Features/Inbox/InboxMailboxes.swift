import SwiftUI

// Ticket inboxes (contracts/collab.md "Inboxes as sections"): each helpdesk mailbox's tickets,
// the ones whose reply address it is, in the folders of the inbox. The list switches between
// every inbox and one, each inbox can be a section of its own in the menu, and admins add one.

extension Router {
    /// One ticket inbox's folder in the Inbox tab (`/inbox/<folder>?mailbox=<id>`).
    func openMailbox(_ id: String, folder: Folder = .unassigned) {
        environment?.inbox.setScope(.mailbox(id, folder))
        show(.tickets, [])
    }
}

extension Folder {
    /// The folder's name inside one ticket inbox, as its sidebar section names it.
    var mailboxTitle: String {
        switch self {
        case .unassigned: "Unassigned"
        case .mine: "Mine"
        case .open: "Open"
        case .pending: "Pending"
        case .solved: "Solved"
        case .spam: "Spam"
        }
    }
}

extension InboxMailbox {
    /// Its name, else its address.
    var title: String { name.isEmpty ? email : name }
}

/// A ticket inbox's folders under its title, each with what waits there.
struct InboxMailboxTabs: View {
    let mailboxID: String
    let folder: Folder
    var counts: TicketCounts?
    let onFolder: (Folder) -> Void
    @Namespace private var underline
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(Folder.allCases) { item in
                    let active = item == folder
                    Button {
                        guard !active else { return }
                        Haptics.selection()
                        withAnimation(reduceMotion ? nil : Motion.snappy) { onFolder(item) }
                    } label: {
                        HStack(spacing: 5) {
                            Text(item.mailboxTitle)
                                .font(ODFont.sans(14, weight: active ? .semibold : .regular))
                                .foregroundStyle(active ? Theme.fg : Theme.fg3)
                            if let count = item.count(in: counts, mailbox: mailboxID), count > 0 {
                                Text("\(count)")
                                    .font(ODFont.mono(11))
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.fg4)
                                    .contentTransition(.numericText())
                            }
                        }
                        .padding(.horizontal, 10)
                        .frame(height: 36)
                        .overlay(alignment: .bottom) {
                            if active {
                                Capsule().fill(Theme.fg).frame(height: 2)
                                    .padding(.horizontal, 8)
                                    .matchedGeometryEffect(id: "underline", in: underline)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(active ? [.isSelected, .isButton] : .isButton)
                }
            }
            .padding(.horizontal, 12)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Ticket inbox folders")
    }
}

/// Over a folder's list, which ticket inbox it lists: every one, or one reply address. One
/// picked can go to the menu as a section of its own; admins add an inbox from here.
struct InboxSwitcherBar: View {
    @Environment(AppEnvironment.self) private var env
    @State private var adding = false
    @State private var saving = false
    @State private var renaming = false
    @State private var renameText = ""

    /// Shown on a folder while the workspace has more than one inbox, and on any ticket inbox.
    static func shows(_ env: AppEnvironment) -> Bool {
        let scope = env.inbox.scope
        guard scope.folder != nil else { return false }
        return env.directory.mailboxes.count > 1 || scope.mailboxID != nil
    }

    var body: some View {
        let scope = env.inbox.scope
        let current = env.directory.mailbox(scope.mailboxID)
        HStack(spacing: 8) {
            Menu {
                Section("Ticket inbox") {
                    Button { pick(nil) } label: { choice("All inboxes", selected: scope.mailboxID == nil) }
                    ForEach(env.directory.mailboxes) { mailbox in
                        Button { pick(mailbox.id) } label: { choice(mailbox.title, selected: mailbox.id == scope.mailboxID) }
                    }
                }
                if let current, env.directory.isInboxSection(current.id) {
                    Section {
                        Button {
                            renameText = env.directory.inboxTitle(current)
                            renaming = true
                        } label: { Label("Rename its section", systemImage: "pencil") }
                    }
                }
                if env.session.isAdmin {
                    Section {
                        Button { adding = true } label: { Label("Add a ticket inbox", systemImage: "plus") }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "tray.2").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.fg3)
                    Text(current.map(env.directory.inboxTitle) ?? (scope.mailboxID == nil ? "All inboxes" : "Ticket inbox"))
                        .font(ODFont.sans(13, weight: .medium))
                        .foregroundStyle(current == nil ? Theme.fg2 : Theme.fg)
                        .lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(Theme.fg4)
                }
                .padding(.horizontal, 10)
                .frame(height: 28)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(current == nil ? Theme.line : Theme.fg4, lineWidth: 1))
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Ticket inbox")
            .accessibilityValue(current?.title ?? "All inboxes")
            if let id = scope.mailboxID {
                let inSection = env.directory.isInboxSection(id)
                Button { toggleSection(id, !inSection) } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "sidebar.left").font(.system(size: 11.5, weight: .medium))
                        Text(inSection ? "Back into Tickets" : "Show as its own section").font(ODFont.sans(12.5, weight: .medium))
                    }
                    .foregroundStyle(Theme.fg3)
                    .padding(.horizontal, 6)
                    .frame(height: 28)
                    .contentShape(Rectangle())
                }
                .buttonStyle(TapScaleStyle())
                .disabled(saving)
                .accessibilityHint(inSection ? "Lists it with the other folders again" : "Gives it a section with its folders in the menu")
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .sheet(isPresented: $adding) {
            AddInboxSheet { id in env.router.openMailbox(id) }
                .presentationDetents([.large])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .alert("Rename its section", isPresented: $renaming) {
            TextField(current?.title ?? "Name", text: $renameText)
            Button("Save") {
                guard let current else { return }
                let text = renameText
                let usual = current.title
                SidebarStore.shared.change { $0.setName("section:mailbox:" + current.id, SpaceRules.clean(text) == usual ? nil : text) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only you see this name. Leave it empty for the inbox's own.")
        }
    }

    @ViewBuilder
    private func choice(_ title: String, selected: Bool) -> some View {
        if selected { Label(title, systemImage: "checkmark") } else { Text(title) }
    }

    private func pick(_ mailbox: String?) {
        guard let next = env.inbox.scope.inMailbox(mailbox), next != env.inbox.scope else { return }
        Haptics.selection()
        env.inbox.setScope(next)
    }

    private func toggleSection(_ id: String, _ on: Bool) {
        saving = true
        Haptics.selection()
        Task {
            do {
                try await env.directory.setInboxSection(id, on)
                let name = env.directory.mailbox(id).map(env.directory.inboxTitle) ?? "The inbox"
                env.toasts.show(on ? "\(name) has its own section" : "\(name) is back in Tickets", kind: .success)
            } catch {
                env.toasts.show("The menu could not be saved", kind: .error)
            }
            saving = false
        }
    }
}
