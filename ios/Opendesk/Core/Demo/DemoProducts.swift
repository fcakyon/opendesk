#if DEBUG
import Foundation

/// Turns the open demo workspace's products on and off, so the app's Tickets off, Mail off and
/// Pages off screens run their real code: `/demo/tickets-off`, `/demo/tickets-on`, `/demo/mail-off`,
/// `/demo/mail-on`, `/demo/pages-off`, `/demo/pages-on`.
@MainActor
enum DemoProducts {
    static func run(_ action: String?, env: AppEnvironment) {
        guard DemoMode.isOn, let action, let workspace = env.session.workspace?.id else { return }
        let change: (tickets: Bool?, mail: Bool?, pages: Bool?)
        switch action {
        case "tickets-off": change = (false, nil, nil)
        case "tickets-on": change = (true, nil, nil)
        case "mail-off": change = (nil, false, nil)
        case "mail-on": change = (nil, true, nil)
        case "pages-off": change = (nil, nil, false)
        case "pages-on": change = (nil, nil, true)
        default: return
        }
        env.router.demoAction = nil
        Task {
            await DemoBackend.shared.setProducts(workspace: workspace, tickets: change.tickets, mail: change.mail, pages: change.pages)
            await env.session.membershipChanged()
        }
    }
}

extension DemoBackend {
    /// What `PATCH /v1/workspace {settings: {tickets_enabled, mail_enabled, pages_enabled}}` would leave.
    func setProducts(workspace: String, tickets: Bool?, mail: Bool?, pages: Bool? = nil) {
        guard let index = world.workspaces.firstIndex(where: { $0.id == workspace }) else { return }
        if let tickets {
            var settings = world.workspaces[index].workspace.settings ?? WorkspaceSettings()
            settings.ticketsEnabled = tickets
            world.workspaces[index].workspace.settings = settings
        }
        if let pages {
            var settings = world.workspaces[index].workspace.settings ?? WorkspaceSettings()
            settings.pagesEnabled = pages
            world.workspaces[index].workspace.settings = settings
        }
        if let mail {
            world.workspaces[index].workspace.mailAvailable = mail
            world.workspaces[index].mail.enabled = mail && workspace == DemoSeed.marginID
        }
    }
}
#endif
