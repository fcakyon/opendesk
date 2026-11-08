import SwiftUI

/// Inbox, Notifications and Account, under the app's own glass tab bar with
/// Ollie's round button beside it.
struct MainTabView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var tabBar = TabBarState()
    @State private var width: CGFloat = 0
    @State private var showPushPrimer = false
    @State private var showAccounts = false

    /// The first tab is the inbox, or the workspace's home while Tickets is off (Mail).
    private var home: (title: String, symbol: String) {
        let home = env.products.home
        return home == .tickets ? ("Inbox", "tray") : (home.title, home.symbol)
    }

    private var items: [TabItem] {
        [
            TabItem(tab: .inbox, title: home.title, symbol: home.symbol),
            TabItem(tab: .notifications, title: "Notifications", symbol: "bell", badge: env.notifications.unread),
            TabItem(tab: .account, title: "Account", symbol: "person.crop.circle"),
        ]
    }

    private var ollieAvailable: Bool { env.directory.ai.assistantOn }

    private var bar: some View {
        @Bindable var router = env.router
        return ODTabBar(
            items: items,
            selection: $router.tab,
            ollie: ollieAvailable ? { router.showOllie = true } : nil,
            onReselect: { tab in
                if tab == .inbox { router.inboxPath = [] }
                if tab == .notifications { router.notificationsPath = [] }
                if tab == .account { router.accountPath = [] }
            },
            onLongPress: [.account: { showAccounts = true }]
        )
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    var body: some View {
        @Bindable var router = env.router
        TabView(selection: $router.tab) {
            Tab(home.title, systemImage: home.symbol, value: AppTab.inbox) {
                InboxRootView().toolbarVisibility(.hidden, for: .tabBar)
            }
            Tab("Notifications", systemImage: "bell", value: AppTab.notifications) {
                NotificationsView().toolbarVisibility(.hidden, for: .tabBar)
            }
            Tab("Account", systemImage: "person.crop.circle", value: AppTab.account) {
                AccountView().toolbarVisibility(.hidden, for: .tabBar)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !tabBar.isHidden, !router.columns { bar }
        }
        // In columns the bar floats under the list alone (which keeps room for it,
        // `AdaptiveStack`), so the screen beside it runs to the bottom edge.
        .overlay(alignment: .bottomLeading) {
            if !tabBar.isHidden, router.columns { bar.frame(width: router.listWidth) }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onChange(of: AppColumns.on(width: width, sizeClass: sizeClass), initial: true) { _, on in router.wide = on }
        .onChange(of: width, initial: true) { _, width in router.listWidth = AppColumns.listWidth(for: width) }
        .motion(Motion.snappy, value: tabBar.isHidden)
        // A product turned off (here or on the web) never strands the Inbox tab on it.
        .onChange(of: env.products) { _, _ in router.keepAreaAvailable() }
        #if DEBUG
        .onChange(of: router.demoAction, initial: true) { _, action in DemoProducts.run(action, env: env) }
        #endif
        .environment(tabBar)
        .shortcutKeys()
        .sheet(isPresented: $router.showOllie) {
            AssistantView(context: router.assistantContext)
                .presentationDetents([.large])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(isPresented: $showAccounts) { AccountSwitcherSheet() }
        .sheet(isPresented: $showPushPrimer) {
            PushPrimerSheet()
                .presentationDetents([.height(380)])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .task {
            // A calm moment, after the inbox is up, to explain notifications once.
            try? await Task.sleep(for: .seconds(1.5))
            if env.push.shouldOfferPermission { showPushPrimer = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            tabBar.setKeyboard(true)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            tabBar.setKeyboard(false)
        }
    }
}

/// Why notifications help, before the system asks.
struct PushPrimerSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var asking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "bell.badge")
                .font(.system(size: 26))
                .foregroundStyle(Theme.fg)
                .frame(width: 52, height: 52)
                .background(Theme.sunken, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
            VStack(alignment: .leading, spacing: 8) {
                Text("Know when a customer needs you")
                    .font(ODFont.sans(21, weight: .semibold))
                    .tracking(-0.4)
                    .foregroundStyle(Theme.fg)
                Text("Get a notification when a ticket is assigned to you, someone mentions you, a customer replies, or an SLA is about to slip. You choose which ones in Account.")
                    .font(ODFont.callout)
                    .foregroundStyle(Theme.fg2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button {
                asking = true
                Task {
                    await env.push.requestPermission()
                    asking = false
                    dismiss()
                }
            } label: {
                ButtonLabel(title: "Turn on notifications", busy: asking)
            }
            .buttonStyle(InkButtonStyle())
            Button("Not now") {
                env.push.declinePermission()
                dismiss()
            }
            .buttonStyle(OutlineButtonStyle())
        }
        .padding(24)
        .background(Theme.surface)
    }
}
