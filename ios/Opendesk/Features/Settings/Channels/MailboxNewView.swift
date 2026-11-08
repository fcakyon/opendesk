import SwiftUI

/// "Add a mailbox": the address, how its mail reaches opendesk, and how replies go out.
/// Forwarding, IMAP and SMTP, and password sign-in are set up here; signing in with Google
/// or Microsoft runs in the web app, whose sign-in cookie the provider's callback checks.
struct MailboxNewView: View {
    var brandID: String?
    var title = "Add a mailbox"
    /// Where the new mailbox goes once added (Add a ticket inbox); its settings page when nil.
    var onDone: ((String) -> Void)?

    @Environment(AppEnvironment.self) private var env
    @State private var store = MailboxSettingsStore()
    @State private var form = MailboxNewForm()
    @State private var detection: MailboxDetection?
    @State private var detected = false
    @State private var detecting = false
    @State private var saving = false
    @State private var error: String?
    @State private var web: String?
    @State private var before: Set<String> = []
    @State private var allMethods = false

    var body: some View {
        AccountPage(title: title, spacing: 20) {
            Text("Choose how mail reaches opendesk. You can change the details later.")
                .font(ODFont.callout)
                .foregroundStyle(Theme.fg3)
                .padding(.horizontal, 4)
            if !env.session.isAdmin {
                SettingsReadOnlyNote(text: "Only admins can add a mailbox.")
            } else {
                address
                if detected {
                    methods
                    if let method = form.method { connect(method) }
                    if form.method != nil, !form.method!.oauth, !(form.method == .forwarding && form.outbound == "provider") {
                        addressing
                        FormError(text: error)
                        Button(action: submit) {
                            ButtonLabel(title: saving ? "Checking the sign-in" : "Add mailbox", busy: saving)
                        }
                        .buttonStyle(InkButtonStyle())
                        .disabled(!form.valid || saving)
                    }
                }
            }
        }
        .motion(Motion.snappy, value: detected)
        .motion(Motion.snappy, value: form.method)
        .channelWebSheet($web, onClose: returnedFromWeb)
        .task {
            store.attach(env.session.api)
            form.brandID = brandID
            await store.loadExtras(admin: env.session.isAdmin)
            await store.load()
            before = Set(store.mailboxes.map(\.id))
        }
    }

    // MARK: Address

    private var address: some View {
        ChannelForm(title: "Address") {
            ODTextField(label: "Name", text: $form.name, prompt: "Support")
            ChannelHint("Shown to your team, like Support or Billing.")
            ODTextField(label: "Email address", text: $form.email, prompt: "support@company.com", contentType: .emailAddress, keyboard: .emailAddress, submitLabel: .continue, onSubmit: lookUp)
            ChannelHint("The address customers write to.")
            if !form.email.isEmpty, !ChannelValidate.email(form.email) { FormError(text: "That doesn't look like an email address.") }
            if detecting {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Looking up \(form.domain)").font(ODFont.footnote).foregroundStyle(Theme.fg3)
                }
            } else if detected {
                detectionCard
            } else {
                Button("Continue", action: lookUp)
                    .buttonStyle(InkButtonStyle())
                    .disabled(form.name.trimmingCharacters(in: .whitespaces).isEmpty || !ChannelValidate.email(form.email))
            }
        }
        .onChange(of: form.email) { _, _ in
            guard detected else { return }
            detected = false
            detection = nil
            form.method = nil
        }
    }

    private var detectionCard: some View {
        let source: String = {
            guard let detection else { return "We couldn't look up \(form.domain). You can still choose how to connect." }
            switch detection.source {
            case "known": return "A known email provider"
            case "mx": return "Detected from the domain's MX records"
            case "autoconfig": return "From the domain's autoconfig file"
            case "ispdb": return "From Thunderbird's provider database"
            case "srv": return "From the domain's DNS service records"
            default: return store.options.mailboxIMAP ? "We couldn't tell who hosts \(form.domain). Enter the server settings, or forward mail." : "We couldn't tell who hosts \(form.domain). Forwarding works with any provider."
            }
        }()
        return HStack(alignment: .top, spacing: 10) {
            AccountIconTile(symbol: "globe", tone: .blue, size: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(detection.map { $0.label.isEmpty ? MailboxKinds.hostLabel($0.host) : $0.label }.flatMap { $0.isEmpty ? nil : $0 } ?? form.domain)
                    .font(ODFont.sans(14.5, weight: .medium)).foregroundStyle(Theme.fg)
                Text(source).font(ODFont.footnote).foregroundStyle(Theme.fg3).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func lookUp() {
        guard ChannelValidate.email(form.email), !form.name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        detecting = true
        Task {
            detection = await store.detect(form.email.trimmingCharacters(in: .whitespaces).lowercased())
            form.apply(detection)
            detecting = false
            detected = true
            form.method = available.first
        }
    }

    // MARK: Methods

    private var provider: String? {
        if let oauth = detection?.oauth { return oauth }
        if MailboxKinds.isGoogle(detection?.host ?? "") { return "google" }
        if MailboxKinds.isMicrosoft(detection?.host ?? "") { return "microsoft" }
        return nil
    }

    private var available: [MailboxMethod] {
        let options = store.options
        var out: [MailboxMethod] = []
        let imap = options.mailboxIMAP
        if let provider {
            let p = provider == "google" ? options.google : options.microsoft
            if p.apiSync { out.append(provider == "google" ? .googleAPI : .microsoftAPI) }
            if options.forwarding { out.append(.forwarding) }
            if imap, options.instanceIMAP, p.oauth { out.append(provider == "google" ? .google : .microsoft) }
        }
        let auth = detection?.passwordAuth ?? "password"
        if imap, detection?.imap != nil, auth == "app_password" { out.append(.appPassword) }
        if imap, detection?.imap != nil, auth == "password" { out.append(.password) }
        if provider == nil, options.forwarding { out.insert(.forwarding, at: out.isEmpty ? 0 : min(1, out.count)) }
        if imap { out.append(.imap) }
        return out
    }

    private var methods: some View {
        let all = available
        let shown = allMethods || all.count <= 3 ? all : Array(all.prefix(2)) + (form.method.map { all.prefix(2).contains($0) ? [] : [$0] } ?? [])
        return AccountSection(title: "How should mail reach opendesk?", footer: provider == "microsoft" && !all.contains(.microsoft) ? "Microsoft turned off password sign-in over IMAP, so without Microsoft sign-in this mailbox receives by forwarding." : nil) {
            if all == [.forwarding] {
                AccountRow(symbol: "arrowshape.turn.up.right", tone: .teal, title: "Mail arrives by forwarding", subtitle: "You forward \(form.email) to a private address opendesk gives you. Works with any provider, and opendesk never reads the mailbox.")
            } else {
                ForEach(Array(shown.enumerated()), id: \.element) { index, method in
                    if index > 0 { AccountDivider() }
                    AccountChoiceRow(symbol: method.symbol, tone: method.tone, title: method.title(host: hostLabel) + (method == all.first ? " (recommended)" : method == .imap ? " (advanced)" : ""), subtitle: method.body(host: hostLabel), chosen: form.method == method) {
                        form.method = method
                    }
                }
                if all.count > 3 {
                    AccountDivider()
                    Button(allMethods ? "Show the suggested ways" : "Choose another way") { allMethods.toggle() }
                        .font(ODFont.sans(14, weight: .medium))
                        .foregroundStyle(Theme.fg2)
                        .padding(14)
                }
            }
        }
    }

    private var hostLabel: String {
        guard let detection else { return "your provider" }
        let label = detection.label.isEmpty ? MailboxKinds.hostLabel(detection.host) : detection.label
        return label.isEmpty ? "your provider" : label
    }

    // MARK: Connect

    @ViewBuilder
    private func connect(_ method: MailboxMethod) -> some View {
        switch method {
        case .google, .microsoft, .googleAPI, .microsoftAPI:
            let name = method.provider == "google" ? "Google" : "Microsoft"
            ChannelForm(title: "Connect") {
                if method.direct {
                    Notice(text: "opendesk reads new mail in the inbox through \(name) and replies from your address. New emails become tickets on their own. No forwarding to set up.")
                }
                Notice(text: "Signing in with \(name) runs in the web app, which opens here. Approve access there; opendesk reads and sends mail for this address only, and you can disconnect at any time.")
                Button("Continue in the web app") { openWeb() }.buttonStyle(InkButtonStyle())
            }
        case .forwarding:
            forwarding
        case .appPassword, .password:
            ChannelForm(title: "Connect") {
                if method == .appPassword, let url = detection.flatMap({ URL(string: $0.appPasswordURL) }), !(detection?.appPasswordURL ?? "").isEmpty {
                    Link(destination: url) {
                        Label("Create an app password in \(hostLabel)", systemImage: "arrow.up.right.square").font(ODFont.sans(14, weight: .medium))
                    }
                }
                ODTextField(label: method == .appPassword ? "App password" : "Password", text: $form.password, prompt: method == .appPassword ? "Paste the app password" : "The mailbox's password", secure: true, contentType: .password)
                if MailboxKinds.isGoogle(detection?.host ?? ""), method == .appPassword, !form.password.isEmpty, form.password.filter({ !$0.isWhitespace }).count != 16 {
                    Notice(text: "Google's app passwords are 16 letters. Check you copied all of it.", tone: .amber, symbol: "exclamationmark.triangle")
                }
                serverSummary
                startWith
            }
        case .imap:
            ChannelForm(title: "Incoming mail (IMAP)") {
                ChannelServerFields(title: "Server", host: $form.imapHost, port: $form.imapPort, security: $form.imapTLS, hostPrompt: "imap.company.com", tlsPort: 993, starttlsPort: 143)
                ODTextField(label: "Username", text: $form.imapUser, prompt: form.email, keyboard: .emailAddress)
                ChannelHint("Usually your full email address.")
                ODTextField(label: "Password", text: $form.imapPassword, prompt: "", secure: true, contentType: .password)
                ChannelHint("An app password if your provider requires one.")
                startWith
            }
            ChannelForm(title: "Outgoing mail (SMTP)") {
                ChannelServerFields(title: "Server", host: $form.smtpHost, port: $form.smtpPort, security: $form.smtpTLS, hostPrompt: "smtp.company.com", tlsPort: 465, starttlsPort: 587)
                Toggle("Use the same username and password as IMAP", isOn: $form.sameCredentials).font(ODFont.sans(15)).tint(Tone.green.solid)
                if !form.sameCredentials { smtpCredentials }
            }
        }
    }

    private var serverSummary: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Server settings, set for you").font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
            Text("IMAP \(form.imapHost):\(form.imapPort) · \(form.imapTLS == "tls" ? "TLS" : "STARTTLS")").font(ODFont.mono(12.5)).foregroundStyle(Theme.fg2)
            Text("SMTP \(form.smtpHost):\(form.smtpPort) · \(form.smtpTLS == "tls" ? "TLS" : "STARTTLS")").font(ODFont.mono(12.5)).foregroundStyle(Theme.fg2)
            Button("Edit") { form.method = .imap }.font(ODFont.sans(13.5, weight: .medium)).foregroundStyle(Theme.fg)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
    }

    private var startWith: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Start with").font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
            AccountSegmented(options: ["recent", "new"], selection: $form.syncStart) { $0 == "recent" ? "The last 7 days" : "Only new email" }
            ChannelHint(form.syncStart == "recent"
                ? "Email from the last 7 days becomes tickets, up to 200, then new email as it arrives."
                : "Only email that arrives from now on becomes a ticket. Choose this when your history came over with an import.")
        }
    }

    private var forwarding: some View {
        ChannelForm(title: "How replies are sent") {
            Notice(text: "You get a private address to forward this mailbox's mail to. opendesk sees only the mail you forward.")
            VStack(spacing: 0) {
                ForEach(outboundChoices, id: \.self) { choice in
                    AccountChoiceRow(title: outboundTitle(choice), subtitle: outboundBody(choice), chosen: form.outbound == choice) { form.outbound = choice }
                }
            }
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
            if form.outbound == "provider" {
                let name = form.outboundProvider == "microsoft" ? "Microsoft" : "Google"
                Notice(text: "Connecting \(name) to send runs in the web app, which opens here. opendesk asks only for permission to send, then you set up forwarding.")
                Button("Continue in the web app") { openWeb() }.buttonStyle(InkButtonStyle())
            } else if form.outbound == "smtp" {
                smtpPresets
                ChannelServerFields(title: "SMTP server", host: $form.smtpHost, port: $form.smtpPort, security: $form.smtpTLS, hostPrompt: "smtp.company.com", tlsPort: 465, starttlsPort: 587)
                smtpCredentials
                if MailboxKinds.isMicrosoft(detection?.host ?? "") {
                    Notice(text: "Microsoft is phasing out password sign-in for SMTP AUTH in Exchange Online, and many admins already have it off. If the sign-in is refused, send with Microsoft or through a sending service instead.", tone: .amber, symbol: "exclamationmark.triangle")
                }
            }
        }
    }

    private var smtpCredentials: some View {
        VStack(alignment: .leading, spacing: 12) {
            ODTextField(label: "Username", text: $form.smtpUser, prompt: form.email, keyboard: .emailAddress)
            ODTextField(label: "Password", text: $form.smtpPassword, prompt: "", secure: true, contentType: .password)
            ChannelHint("An app password if your provider requires one.")
        }
    }

    private var smtpPresets: some View {
        VStack(alignment: .leading, spacing: 6) {
            Menu {
                ForEach(MailboxSMTPPreset.all, id: \.name) { preset in
                    Button(preset.name) {
                        form.smtpHost = preset.host
                        form.smtpPort = preset.port
                        form.smtpTLS = preset.port == 465 ? "tls" : "starttls"
                        if let user = preset.username { form.smtpUser = user }
                        form.preset = preset.name
                    }
                }
            } label: {
                Label("Using a sending service?", systemImage: "paperplane").font(ODFont.sans(14, weight: .medium)).foregroundStyle(Theme.fg)
            }
            if let hint = MailboxSMTPPreset.all.first(where: { $0.name == form.preset })?.hint { ChannelHint(hint) }
        }
    }

    private var outboundChoices: [String] {
        var out: [String] = []
        let options = store.options
        let host = detection?.host ?? ""
        let google = options.google.oauth && (provider == nil || MailboxKinds.isGoogle(host) || provider == "google")
        let microsoft = options.microsoft.oauth && (provider == nil || MailboxKinds.isMicrosoft(host) || provider == "microsoft")
        if google || microsoft { out.append("provider") }
        out.append("smtp")
        if options.systemSend { out.append("system") }
        return out
    }

    private func outboundTitle(_ choice: String) -> String {
        switch choice {
        case "provider": form.outboundProvider == "microsoft" ? "Connect Microsoft" : "Connect Google"
        case "system": "Through opendesk"
        default: "Your SMTP server"
        }
    }

    private func outboundBody(_ choice: String) -> String {
        switch choice {
        case "provider": "Replies go out from \(form.email) itself. This only lets opendesk send as the address. It does not read the mailbox."
        case "system": "From \(store.options.systemSender.isEmpty ? "opendesk" : store.options.systemSender) with your mailbox's name. Customers' answers come back to \(form.email)."
        default: "Replies go out from \(form.email) through your mail server, or a sending service such as Resend or Postmark."
        }
    }

    // MARK: Addressing

    private var addressing: some View {
        ChannelForm(title: "Team, brand and From name", footer: "Optional. You can change these later.") {
            ODTextField(label: "Sender name", text: $form.displayName, prompt: "Company Support")
            ChannelHint("Fills {mailbox} in the From name. Empty uses the name.")
            ChannelTeamMenu(label: "New tickets to this address go to", teamID: $form.teamID)
            if store.brands.count > 1 {
                ChannelMenuField(label: "Brand", value: store.brands.first { $0.id == form.brandID }?.name ?? store.brands.first(where: \.isDefault)?.name ?? "Default brand") {
                    ForEach(store.brands) { brand in Button(brand.name) { form.brandID = brand.id } }
                }
            }
            ChannelChipEditor(label: "Aliases", items: $form.aliases, placeholder: "help@company.com", empty: "No aliases") { text, _ in
                let clean = text.lowercased()
                guard ChannelValidate.email(clean) else { return .failure(ChannelChipProblem("That doesn't look like an email address.")) }
                guard clean != form.email.lowercased() else { return .failure(ChannelChipProblem("That's this mailbox's own address.")) }
                return .success(clean)
            }
        }
    }

    // MARK: Actions

    private func openWeb() {
        before = Set(store.mailboxes.map(\.id))
        web = "/settings/mailboxes/new" + (brandID.map { "?brand=\($0)" } ?? "")
    }

    /// Back from the web app's sign-in: open what it connected, if anything.
    private func returnedFromWeb() {
        Task {
            await store.load()
            if let added = store.mailboxes.first(where: { !before.contains($0.id) }) {
                env.toasts.show("Mailbox connected", kind: .success)
                replace(with: added.id)
            }
        }
    }

    private func replace(with id: String) {
        if let onDone { return onDone(id) }
        if !env.router.accountPath.isEmpty { env.router.accountPath.removeLast() }
        env.router.openSetting(.mailboxes, id: id)
    }

    private func submit() {
        guard form.valid, let method = form.method else { return }
        saving = true
        error = nil
        Task {
            do {
                let mailbox = try await store.create(form.body(method: method, host: detection?.host ?? ""))
                Haptics.success()
                env.toasts.show(mailbox.inboundKind == "forwarding" ? "\(mailbox.label) is ready. Forward its mail to the address on its page to start receiving." : "\(mailbox.label) is connected", kind: .success)
                replace(with: mailbox.id)
            } catch {
                Haptics.error()
                self.error = (error as? APIError)?.detail ?? error.userMessage
            }
            saving = false
        }
    }
}

enum MailboxMethod: String, Hashable {
    case googleAPI, microsoftAPI, google, microsoft, forwarding, appPassword, password, imap

    var oauth: Bool { [.googleAPI, .microsoftAPI, .google, .microsoft].contains(self) }
    var direct: Bool { self == .googleAPI || self == .microsoftAPI }
    var provider: String { self == .microsoftAPI || self == .microsoft ? "microsoft" : "google" }

    var symbol: String {
        switch self {
        case .googleAPI, .microsoftAPI: "tray.and.arrow.down"
        case .google, .microsoft: "arrow.triangle.2.circlepath"
        case .forwarding: "arrowshape.turn.up.right"
        case .appPassword, .password: "key"
        case .imap: "server.rack"
        }
    }

    var tone: Tone {
        switch self {
        case .googleAPI, .google: .blue
        case .microsoftAPI, .microsoft: .cyan
        case .forwarding: .teal
        case .appPassword, .password: .amber
        case .imap: .indigo
        }
    }

    func title(host: String) -> String {
        switch self {
        case .googleAPI, .microsoftAPI: "Read the inbox directly"
        case .google, .microsoft: "Receive by syncing the mailbox (IMAP)"
        case .forwarding: "Forward mail to opendesk"
        case .appPassword: "App password"
        case .password: "Email password"
        case .imap: "Other IMAP and SMTP"
        }
    }

    func body(host: String) -> String {
        let name = provider == "microsoft" ? "Microsoft" : "Google"
        switch self {
        case .googleAPI, .microsoftAPI: return "Sign in with \(name). New emails become tickets on their own. No forwarding to set up."
        case .google, .microsoft: return "Sign in with \(name). opendesk fetches new mail over IMAP and replies from your address."
        case .forwarding: return "Forward mail to an address opendesk gives you. Works with any provider, and opendesk never reads the mailbox."
        case .appPassword: return "Create an app password in \(host) and paste it here. The servers are set for you."
        case .password: return "Sign in with the mailbox's password. The servers are set for you."
        case .imap: return "Enter the server settings yourself."
        }
    }
}

struct MailboxSMTPPreset {
    var name: String
    var host: String
    var port: Int
    var username: String?
    var hint: String

    static let all = [
        MailboxSMTPPreset(name: "Resend", host: "smtp.resend.com", port: 465, username: "resend", hint: "The password is a Resend API key. Verify your domain in Resend first."),
        MailboxSMTPPreset(name: "Postmark", host: "smtp.postmarkapp.com", port: 587, hint: "The username and the password are both your Postmark server API token. Verify your domain in Postmark first."),
        MailboxSMTPPreset(name: "SendGrid", host: "smtp.sendgrid.net", port: 587, username: "apikey", hint: "The password is a SendGrid API key with Mail Send access. Verify your domain in SendGrid first."),
        MailboxSMTPPreset(name: "Mailgun", host: "smtp.mailgun.org", port: 587, hint: "Use the SMTP username and password from your domain in Mailgun. Domains in the EU region use smtp.eu.mailgun.org."),
        MailboxSMTPPreset(name: "Brevo", host: "smtp-relay.brevo.com", port: 587, hint: "Use the SMTP login and an SMTP key from Brevo's SMTP and API settings. Verify your domain in Brevo first."),
        MailboxSMTPPreset(name: "Amazon SES", host: "email-smtp.us-east-1.amazonaws.com", port: 587, hint: "Use SMTP credentials from the Amazon SES console, and put your region in the server name. Verify your domain in SES first."),
    ]
}

/// What the new mailbox form holds, and the body it sends.
struct MailboxNewForm: Equatable {
    var name = ""
    var email = ""
    var method: MailboxMethod?
    var password = ""
    var imapHost = ""
    var imapPort = 993
    var imapTLS = "tls"
    var imapUser = ""
    var imapPassword = ""
    var smtpHost = ""
    var smtpPort = 587
    var smtpTLS = "starttls"
    var smtpUser = ""
    var smtpPassword = ""
    var sameCredentials = true
    var syncStart = "recent"
    var outbound = "smtp"
    var outboundProvider = "google"
    var preset: String?
    var displayName = ""
    var teamID: String?
    var brandID: String?
    var aliases: [String] = []

    var domain: String { email.split(separator: "@").last.map(String.init) ?? email }

    mutating func apply(_ detection: MailboxDetection?) {
        let clean = email.trimmingCharacters(in: .whitespaces).lowercased()
        imapUser = clean
        smtpUser = clean
        if let imap = detection?.imap {
            imapHost = imap.host
            imapPort = imap.port
            imapTLS = imap.security == "starttls" ? "starttls" : "tls"
        } else {
            imapHost = "imap.\(domain)"
        }
        if let smtp = detection?.smtp {
            smtpHost = smtp.host
            smtpPort = smtp.port
            smtpTLS = smtp.security == "tls" ? "tls" : "starttls"
        } else {
            smtpHost = "smtp.\(domain)"
        }
        if let oauth = detection?.oauth { outboundProvider = oauth }
        outbound = "smtp"
    }

    var valid: Bool {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty, ChannelValidate.email(email), let method else { return false }
        switch method {
        case .appPassword, .password:
            return !password.isEmpty && ChannelServerFields.valid(host: imapHost, port: imapPort) && ChannelServerFields.valid(host: smtpHost, port: smtpPort)
        case .imap:
            let smtpOK = sameCredentials || (!smtpUser.isEmpty && !smtpPassword.isEmpty)
            return ChannelServerFields.valid(host: imapHost, port: imapPort) && !imapUser.isEmpty && !imapPassword.isEmpty
                && ChannelServerFields.valid(host: smtpHost, port: smtpPort) && smtpOK
        case .forwarding:
            if outbound == "smtp" { return ChannelServerFields.valid(host: smtpHost, port: smtpPort) && !smtpUser.isEmpty && !smtpPassword.isEmpty }
            return outbound == "system"
        default:
            return false
        }
    }

    func body(method: MailboxMethod, host: String) -> ChannelBody {
        let address = email.trimmingCharacters(in: .whitespaces).lowercased()
        var body: ChannelBody = [
            "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "email": .string(address),
            "team_id": .chString(teamID),
            "from_name_format": .string("{agent} at {mailbox}"),
        ]
        let sender = displayName.trimmingCharacters(in: .whitespaces)
        if !sender.isEmpty { body["display_name"] = .string(sender) }
        if let brandID { body["brand_id"] = .string(brandID) }
        if !aliases.isEmpty { body["aliases"] = .chStrings(aliases) }
        let mailHost: JSONValue = host.isEmpty ? .null : .string(host)
        switch method {
        case .forwarding:
            body["inbound_kind"] = .string("forwarding")
            if outbound == "system" {
                body["outbound_kind"] = .string("system")
                body["config"] = .object(["mail_host": mailHost])
            } else {
                body["outbound_kind"] = .string("smtp")
                body["config"] = .object([
                    "smtp_host": .string(smtpHost.trimmingCharacters(in: .whitespaces).lowercased()), "smtp_port": .chInt(smtpPort),
                    "smtp_tls": .string(smtpTLS), "smtp_username": .string(smtpUser), "mail_host": mailHost,
                ])
                body["smtp_password"] = .string(smtpPassword)
                body["verify"] = .bool(true)
            }
        case .appPassword, .password:
            let secret = method == .appPassword ? password.filter { !$0.isWhitespace } : password
            body["inbound_kind"] = .string("imap")
            body["outbound_kind"] = .string("smtp")
            body["config"] = .object([
                "imap_host": .string(imapHost), "imap_port": .chInt(imapPort), "imap_tls": .string(imapTLS), "imap_username": .string(address),
                "smtp_host": .string(smtpHost), "smtp_port": .chInt(smtpPort), "smtp_tls": .string(smtpTLS), "smtp_username": .string(address),
                "mail_host": mailHost, "sync_start": .string(syncStart),
            ])
            body["password"] = .string(secret)
            body["smtp_password"] = .string(secret)
            body["verify"] = .bool(true)
        case .imap:
            body["inbound_kind"] = .string("imap")
            body["outbound_kind"] = .string("smtp")
            body["config"] = .object([
                "imap_host": .string(imapHost.trimmingCharacters(in: .whitespaces).lowercased()), "imap_port": .chInt(imapPort), "imap_tls": .string(imapTLS),
                "imap_username": .string(imapUser), "smtp_host": .string(smtpHost.trimmingCharacters(in: .whitespaces).lowercased()), "smtp_port": .chInt(smtpPort),
                "smtp_tls": .string(smtpTLS), "smtp_username": .string(sameCredentials ? imapUser : smtpUser),
                "mail_host": mailHost, "sync_start": .string(syncStart),
            ])
            body["password"] = .string(imapPassword)
            body["smtp_password"] = .string(sameCredentials ? imapPassword : smtpPassword)
            body["verify"] = .bool(true)
        default:
            break
        }
        return body
    }
}
