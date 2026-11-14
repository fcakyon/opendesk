import Foundation
import Observation

/// The member's arrangement of the open workspace's sidebar (contracts/collab.md `SidebarPrefs`):
/// read with the workspace, saved whole, and read again when `collab.sidebar` says another tab
/// or device saved it.
/// A save the server refused, in its words.
struct SidebarSaveError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

@MainActor
@Observable
final class SidebarStore {
    static let shared = SidebarStore()

    private(set) var prefs = SidebarPrefs()
    private(set) var loaded = false
    private(set) var saving = false

    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var key: String?
    @ObservationIgnored private var listener: UUID?
    @ObservationIgnored private weak var env: AppEnvironment?

    /// Starts for the open workspace; a second call for the same one keeps what is loaded.
    func start(env: AppEnvironment) {
        guard let user = env.session.user?.id, let workspace = env.session.workspace?.id else { return }
        let api = env.session.api
        let key = "\(ObjectIdentifier(api).hashValue)/\(user)/\(workspace)"
        guard key != self.key else { return }
        self.env?.realtime.unsubscribe(listener)
        self.key = key
        self.api = api
        self.env = env
        prefs = SidebarPrefs()
        loaded = false
        listener = env.realtime.subscribe { [weak self] update in self?.handle(update) }
        Task { await load() }
    }

    func load() async {
        guard let api else { return }
        let asked = key
        // Until it is read, nothing saves: a save sends the whole arrangement.
        guard let answer: JSONValue = try? await api.get("v1/collab/sidebar") else { return }
        guard asked == key, !saving else { return }
        prefs = SidebarPrefs(json: answer)
        loaded = true
    }

    private func handle(_ update: RealtimeUpdate) {
        switch update {
        case .resync:
            Task { await load() }
        case let .envelope(envelope):
            if envelope.type == "collab.sidebar", !saving { Task { await load() } }
        }
    }

    /// Saves `next` whole: shown at once, put back with the server's words if it refuses.
    @discardableResult
    func save(_ next: SidebarPrefs) async -> String? {
        guard let api else { return "Sign in again to save your sidebar." }
        guard loaded else { return "Your sidebar is still loading. Try again in a moment." }
        if let problem = SidebarRules.problem(in: next) { return problem }
        let previous = prefs
        prefs = next
        saving = true
        defer { saving = false }
        do {
            let request = APIRequest(method: "PUT", path: "v1/collab/sidebar", body: try APICoding.encoder.encode(next.json))
            let answer: JSONValue = try await api.send(request)
            prefs = SidebarPrefs(json: answer)
            return nil
        } catch {
            prefs = previous
            return (error as? APIError)?.userMessage ?? "Couldn't save your sidebar."
        }
    }

    // MARK: Ticket inboxes as sections

    /// The ticket inboxes shown as sections of their own, in their order (`mailbox:<id>` in `order`).
    var inboxSections: [String] {
        var out: [String] = []
        for entry in prefs.order where entry.hasPrefix("mailbox:") {
            let id = String(entry.dropFirst(8))
            if !id.isEmpty, !out.contains(id) { out.append(id) }
        }
        return out
    }

    /// The member's name for a ticket inbox's section, else the inbox's own.
    func inboxTitle(_ mailbox: InboxMailbox) -> String {
        prefs.name("section:mailbox:" + mailbox.id, mailbox.name.isEmpty ? mailbox.email : mailbox.name)
    }

    /// Shows a ticket inbox as a section of its own, after the last one or after Tickets, or puts
    /// it back into Tickets (the web's `setInboxSection`).
    func setInboxSection(_ id: String, _ on: Bool) async throws {
        if !loaded { await load() }
        let entry = "mailbox:" + id
        var next = prefs
        var shown = prefs.resolvedOrder { $0.hasPrefix("mailbox:") || $0.hasPrefix("team:") }
        if on {
            guard !shown.contains(entry) else { return }
            let anchor = shown.lastIndex { $0.hasPrefix("mailbox:") } ?? shown.firstIndex(of: "inbox")
            if let anchor { shown.insert(entry, at: anchor + 1) } else { shown.append(entry) }
            next.setOrder(shown)
        } else {
            guard next.order.contains(entry) else { return }
            next.order.removeAll { $0 == entry }
        }
        if let failure = await save(next) { throw SidebarSaveError(message: failure) }
    }

    /// Changes the saved arrangement in place, telling the member when the save fails.
    func change(_ edit: (inout SidebarPrefs) -> Void) {
        guard loaded else {
            env?.toasts.show("Your sidebar is still loading. Try again in a moment.")
            Task { await load() }
            return
        }
        var next = prefs
        edit(&next)
        guard next != prefs else { return }
        Task {
            if let failure = await save(next) { env?.toasts.show(failure) }
        }
    }
}
