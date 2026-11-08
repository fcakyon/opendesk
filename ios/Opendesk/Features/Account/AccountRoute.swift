import SwiftUI

/// A page pushed on the Account tab: your own settings, a workspace settings page, or
/// something a settings page lists (`/account/<path>` in the demo, see `stack(from:)`).
enum AccountRoute: Hashable {
    case profile, security, notifications, phone, savedReplies, views, workspaces, appearance, shortcuts, about
    case setting(SettingsPage)
    /// One thing a settings page lists, named to that page's `Detail` by `id`.
    case detail(SettingsPage, String)

    static let personal: [AccountRoute] = [.profile, .security, .notifications, .phone, .savedReplies, .views, .workspaces, .appearance, .shortcuts, .about]

    /// The demo's name for a personal page.
    var slug: String? {
        switch self {
        case .profile: "profile"
        case .security: "security"
        case .notifications: "notifications"
        case .phone: "phone"
        case .savedReplies: "saved-replies"
        case .views: "views"
        case .workspaces: "workspaces"
        case .appearance: "appearance"
        case .shortcuts: "shortcuts"
        case .about: "about"
        case .setting, .detail: nil
        }
    }

    /// The stack a demo path opens: `profile`, `settings/members`, `settings/teams/<id>`,
    /// `settings/ai/bots/<id>`. A settings page's path is its web path, so it may hold a "/".
    static func stack(from parts: [String]) -> [AccountRoute] {
        var stack: [AccountRoute] = []
        var rest = parts[...]
        while let part = rest.first {
            rest = rest.dropFirst()
            if part == "settings" {
                let joined = rest.joined(separator: "/")
                guard let page = SettingsPage.allCases
                    .filter({ joined == $0.rawValue || joined.hasPrefix($0.rawValue + "/") })
                    .max(by: { $0.rawValue.count < $1.rawValue.count })
                else { break }
                stack.append(.setting(page))
                let id = joined.dropFirst(page.rawValue.count).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                if !id.isEmpty { stack.append(.detail(page, id)) }
                break
            }
            if let route = personal.first(where: { $0.slug == part }) { stack.append(route) }
        }
        return stack
    }

    @MainActor var title: String {
        switch self {
        case .profile: "Profile"
        case .security: "Security"
        case .notifications: "Notifications"
        case .phone: "This \(AppInfo.device)"
        case .savedReplies: "Saved replies"
        case .views: "Views"
        case .workspaces: "Workspaces"
        case .appearance: "Appearance"
        case .shortcuts: "Keyboard shortcuts"
        case .about: "About"
        case .setting(let page), .detail(let page, _): page.title
        }
    }

    @MainActor var symbol: String {
        switch self {
        case .profile: "person.text.rectangle"
        case .security: "lock.shield"
        case .notifications: "bell.badge"
        case .phone: AppInfo.device == "iPad" ? "ipad" : "iphone"
        case .savedReplies: "text.bubble"
        case .views: "line.3.horizontal.decrease.circle"
        case .workspaces: "square.stack.3d.up"
        case .appearance: "circle.lefthalf.filled"
        case .shortcuts: "keyboard"
        case .about: "info.circle"
        case .setting(let page), .detail(let page, _): page.symbol
        }
    }

    var tone: Tone {
        switch self {
        case .profile: .indigo
        case .security: .green
        case .notifications: .rose
        case .phone: .gray
        case .savedReplies: .teal
        case .views: .blue
        case .workspaces: .orange
        case .appearance: .amber
        case .shortcuts: .violet
        case .about: .cyan
        case .setting(let page), .detail(let page, _): page.tone
        }
    }
}

/// Draws an Account page.
struct AccountRouteDestination: View {
    let route: AccountRoute

    var body: some View {
        switch route {
        case .profile: AccountProfileView()
        case .security: AccountSecurityView()
        case .notifications: AccountNotificationSettingsView()
        case .phone: AccountPhoneView()
        case .savedReplies: AccountSavedRepliesView()
        case .views: AccountViewsView()
        case .workspaces: AccountWorkspacesView()
        case .appearance: AccountAppearanceView()
        case .shortcuts: AccountShortcutsView()
        case .about: AccountAboutView()
        case .setting(let page): SettingsCatalog.page(page)
        case .detail(let page, let id): SettingsCatalog.detail(page, id: id)
        }
    }
}
