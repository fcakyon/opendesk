import SwiftUI

/// The Account tab: who you are and how you show up, the other accounts on this
/// device, your settings, the workspace's settings, and signing out.
struct AccountView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var store = AccountStore()

    var body: some View {
        @Bindable var router = env.router
        AdaptiveStack(path: $router.accountPath) {
            AccountHome()
        } destination: { route in
            AccountRouteDestination(route: route)
        } placeholder: {
            ColumnPlaceholder(symbol: "person.crop.circle", title: "Your account", message: "Pick a setting to open it here.")
        }
        .environment(store)
        .task {
            store.attach(session: env.session, directory: env.directory)
            store.workspaceChanged(env.session.workspace?.id)
        }
        .onChange(of: env.session.workspace?.id) { _, id in store.workspaceChanged(id) }
    }
}

/// The tab's root page.
private struct AccountHome: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(AccountStore.self) private var store
    @State private var web: AccountWebPage?
    @State private var confirm: AccountConfirm?
    @State private var deleting = false
    @State private var showAccounts = false
    @State private var editingSidebar = false

    private var session: SessionStore { env.session }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                TitleHeader(title: "Account")
                    .padding(.horizontal, -16)
                    .padding(.bottom, -10)
                VStack(spacing: 10) {
                    AccountProfileCard()
                    AccountSwitcherPanel()
                }
                personal
                workspace
                ForEach(SettingsGroup.allCases, id: \.self) { group in
                    settings(group)
                }
                help
                ending
                AccountFootnote()
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 120)
        }
        .background(Theme.chrome.ignoresSafeArea())
        .toolbarVisibility(.hidden, for: .navigationBar)
        .accountWebSheet($web)
        .accountConfirm($confirm)
        .sheet(isPresented: $deleting) {
            AccountDeleteSheet()
                .presentationDetents([.large])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(isPresented: $showAccounts) { AccountSwitcherSheet() }
        .sheet(isPresented: $editingSidebar) {
            SidebarEditorSheet()
                .presentationDetents([.large])
                .presentationCornerRadius(Theme.Radius.sheet)
                .interactiveDismissDisabled()
        }
        #if DEBUG
        .onAppear { handleDemo(env.router.demoAction) }
        .onChange(of: env.router.demoAction) { _, action in handleDemo(action) }
        #endif
    }

    // MARK: Sections

    private var personal: some View {
        AccountSection(title: "Your settings") {
            AccountLinkRow(route: .profile, subtitle: "Name, photo and what customers see")
            AccountDivider()
            AccountLinkRow(route: .notifications, subtitle: "What reaches your email, phone and desktop")
            AccountDivider()
            AccountLinkRow(route: .phone, value: phoneValue)
            AccountDivider()
            AccountLinkRow(route: .security, subtitle: securitySubtitle)
            AccountDivider()
            AccountLinkRow(route: .appearance, value: env.appearance.title)
            AccountDivider()
            AccountLinkRow(route: .shortcuts, subtitle: "With a keyboard connected")
            if SettingsPage.agentToAgent.isVisible(env: env) {
                AccountDivider()
                SettingsLinkRow(page: .agentToAgent, subtitle: "Let teammates' \(env.directory.ai.assistantName ?? "Ollie") ask yours")
            }
        }
    }

    private var workspace: some View {
        AccountSection(title: session.workspace.map { "In \($0.workspace.name)" }) {
            AccountLinkRow(route: .savedReplies, value: env.directory.savedReplies.isEmpty ? nil : "\(env.directory.savedReplies.count)")
            AccountDivider()
            AccountLinkRow(route: .views, value: env.directory.views.isEmpty ? nil : "\(env.directory.views.count)")
            AccountDivider()
            Button {
                editingSidebar = true
            } label: {
                AccountRow(symbol: "sidebar.left", tone: .teal, title: "Sidebar", subtitle: "Arrange, rename and hide its sections and rows") {
                    AccountDisclosure()
                }
            }
            .buttonStyle(RowPressStyle())
            AccountDivider()
            AccountLinkRow(route: .workspaces, value: session.memberships.count > 1 ? "\(session.memberships.count)" : nil, subtitle: "Switch or create a workspace")
        }
    }

    /// A group of the workspace's settings, as the web's settings sidebar lists them.
    @ViewBuilder
    private func settings(_ group: SettingsGroup) -> some View {
        let pages = SettingsPage.visible(in: group, env: env)
        if !pages.isEmpty {
            AccountSection(title: group.title) {
                ForEach(Array(pages.enumerated()), id: \.element) { index, page in
                    if index > 0 { AccountDivider() }
                    SettingsLinkRow(page: page)
                }
            }
        }
    }

    private var help: some View {
        AccountSection(title: "Help") {
            Button {
                web = URL(string: "https://docs.opendesk.sh/guides/iphone-app/").map(AccountWebPage.init)
            } label: {
                AccountRow(symbol: "book", tone: .violet, title: "Guide to the \(AppInfo.device) app") {
                    Image(systemName: "arrow.up.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.fg4)
                }
            }
            .buttonStyle(RowPressStyle())
            AccountDivider()
            Link(destination: URL(string: "mailto:team@opendesk.sh")!) {
                AccountRow(symbol: "envelope", tone: .blue, title: "Write to us", subtitle: "team@opendesk.sh") {
                    Image(systemName: "arrow.up.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.fg4)
                }
            }
            .buttonStyle(RowPressStyle())
            AccountDivider()
            AccountLinkRow(route: .about, value: "Version \(AppInfo.version)")
        }
    }

    private var ending: some View {
        VStack(spacing: 10) {
            if inAppDemo {
                Button {
                    Task { await env.session.signOutAll() }
                } label: {
                    ButtonLabel(title: "Leave the demo", symbol: "rectangle.portrait.and.arrow.right")
                }
                .buttonStyle(OutlineButtonStyle())
            } else {
                Button {
                    if let account = session.activeAccount {
                        confirm = .signOut(account, session: session)
                    } else {
                        confirm = AccountConfirm(
                            title: "Sign out of opendesk?",
                            message: "This \(AppInfo.device) stops getting notifications for \(session.user?.email ?? "this account") until you sign in again.",
                            confirmTitle: "Sign out"
                        ) {
                            await env.session.signOut()
                        }
                    }
                } label: {
                    ButtonLabel(title: "Sign out", symbol: "rectangle.portrait.and.arrow.right")
                }
                .buttonStyle(OutlineButtonStyle(tint: Tone.red.text))
            }
            Button("Delete account") { deleting = true }
                .font(ODFont.sans(14, weight: .medium))
                .foregroundStyle(Theme.fg3)
                .frame(height: 36)
        }
        .padding(.top, 4)
    }

    // MARK: Values

    /// A demo started from the sign-in screen, which signing out leaves.
    private var inAppDemo: Bool {
        #if DEBUG
        DemoMode.isOn && !DemoMode.launchedInDemo
        #else
        false
        #endif
    }

    private var phoneValue: String {
        if env.push.mode == .off { return "Off" }
        switch env.push.authorization {
        case .denied: return "Blocked"
        case .notDetermined: return "Not set up"
        default: return env.push.isEnabledOnDevice ? "On" : "Off"
        }
    }

    private var securitySubtitle: String {
        session.user?.totpEnabled == true ? "Password, two-factor on, sessions" : "Password, two-factor, sessions"
    }

    // MARK: Demo

    private func handleDemo(_ action: String?) {
        #if DEBUG
        guard let action else { return }
        switch action {
        case "delete-account":
            env.router.demoAction = nil
            deleting = true
        case "accounts":
            // A second demo person beside Maya, and the switcher the Account tab's long press opens.
            env.router.demoAction = nil
            env.router.tab = .account
            Task {
                await session.addDemoAccount()
                showAccounts = true
            }
        case "add-account":
            // The switcher panel on this page takes the action and opens the sign-in sheet.
            env.router.tab = .account
            env.router.accountPath = []
        case "sign-out":
            env.router.demoAction = nil
            confirm = AccountConfirm(title: "Sign out of opendesk?", message: "This \(AppInfo.device) stops getting notifications for \(session.user?.email ?? "this account") until you sign in again.", confirmTitle: "Sign out") {}
        default:
            // Actions of a page open that page; it handles them once it shows.
            if let route = AccountDemo.route(for: action), env.router.accountPath.last != route {
                env.router.tab = .account
                env.router.accountPath = [route]
            }
        }
        #endif
    }
}

/// Which page answers a `/demo/<action>`.
enum AccountDemo {
    static func route(for action: String) -> AccountRoute? {
        switch action {
        case "change-password", "2fa-setup", "2fa-codes", "2fa-off", "reauth", "passkey-rename", "sessions": .security
        case "new-reply", "edit-reply": .savedReplies
        case "new-view", "edit-view": .views
        case "avatar": .profile
        case "new-workspace": .workspaces
        case "pause", "digest": .notifications
        default: nil
        }
    }

    /// Clears `action` and answers whether it was `name`.
    @MainActor
    static func take(_ name: String, from router: Router) -> Bool {
        #if DEBUG
        guard router.demoAction == name else { return false }
        router.demoAction = nil
        return true
        #else
        return false
        #endif
    }
}

/// Version, build and server, small at the bottom.
private struct AccountFootnote: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        Text("opendesk \(AppInfo.version) (\(AppInfo.build)) · \(env.session.instance.displayHost)")
            .font(ODFont.mono(11))
            .foregroundStyle(Theme.fg4)
            .frame(maxWidth: .infinity)
            .padding(.top, -6)
    }
}
