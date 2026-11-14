import SwiftUI

/// Account › Keyboard shortcuts: the keys the app answers with a keyboard connected, searchable,
/// each changed, turned off or put back. The keys are the person's own on every device and in the
/// web app (`/v1/me/shortcuts`).
struct AccountShortcutsView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var search = ""
    @State private var recording: ShortcutCommand?
    @State private var confirmReset = false

    private var store: ShortcutsStore { .shared }

    private var matching: [ShortcutCommand] {
        let text = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !text.isEmpty else { return ShortcutRegistry.commands }
        return ShortcutRegistry.commands.filter { command in
            command.title.lowercased().contains(text) || command.group.title.lowercased().contains(text)
                || (store.binding(command).map { ShortcutBinding.label($0).lowercased().contains(text) } ?? false)
        }
    }

    var body: some View {
        AccountPage(title: "Keyboard shortcuts") {
            ShortcutsList(search: $search, commands: matching, editable: true, onRecord: { recording = $0 })
            if search.isEmpty, ShortcutRegistry.commands.contains(where: store.isChanged) {
                AccountSection {
                    Button { confirmReset = true } label: {
                        AccountRow(symbol: "arrow.counterclockwise", tone: .gray, title: "Put every shortcut back on its usual keys", titleColor: Tone.red.text)
                    }
                    .buttonStyle(RowPressStyle())
                }
            }
        }
        .onAppear { store.start(env: env) }
        .sheet(item: $recording) { command in
            ShortcutRecorderSheet(command: command)
                .presentationDetents([.medium])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .confirmationDialog("Put every shortcut back?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Use the usual keys", role: .destructive) {
                Task {
                    if let failure = await store.resetAll() { env.toasts.show(failure) }
                }
            }
        } message: {
            Text("On every device and in the web app.")
        }
    }
}

/// The shortcuts in their groups, with a search field: the Account page, and the sheet `?` opens.
struct ShortcutsList: View {
    @Environment(AppEnvironment.self) private var env
    @Binding var search: String
    let commands: [ShortcutCommand]
    var editable = false
    var onRecord: (ShortcutCommand) -> Void = { _ in }

    private var store: ShortcutsStore { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.fg3)
                TextField("Search shortcuts", text: $search)
                    .font(ODFont.sans(15))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
            Text("With a keyboard connected to your \(AppInfo.device). Your keys are the same on every device and in the web app. Two keys with \u{201C}then\u{201D} between them are pressed one after the other.")
                .font(ODFont.footnote)
                .foregroundStyle(Theme.fg3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)
            if commands.isEmpty {
                Panel {
                    EmptyState(symbol: "keyboard", title: "No shortcut matches", message: "Try another word, or a key such as G or K.")
                }
            }
            ForEach(ShortcutCommand.Group.allCases, id: \.self) { group in
                let list = commands.filter { $0.group == group }
                if !list.isEmpty {
                    AccountSection(title: group.title) {
                        ForEach(Array(list.enumerated()), id: \.element.id) { index, command in
                            if index > 0 { AccountDivider(tiles: false) }
                            row(command)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ command: ShortcutCommand) -> some View {
        let binding = store.binding(command)
        let content = HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(command.title).font(ODFont.sans(15)).foregroundStyle(Theme.fg)
                if store.isChanged(command) {
                    Text("Usually \(ShortcutBinding.label(command.keys))").font(ODFont.footnote).foregroundStyle(Theme.fg3)
                }
            }
            Spacer(minLength: 8)
            if let binding {
                KeyCaps(binding: binding)
            } else {
                Text("Off").font(ODFont.sans(13.5)).foregroundStyle(Theme.fg4)
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
        if editable {
            Menu {
                Button { onRecord(command) } label: { Label("Change keys", systemImage: "keyboard") }
                if binding != nil {
                    Button { change { await store.set(command.id, to: nil) } } label: { Label("Turn off", systemImage: "nosign") }
                }
                if store.isChanged(command) {
                    Button { change { await store.reset(command.id) } } label: { Label("Use the usual keys", systemImage: "arrow.uturn.backward") }
                }
            } label: {
                content
            }
            .buttonStyle(RowPressStyle())
            .accessibilityHint("Change, turn off or reset")
        } else {
            content
        }
    }

    private func change(_ action: @escaping @MainActor () async -> String?) {
        Haptics.selection()
        Task {
            if let failure = await action() { env.toasts.show(failure) }
        }
    }
}

/// A binding drawn as keycaps: ⌘ K, or G then P.
struct KeyCaps: View {
    let binding: String

    var body: some View {
        let steps = ShortcutBinding.steps(binding) ?? []
        HStack(spacing: 4) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                if index > 0 { Text("then").font(ODFont.sans(11.5)).foregroundStyle(Theme.fg4) }
                Text(step.label)
                    .font(ODFont.mono(12))
                    .foregroundStyle(Theme.fg2)
                    .padding(.horizontal, 6)
                    .frame(minWidth: 22, minHeight: 22)
                    .background(Theme.sunken, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ShortcutBinding.label(binding))
    }
}

/// Records new keys for a shortcut from the keyboard: one key with ⌘, or up to two keys pressed one
/// after the other.
struct ShortcutRecorderSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let command: ShortcutCommand

    @State private var steps: [KeyStep] = []
    @State private var saving = false
    @FocusState private var focused: Bool

    private var store: ShortcutsStore { .shared }
    private var binding: String { steps.map(\.raw).joined(separator: " ") }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            AccountSheetHeader(title: command.title, subtitle: "Press the keys on your keyboard.", closeLabel: "Cancel") { dismiss() }
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Theme.sunken)
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(focused ? Theme.lineStrong : Theme.line, lineWidth: 1))
                if steps.isEmpty {
                    Text("Waiting for keys").font(ODFont.sans(15)).foregroundStyle(Theme.fg3)
                } else {
                    KeyCaps(binding: binding)
                }
            }
            .frame(height: 72)
            .focusable()
            .focused($focused)
            .focusEffectDisabled()
            .onKeyPress(phases: .down) { press in
                record(press)
                return .handled
            }
            .onTapGesture { focused = true }
            if let clash = steps.isEmpty ? nil : store.clash(binding, except: command.id) {
                Text("\(clash.title) uses these keys too. Saving gives them to \(command.title) as well, and the first one listed answers.")
                    .font(ODFont.footnote)
                    .foregroundStyle(Tone.amber.text)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("A key with \u{2318} stands alone. Without it, a second key can follow, such as G then P.")
                    .font(ODFont.footnote)
                    .foregroundStyle(Theme.fg3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                Button("Start over") {
                    steps = []
                    focused = true
                }
                .buttonStyle(OutlineButtonStyle())
                .disabled(steps.isEmpty)
                Button {
                    Task { await save() }
                } label: {
                    ButtonLabel(title: "Save", busy: saving)
                }
                .buttonStyle(InkButtonStyle())
                .disabled(ShortcutBinding.steps(binding) == nil || saving)
            }
            Spacer(minLength: 0)
        }
        .padding(22)
        .background(Theme.surface)
        .onAppear {
            store.recording = true
            focused = true
        }
        .onDisappear { store.recording = false }
    }

    private func record(_ press: KeyPress) {
        guard let step = KeyStep(press: press) else { return }
        Haptics.selection()
        // A finished binding starts over with the next key.
        if steps.count == 2 || steps.first?.hasMod == true { steps = [] }
        steps.append(step)
    }

    private func save() async {
        saving = true
        let failure = await store.set(command.id, to: binding)
        saving = false
        if let failure {
            env.toasts.show(failure)
            return
        }
        Haptics.success()
        dismiss()
    }
}
