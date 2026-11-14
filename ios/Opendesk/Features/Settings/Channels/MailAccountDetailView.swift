import SwiftUI

/// One Collab mail account's settings (the web's `MailAccountDetail`): status and sync, older
/// mail, name, From name and colour, signature, sharing, replying, handling, server settings,
/// inbox categories and sender rules, and disconnecting it. Only whoever connected it, or an
/// admin for a shared one (`can_manage`), changes it.
struct MailAccountDetailView: View {
    let id: String

    @Environment(AppEnvironment.self) private var env
    @State private var store = MailAccountsStore()
    @State private var draft: MailAccountDraft?
    @State private var base: MailAccountDraft?
    @State private var imap = MailImapForm()
    @State private var imapBase = MailImapForm()
    @State private var saving = false
    @State private var syncing = false
    @State private var pulling = false
    @State private var failure: String?
    @State private var confirm: AccountConfirm?
    @State private var web: String?
    @State private var handingOver = false

    private var item: SettingsMailAccount? { store.account(id) }

    var body: some View {
        AccountPage(title: item?.account.label ?? "Mail account") {
            ChannelLoading(loaded: store.loaded, error: item == nil ? store.error : nil, retry: reload) {
                if let item, let draft = Binding($draft) {
                    content(item, draft)
                } else if store.loaded {
                    EmptyState(symbol: "tray", title: "This account is gone", message: "It was disconnected, or you no longer have access to it.")
                        .padding(.top, 30)
                }
            }
        }
        .settingsSaveBar(dirty: item?.account.canManage == true && !patch.isEmpty, saving: saving, canSave: canSave, save: save) {
            draft = base
            imap = imapBase
        }
        .accountConfirm($confirm)
        .channelWebSheet($web) { reload() }
        .sheet(isPresented: $handingOver) {
            AddInboxSheet(account: item?.account) { id in
                reload()
                env.router.openMailbox(id)
            }
            .presentationDetents([.large])
            .presentationCornerRadius(Theme.Radius.sheet)
        }
        .refreshable { await load() }
        .onAppear {
            store.attach(env.session.api)
            reload()
        }
    }

    private func reload() { Task { await load() } }

    private func load() async {
        await store.load(admin: env.session.isAdmin)
        guard let item else { return }
        let next = MailAccountDraft(item.account)
        // A name or signature changed at the provider replaces the field while it is not being edited.
        if draft == nil || draft == base { draft = next }
        base = next
        let form = MailImapForm(account: item)
        if imap == imapBase { imap = form }
        imapBase = form
    }

    private var patch: ChannelBody {
        guard let draft, let base, let item else { return [:] }
        var body = draft.patch(from: base)
        if item.account.provider == .imap, let changes = imap.patch(from: imapBase) { body["imap"] = changes }
        return body
    }

    private var canSave: Bool {
        guard let draft, item?.account.canManage == true, !patch.isEmpty else { return false }
        if draft.shared, draft.audience.isEmpty { return false }
        if MailFromName.problem(draft.displayName) != nil { return false }
        if item?.account.provider == .imap, !imap.valid(passwordRequired: false) { return false }
        return true
    }

    @ViewBuilder
    private func content(_ item: SettingsMailAccount, _ draft: Binding<MailAccountDraft>) -> some View {
        let account = item.account
        let manage = account.canManage
        header(account)
        if !manage { SettingsReadOnlyNote(text: "Only whoever connected this account, or a workspace admin for a shared one, can change it.") }
        if let failure { ChannelBanner(tone: .red, title: "The account was not connected.", message: failure, mono: true) }

        AccountSection(title: "Status") {
            AccountRow(title: "Status", subtitle: account.lastSyncedAt.map { "Synced \(Format.relLong($0))" } ?? "Not synced yet") {
                MailAccountStatusPill(account: account)
            }
            AccountDivider(tiles: false)
            ChannelRowButton(title: "Sync now", busy: syncing) { sync(account) }
            if account.reconnect, manage {
                AccountDivider(tiles: false)
                ChannelActionRow(title: "Reconnect", subtitle: "The provider refused the saved sign-in. Connect it again to resume syncing.", button: account.provider == .imap ? "Update password" : "Reconnect", buttonTone: .red) {
                    reconnect(account)
                }
            }
            if !account.lastError.isEmpty {
                AccountDivider(tiles: false)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Last error").font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
                    Text(account.lastError).font(ODFont.mono(12)).foregroundStyle(Theme.fg2).textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
            }
        }

        MailAccountHistorySection(store: store, item: item)

        if manage, env.canHandOver(account) {
            AccountSection(title: "Ticket inbox", footer: "Only mail that arrives from now on becomes tickets. What is already there stays in Mail.") {
                ChannelActionRow(title: "Use for tickets", subtitle: "New mail to \(account.email) becomes tickets your team answers, read with the connection it already has.", button: "Use for tickets") {
                    handingOver = true
                }
            }
        }

        AccountSection(title: "General") {
            VStack(alignment: .leading, spacing: 14) {
                ODTextField(label: "Name in the sidebar", text: draft.name, prompt: account.email)
                VStack(alignment: .leading, spacing: 8) {
                    ODTextField(label: "From name", text: draft.displayName, prompt: env.session.user?.name ?? "Your name")
                    FlowLayout(spacing: 6) {
                        ForEach(["{agent}", "{agent_first}", "{mailbox}", "{workspace}"], id: \.self) { variable in
                            Button(variable) {
                                let text = draft.wrappedValue.displayName
                                draft.wrappedValue.displayName = text + (text.isEmpty || text.hasSuffix(" ") ? "" : " ") + variable
                            }
                            .buttonStyle(ChipButtonStyle())
                            .font(ODFont.mono(12))
                        }
                    }
                    ChannelHint("How your name reads on mail you send from this account. Tap a variable to name whoever sends: on a shared account, each person's mail carries their own name. \(MailAccountCopy.fromNameSync(item))")
                    if let problem = MailFromName.problem(draft.wrappedValue.displayName) { FormError(text: problem) }
                    if manage, account.provider == .google, item.displayNameSync == "two_way" || item.displayNameSync == "read_only" {
                        Button { pullName(account) } label: { ButtonLabel(title: "Get from Gmail", busy: pulling) }
                            .buttonStyle(OutlineButtonStyle(fullWidth: false, height: 34))
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Colour").font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
                    HStack(spacing: 8) {
                        ForEach(MailAccountsStore.colors, id: \.self) { color in
                            let tone = MailTone.of(color)
                            Button { draft.wrappedValue.color = color } label: {
                                Circle().fill(tone.solid).frame(width: 22, height: 22)
                                    .overlay(Circle().strokeBorder(Theme.fg, lineWidth: draft.wrappedValue.color == color ? 2 : 0).padding(-3))
                                    .frame(width: 28, height: 28)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(color.capitalized)
                            .accessibilityAddTraits(draft.wrappedValue.color == color ? .isSelected : [])
                        }
                    }
                    ChannelHint("Its dot in the sidebar and on conversations")
                }
            }
            .padding(14)
            .disabled(!manage)
        }

        AccountSection(title: "Signature", footer: "Added to new mail and replies from this account. Type a variable to add the sender's name, title or phone: each person's mail carries their own.") {
            VStack(alignment: .leading, spacing: 10) {
                Notice(text: MailAccountCopy.signatureSync(item))
                AccountTextEditor(label: "Signature", text: draft.signature.text, prompt: "Your signature", minHeight: 110)
                if HTMLText.plain(from: draft.wrappedValue.signature.originalHTML) != draft.wrappedValue.signature.originalHTML.trimmingCharacters(in: .whitespacesAndNewlines), !draft.wrappedValue.signature.changed {
                    ChannelHint("Its formatting stays until you change the text here. The web app edits links and images.")
                }
                if account.provider == .google, draft.wrappedValue.signature.text.contains("{{") {
                    ChannelHint("Uses variables, so it is kept in opendesk; Gmail keeps its own.")
                }
            }
            .padding(14)
            .disabled(!manage)
        }

        AccountSection(title: "Addresses and out of office") {
            ChannelWebRow(symbol: "at", title: "Open in the web app", subtitle: account.aliases.isEmpty ? "The addresses this account sends from, and its automatic reply" : "\(ChannelFormat.plural(account.aliases.count + 1, "address", "addresses")), and its automatic reply", path: "/settings/mail-accounts/\(account.id)") { reload() }
        }

        if manage {
            MailAccountCategoriesSection(store: store, item: item)
        }

        AccountSection(title: "Sharing", footer: "Who reads and answers this account's mail with you") {
            MailVisibilityPicker(
                shared: draft.shared,
                audience: draft.audience,
                canBePrivate: account.owner?.id == env.session.user?.id || !(base?.shared ?? false),
                disabled: !manage,
                exclude: account.owner?.id
            )
            .padding(14)
        }

        AccountSection(title: "Replying", footer: "How everyone answers mail from this account") {
            AccountToggleRow(title: "Reply all by default", subtitle: "Reply all comes first for everyone answering from this account.", isOn: draft.replyAll, disabled: !manage)
        }

        if draft.wrappedValue.shared {
            AccountSection(title: "Handling", footer: "Keep shared inbox work separate from read and unread mail") {
                AccountToggleRow(title: "Track conversations needing action", subtitle: "New incoming mail needs action until someone marks it done. This does not change mail at your provider.", isOn: draft.handling, disabled: !manage)
            }
        }

        if account.provider == .imap, manage {
            AccountSection(title: "Server settings", footer: "New settings are tried before they are saved") {
                VStack(alignment: .leading, spacing: 14) {
                    ODTextField(label: "Password", text: $imap.password, prompt: "", secure: true, contentType: .password)
                    ChannelHint("Leave empty to keep the current password. A new server needs the password again.")
                    MailImapServerFields(form: $imap)
                }
                .padding(14)
            }
        }

        if manage {
            AccountSection(title: "Disconnect account") {
                ChannelActionRow(title: "Disconnect", subtitle: "Removes the account and its mail from opendesk. Nothing is deleted at the provider.", button: "Disconnect", buttonTone: .red) {
                    confirm = AccountConfirm(title: "Disconnect \(account.email)?", message: "Its mail, comments and shares leave opendesk. Nothing is deleted at the provider: your mail stays in your account.", confirmTitle: "Disconnect") {
                        do {
                            try await store.remove(account.id)
                            Haptics.success()
                            env.toasts.show("\(account.email) disconnected", kind: .success)
                            env.router.accountPath.removeLast()
                        } catch { env.toasts.error(error) }
                    }
                }
            }
        }
    }

    private func header(_ account: MailAccount) -> some View {
        HStack(spacing: 12) {
            AccountIconTile(symbol: MailAccountsStore.symbol(account.provider), tone: account.tone, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(account.label).font(ODFont.sans(18, weight: .semibold)).foregroundStyle(Theme.fg).lineLimit(1)
                    TonePill(text: account.isPrivate ? "Private" : "Shared", tone: account.isPrivate ? .gray : .blue, height: 19)
                }
                Text(account.email).font(ODFont.mono(12.5)).foregroundStyle(Theme.fg3).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
    }

    private func reconnect(_ account: MailAccount) {
        // Google and Microsoft sign in through the web app; IMAP takes its password here.
        if account.provider == .imap {
            failure = nil
            env.toasts.show("Enter the password under Server settings, then save.", kind: .info)
        } else {
            web = "/settings/mail-accounts/\(account.id)"
        }
    }

    private func sync(_ account: MailAccount) {
        syncing = true
        Task {
            do {
                try await store.sync(account.id)
                env.toasts.show("Syncing \(account.label)")
            } catch { env.toasts.error(error) }
            syncing = false
        }
    }

    private func pullName(_ account: MailAccount) {
        pulling = true
        Task {
            do {
                let next = try await store.pullDisplayName(account.id)
                draft?.displayName = next.account.displayName
                base?.displayName = next.account.displayName
                env.toasts.show("From name updated from Gmail", kind: .success)
            } catch { env.toasts.error(error) }
            pulling = false
        }
    }

    private func save() {
        let body = patch
        guard !body.isEmpty else { return }
        saving = true
        failure = nil
        Task {
            do {
                let next = try await store.patch(id, body)
                draft = MailAccountDraft(next.account)
                base = draft
                imap = MailImapForm(account: next)
                imapBase = imap
                Haptics.success()
                env.toasts.show("Saved", kind: .success)
            } catch {
                Haptics.error()
                failure = (error as? APIError)?.detail ?? error.userMessage
            }
            saving = false
        }
    }
}

/// What the General, Signature, Sharing, Replying and Handling sections edit.
struct MailAccountDraft: Equatable {
    var name: String
    var displayName: String
    var color: String
    var signature: ChannelRichText
    var shared: Bool
    var audience: MailAudience
    var replyAll: Bool
    var handling: Bool

    init(_ account: MailAccount) {
        name = account.name
        displayName = account.displayName
        color = account.color
        signature = ChannelRichText(html: account.signatureHTML)
        shared = !account.isPrivate
        audience = account.sharedWith
        replyAll = account.replyAll
        handling = account.handlingEnabled
    }

    /// Only what changed; the signature only when its text was edited, so saving other settings
    /// never writes a signature back to Gmail.
    func patch(from base: MailAccountDraft) -> ChannelBody {
        var body: ChannelBody = [:]
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        if trimmedName != base.name { body["name"] = .string(trimmedName) }
        let trimmedFrom = displayName.trimmingCharacters(in: .whitespaces)
        if trimmedFrom != base.displayName { body["display_name"] = .string(trimmedFrom) }
        if color != base.color { body["color"] = .string(color) }
        if signature.changed { body["signature_html"] = .string(signature.html) }
        if shared != base.shared { body["visibility"] = .string(shared ? "shared" : "private") }
        if handling != base.handling { body["handling_enabled"] = .bool(handling) }
        if replyAll != base.replyAll { body["reply_all"] = .bool(replyAll) }
        if shared {
            let next = audience.everyone ? MailAudience(everyone: true) : audience
            if shared != base.shared || next != base.audience { body["shared_with"] = MailAccountsStore.audienceJSON(next) }
        }
        return body
    }
}

extension MailImapForm {
    init(account: SettingsMailAccount) {
        self.init()
        email = account.account.email
        name = account.account.name
        settings = account.imap ?? MailImapSettings()
    }

    /// The server fields that changed, and a password when one was typed.
    func patch(from base: MailImapForm) -> JSONValue? {
        var out: [String: JSONValue] = [:]
        let a = settings, b = base.settings
        if a.imapHost != b.imapHost { out["imap_host"] = .string(a.imapHost.trimmingCharacters(in: .whitespaces)) }
        if a.imapPort != b.imapPort { out["imap_port"] = .chInt(a.imapPort) }
        if a.imapTLS != b.imapTLS { out["imap_tls"] = .string(a.imapTLS) }
        if a.imapUsername != b.imapUsername { out["imap_username"] = .string(a.imapUsername) }
        if a.smtpHost != b.smtpHost { out["smtp_host"] = .string(a.smtpHost.trimmingCharacters(in: .whitespaces)) }
        if a.smtpPort != b.smtpPort { out["smtp_port"] = .chInt(a.smtpPort) }
        if a.smtpTLS != b.smtpTLS { out["smtp_tls"] = .string(a.smtpTLS) }
        if a.smtpUsername != b.smtpUsername { out["smtp_username"] = .string(a.smtpUsername) }
        if !password.isEmpty { out["password"] = .string(password) }
        if !smtpPassword.isEmpty { out["smtp_password"] = .string(smtpPassword) }
        return out.isEmpty ? nil : .object(out)
    }
}

/// A Collab From name as the server refuses it (the web's `fromNameProblem` with Collab's variables).
enum MailFromName {
    static let variables: Set<String> = ["agent", "agent_first", "mailbox", "workspace"]

    static func problem(_ format: String) -> String? {
        let collapsed = format.trimmingCharacters(in: .whitespaces).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if collapsed.count > 80 { return "Keep the From name under 80 characters." }
        if format.contains(where: { "<>\"".contains($0) }) { return "Use plain text, without < > or quotes." }
        var rest = Substring(format)
        while let open = rest.firstIndex(of: "{") {
            guard let close = rest[open...].firstIndex(of: "}") else { return "Use only the variables above." }
            if !variables.contains(String(rest[rest.index(after: open) ..< close])) { return "Use only the variables above." }
            rest = rest[rest.index(after: close)...]
        }
        return rest.contains("}") ? "Use only the variables above." : nil
    }
}

enum MailAccountCopy {
    static func signatureSync(_ item: SettingsMailAccount) -> String {
        switch item.signatureSync {
        case "two_way": "Synced with Gmail. Changes here update Gmail too, and changes in Gmail show up here."
        case "read_only": "Read from Gmail. Reconnect the account to edit your Gmail signature from here."
        case "microsoft": "Outlook doesn't share signatures with apps, so this signature lives in opendesk."
        default: item.account.provider == .microsoft ? "Outlook doesn't share signatures with apps, so this signature lives in opendesk." : "This signature lives in opendesk."
        }
    }

    static func fromNameSync(_ item: SettingsMailAccount) -> String {
        switch item.displayNameSync {
        case "two_way": "Synced with Gmail: a change here changes it in Gmail too."
        case "read_only": "Read from Gmail. Reconnect the account to change it in Gmail from here."
        case "microsoft": "Follows your Microsoft profile until you change it here."
        default: "This name lives in opendesk."
        }
    }

    static func provider(_ provider: MailProvider) -> String {
        switch provider {
        case .google: "Gmail"
        case .microsoft: "Outlook"
        case .imap: "your mail server"
        }
    }
}

// MARK: - History

/// Older mail: what is in opendesk, the import running now, and starting one.
private struct MailAccountHistorySection: View {
    let store: MailAccountsStore
    let item: SettingsMailAccount

    @Environment(AppEnvironment.self) private var env
    @State private var scope = "1y"
    @State private var spamTrash = false
    @State private var busy = false
    @State private var confirm: AccountConfirm?

    var body: some View {
        let account = item.account
        let history = item.historyDetail
        let manage = account.canManage
        AccountSection(title: "Mail history", footer: "The first sync brings the last 30 days. Import older mail to read and search it here.") {
            AccountRow(title: "In opendesk", subtitle: coverage)
            if let history, !history.status.isEmpty {
                AccountDivider(tiles: false)
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        TonePill(text: status(history.status), tone: tone(history.status))
                        Text(history.since.map { "Mail since \($0.formatted(date: .abbreviated, time: .omitted))" } ?? "All mail")
                            .font(ODFont.footnote).foregroundStyle(Theme.fg3)
                        Spacer(minLength: 0)
                    }
                    if history.active, let total = history.total, total > 0 {
                        ProgressView(value: Double(min(history.imported + history.present, total)), total: Double(total)).tint(Theme.fg)
                    }
                    Text(counts(history)).font(ODFont.sans(12)).foregroundStyle(Theme.fg3)
                    if let reached = history.reached { Text("Reached \(reached.formatted(date: .abbreviated, time: .omitted))").font(ODFont.sans(12)).foregroundStyle(Theme.fg3) }
                    if history.status == "limited" {
                        Text("The workspace reached its Collab storage allowance. The import goes on by itself once there is room.").font(ODFont.sans(12)).foregroundStyle(Tone.amber.text)
                    }
                    if !history.lastError.isEmpty {
                        Text(history.active ? "Trying again with the next sync: \(history.lastError)" : history.lastError).font(ODFont.mono(11.5)).foregroundStyle(Theme.fg2)
                    }
                    if manage, history.active {
                        HStack(spacing: 8) {
                            Button(history.status == "paused" ? "Resume" : "Pause") { pause(history.status != "paused") }
                                .buttonStyle(ChipButtonStyle())
                            Button("Stop") {
                                confirm = AccountConfirm(title: "Stop importing?", message: "Mail already imported stays.", confirmTitle: "Stop") {
                                    do {
                                        try await store.stopHistory(account.id)
                                        env.toasts.show("Import stopped")
                                    } catch { env.toasts.error(error) }
                                }
                            }
                            .buttonStyle(ChipButtonStyle())
                            Spacer()
                        }
                        .disabled(busy)
                    }
                }
                .padding(14)
            }
            if manage, !(history?.active ?? false), !(history?.since == nil && history?.status == "done") {
                AccountDivider(tiles: false)
                ChannelMenuRow(title: "How far back", subtitle: "New mail keeps arriving while it runs.", value: MailAccountsStore.historyLabel(scope)) {
                    ForEach(["1y", "2y", "5y", "all"], id: \.self) { value in Button(MailAccountsStore.historyLabel(value)) { scope = value } }
                }
                AccountDivider(tiles: false)
                AccountToggleRow(title: "Include spam and trash", subtitle: "Left out by default: old spam is rarely worth keeping.", isOn: $spamTrash)
                AccountDivider(tiles: false)
                ChannelRowButton(title: history == nil || history?.status.isEmpty == true ? "Import older mail" : "Import again", busy: busy, action: start)
            }
        }
        .accountConfirm($confirm)
    }

    private var coverage: String {
        let account = item.account
        let provider = MailAccountCopy.provider(account.provider)
        guard let oldest = account.oldestMessageAt else { return "No mail from this account is in opendesk yet." }
        let date = oldest.formatted(date: .abbreviated, time: .omitted)
        if account.history?.importedAll == true { return "All of this account's mail is in opendesk, back to \(date)." }
        return "Mail since \(date) is in opendesk. Older mail stays at \(provider)."
    }

    private func status(_ value: String) -> String {
        switch value {
        case "running": "Importing older mail"
        case "paused": "Import paused"
        case "limited": "Waiting for storage"
        case "done": "Import finished"
        case "canceled": "Import stopped"
        case "error": "Import stopped by an error"
        default: value.capitalized
        }
    }

    private func tone(_ value: String) -> Tone {
        switch value {
        case "running": .blue
        case "done": .green
        case "error": .red
        case "limited": .amber
        default: .gray
        }
    }

    private func counts(_ history: MailHistoryDetail) -> String {
        var parts = ["\(history.imported) imported"]
        if history.present > 0 { parts.append("\(history.present) already here") }
        if history.tooLarge > 0 { parts.append("\(history.tooLarge) too large") }
        if history.unreadable > 0 { parts.append("\(history.unreadable) unreadable") }
        return parts.joined(separator: " · ")
    }

    private func start() {
        busy = true
        Task {
            do {
                try await store.startHistory(item.id, since: MailAccountsStore.historySince(scope) ?? .null, spamTrash: spamTrash)
                env.toasts.show("Importing older mail from \(item.account.label)", kind: .success)
            } catch { env.toasts.error(error) }
            busy = false
        }
    }

    private func pause(_ paused: Bool) {
        busy = true
        Task {
            do {
                try await store.pauseHistory(item.id, paused)
                env.toasts.show(paused ? "Import paused" : "Import resumed")
            } catch { env.toasts.error(error) }
            busy = false
        }
    }
}

// MARK: - Categories

/// An account's inbox categories: follow, Gmail's, its own, or off; Ollie's sorting; sender rules.
private struct MailAccountCategoriesSection: View {
    let store: MailAccountsStore
    let item: SettingsMailAccount

    @Environment(AppEnvironment.self) private var env
    @State private var settings: MailCategorySettings?
    @State private var mode = "follow"
    @State private var categories: [MailCategory] = []
    @State private var ai = true
    @State private var saving = false
    @State private var rules: [MailCategoryRule] = []
    @State private var sender = ""
    @State private var ruleCategory: String?
    @State private var adding = false

    private var current: MailAccountCategories { item.account.categories ?? MailAccountCategories() }

    var body: some View {
        let c = current
        let locked = c.locked
        let dirty = mode != c.mode || ai != item.categoriesAI || (mode == "custom" && categories != baseCategories)
        let problem = mode == "custom" ? MailCategoryKit.problem(categories) : nil
        AccountSection(title: "Inbox categories", footer: "Split this inbox into tabs like Primary, Updates and Newsletters. New mail is sorted as it arrives, and nothing leaves the inbox.") {
            VStack(alignment: .leading, spacing: 10) {
                if locked { Notice(text: "Your workspace's admins set the categories. You can still choose whether Ollie sorts this account's mail.", symbol: "lock") }
                if c.engine == "gmail", let note = syncNote(item.categoriesSyncStatus) { Notice(text: note) }
                VStack(spacing: 0) {
                    AccountChoiceRow(symbol: "tray", title: followTitle, subtitle: followHint, chosen: mode == "follow") { mode = "follow" }
                    if item.account.provider == .google {
                        Hairline(inset: 56)
                        AccountChoiceRow(symbol: "envelope", title: "Sync with Gmail", subtitle: "Use Gmail's categories. Moving a conversation here changes it in Gmail, and changes in Gmail appear here. Ollie and sender rules do not sort this inbox.", chosen: mode == "gmail") { mode = "gmail" }
                    }
                    Hairline(inset: 56)
                    AccountChoiceRow(symbol: "slider.horizontal.3", title: "Choose my own", subtitle: "Categories of your own for this account.", chosen: mode == "custom") { mode = "custom" }
                    Hairline(inset: 56)
                    AccountChoiceRow(symbol: "nosign", title: "Don't split this inbox", subtitle: "Everything stays in one inbox, whatever the workspace sets.", chosen: mode == "off") { mode = "off" }
                }
                .disabled(locked)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
                if mode == "gmail", let gmail = settings?.gmailCategories, !gmail.isEmpty {
                    MailCategoryPills(categories: gmail)
                }
                if mode == "custom" {
                    MailCategoryEditor(categories: $categories, presets: settings?.presets ?? [], suggest: settings?.suggest ?? false, accountID: item.id, disabled: locked, api: store.api)
                }
            }
            .padding(14)
            if mode != "gmail" {
                AccountDivider(tiles: false)
                AccountToggleRow(title: "Let Ollie sort new mail", subtitle: settings?.sorting == "rules" ? "Ollie reads the sender, subject and first lines of new mail to pick its tab. When off, only sender rules and mail headers sort it. AI is off for the workspace, so rules and headers sort it for now." : "Ollie reads the sender, subject and first lines of new mail to pick its tab. When off, only sender rules and mail headers sort it.", isOn: $ai)
            }
            AccountDivider(tiles: false)
            VStack(alignment: .leading, spacing: 8) {
                if dirty, let problem { FormError(text: problem) }
                HStack {
                    Spacer()
                    if dirty { Button("Discard", action: reset).buttonStyle(ChipButtonStyle()) }
                    Button(action: save) { ButtonLabel(title: "Save", busy: saving) }
                        .buttonStyle(InkButtonStyle())
                        .frame(width: 96)
                        .disabled(!dirty || problem != nil || saving)
                }
            }
            .padding(14)
        }
        if c.enabled, c.engine != "gmail" {
            rulesSection(c.categories)
        }
        EmptyView()
            .task(id: item.id) {
                reset()
                settings = await store.categorySettings()
                if mode == "custom", categories.isEmpty { categories = MailCategoryKit.defaults(settings?.presets ?? []) }
                rules = await store.rules(item.id)
            }
            .onChange(of: item) { old, _ in
                // A change from elsewhere replaces the form while it is not being edited.
                let oldMode = old.account.categories?.mode ?? "follow"
                if mode == oldMode, ai == old.categoriesAI { reset() }
            }
    }

    private var baseCategories: [MailCategory] {
        let c = current
        if !item.ownCategories.isEmpty { return item.ownCategories }
        if c.enabled { return c.categories }
        return MailCategoryKit.defaults(settings?.presets ?? [])
    }

    private var followTitle: String {
        let c = current
        if c.mode == "follow", c.source == "team" { return "Follow \(item.categoriesTeam ?? "your team")'s categories" }
        if c.mode == "follow" ? c.source == "workspace" : settings?.workspace != nil { return "Follow the workspace's categories" }
        return "Follow the workspace"
    }

    private var followHint: String {
        let c = current
        let followed: [MailCategory]? = c.mode == "follow" ? (c.enabled ? c.categories : nil) : (settings?.workspace?.enabled == true ? settings?.workspace?.categories : nil)
        if let followed { return followed.map(\.name).joined(separator: ", ") }
        let none = c.mode == "follow" ? c.source == "none" : settings?.workspace == nil
        return none ? "No default yet, so the inbox stays one list until your admins set one." : "Turned off for now, so the inbox stays one list."
    }

    private func syncNote(_ status: String) -> String? {
        switch status {
        case "refreshing": "Refreshing categories from Gmail. Older conversations may take a little longer."
        case "pending": "Category changes are waiting for Gmail confirmation."
        case "failed": "Some category changes could not reach Gmail. Check the account connection and try moving the conversation again."
        default: nil
        }
    }

    private func reset() {
        mode = current.mode
        ai = item.categoriesAI
        categories = MailCategoryKit.unique(baseCategories)
        if ruleCategory == nil { ruleCategory = current.categories.first { !$0.isPrimary }?.key }
    }

    private func save() {
        let c = current
        var body: ChannelBody
        if c.locked {
            // Locked: only Ollie's switch is the manager's, so the mode goes back as it is.
            body = ["mode": .string(c.mode)]
            if c.engine != "gmail" { body["ai"] = .bool(ai) }
        } else if mode == "gmail" {
            body = ["mode": .string("gmail")]
        } else {
            body = ["mode": .string(mode)]
            if mode == "custom" { body["categories"] = MailCategoryKit.json(categories) }
            if ai != item.categoriesAI { body["ai"] = .bool(ai) }
        }
        let sorted = mode != c.mode || (mode == "custom" && categories != baseCategories)
        saving = true
        Task {
            do {
                let next = try await store.setCategories(item.id, body)
                mode = next.account.categories?.mode ?? mode
                ai = next.categoriesAI
                if !next.ownCategories.isEmpty { categories = next.ownCategories }
                Haptics.success()
                env.toasts.show(mode == "gmail" && sorted ? "Gmail category sync is on. Existing mail is being refreshed." : sorted ? "Categories saved. Mail is being sorted again." : "Saved", kind: .success)
            } catch {
                Haptics.error()
                env.toasts.show("Could not save the categories. \(error.userMessage)", kind: .error)
            }
            saving = false
        }
    }

    // MARK: Sender rules

    private func rulesSection(_ categories: [MailCategory]) -> some View {
        let valid = sender.trimmingCharacters(in: .whitespaces).range(of: #"^(@[^\s@]+\.[^\s@]+|[^\s@]+@[^\s@]+\.[^\s@]+)$"#, options: .regularExpression) != nil
        let pick = categories.first { $0.key == ruleCategory }
        let sorted = rules.sorted { $0.sender.trimmingCharacters(in: CharacterSet(charactersIn: "@")).localizedCompare($1.sender.trimmingCharacters(in: CharacterSet(charactersIn: "@"))) == .orderedAscending }
        return AccountSection(title: "Sender rules", footer: "Mail from these senders always goes to their tab. Adding a rule moves the sender's mail in the inbox now.") {
            if sorted.isEmpty {
                Text("No rules yet. Moving a conversation to a tab also offers \"Always for this sender\".")
                    .font(ODFont.footnote).foregroundStyle(Theme.fg3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
            } else {
                ForEach(Array(sorted.enumerated()), id: \.element.id) { index, rule in
                    if index > 0 { AccountDivider(tiles: false) }
                    let category = categories.first { $0.key == rule.category } ?? MailCategory(key: rule.category, name: rule.category)
                    HStack(spacing: 8) {
                        Text(rule.sender).font(ODFont.mono(12.5)).foregroundStyle(Theme.fg).lineLimit(1)
                        Image(systemName: "arrow.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.fg4)
                        MailCategoryPills(categories: [category]).fixedSize()
                        Spacer(minLength: 4)
                        Button { remove(rule) } label: {
                            Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.fg3).frame(width: 30, height: 30)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove the rule for \(rule.sender)")
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                }
            }
            AccountDivider(tiles: false)
            VStack(alignment: .leading, spacing: 10) {
                ODTextField(label: "Sender", text: $sender, prompt: "news@example.com or @example.com", contentType: .emailAddress, keyboard: .emailAddress, submitLabel: .done, onSubmit: { add(pick, valid: valid) })
                if !sender.isEmpty, !valid { FormError(text: "Enter an address, or @ and a domain.") }
                ChannelMenuField(label: "Category", value: pick?.name ?? "Category") {
                    ForEach(categories) { category in Button(category.name) { ruleCategory = category.key } }
                }
                Button { add(pick, valid: valid) } label: { ButtonLabel(title: "Add rule", busy: adding) }
                    .buttonStyle(OutlineButtonStyle())
                    .disabled(sender.trimmingCharacters(in: .whitespaces).isEmpty || pick == nil || !valid || adding)
            }
            .padding(14)
        }
    }

    private func add(_ pick: MailCategory?, valid: Bool) {
        guard let pick, valid else { return }
        adding = true
        let address = sender.trimmingCharacters(in: .whitespaces).lowercased()
        Task {
            do {
                let rule = try await store.addRule(item.id, sender: address, category: pick.key)
                // One rule per sender: a second replaces the first.
                rules = [rule] + rules.filter { $0.sender != rule.sender && $0.id != rule.id }
                sender = ""
                env.toasts.show("Mail from \(rule.sender) goes to \(pick.name)", kind: .success)
            } catch {
                env.toasts.show("Could not change the rules. \(error.userMessage)", kind: .error)
            }
            adding = false
        }
    }

    private func remove(_ rule: MailCategoryRule) {
        let before = rules
        rules.removeAll { $0.id == rule.id }
        Task {
            do { try await store.removeRule(item.id, rule: rule.id) } catch {
                rules = before
                env.toasts.show("Could not change the rules", kind: .error)
            }
        }
    }
}
