import Observation
import SwiftUI

// Keyboard shortcuts with a hardware keyboard: the web app's registry ids and default keys
// (web/src/lib/shortcuts.ts) for the commands the app has, and the person's own keys for them
// (`/v1/me/shortcuts`, contracts/api.md "Keyboard shortcuts"), the same on every device.

/// One shortcut the app answers.
struct ShortcutCommand: Identifiable, Hashable, Sendable {
    enum Group: String, CaseIterable, Sendable {
        case anywhere, go, sidebar
        /// On a page of Pages or the wiki (`WikiPageShortcutKeys`).
        case page

        var title: String {
            switch self {
            case .anywhere: "Anywhere"
            case .go: "Go to"
            case .sidebar: "Sidebar"
            case .page: "On a page"
            }
        }
    }

    let id: String
    /// The default binding, as the web's registry has it.
    let keys: String
    let title: String
    let group: Group
}

enum ShortcutRegistry {
    static let commands: [ShortcutCommand] = [
        ShortcutCommand(id: "global.palette", keys: "mod+k", title: "Search", group: .anywhere),
        ShortcutCommand(id: "global.help", keys: "?", title: "Keyboard shortcuts", group: .anywhere),
        ShortcutCommand(id: "global.ollie", keys: "mod+j", title: "Ask Ollie", group: .anywhere),
        ShortcutCommand(id: "global.new", keys: "c", title: "New ticket", group: .anywhere),
        ShortcutCommand(id: "global.back", keys: "mod+[", title: "Back", group: .anywhere),
        ShortcutCommand(id: "tickets.search", keys: "/", title: "Search tickets", group: .anywhere),
        ShortcutCommand(id: "go.inbox", keys: "g i", title: "Inbox", group: .go),
        ShortcutCommand(id: "go.mine", keys: "g m", title: "My tickets", group: .go),
        ShortcutCommand(id: "go.team", keys: "g t", title: "My teams", group: .go),
        ShortcutCommand(id: "go.mail", keys: "g a", title: "Mail", group: .go),
        ShortcutCommand(id: "go.pages", keys: "g p", title: "Pages", group: .go),
        ShortcutCommand(id: "go.graph", keys: "g g", title: "Graph", group: .go),
        ShortcutCommand(id: "go.wiki", keys: "g w", title: "Wiki", group: .go),
        ShortcutCommand(id: "go.contacts", keys: "g c", title: "Contacts", group: .go),
        ShortcutCommand(id: "go.kb", keys: "g k", title: "Knowledge base", group: .go),
        ShortcutCommand(id: "go.reports", keys: "g r", title: "Reports", group: .go),
        ShortcutCommand(id: "go.settings", keys: "g s", title: "Settings", group: .go),
        ShortcutCommand(id: "go.shortcuts", keys: "g ?", title: "Shortcut settings", group: .go),
        ShortcutCommand(id: "sidebar.toggle", keys: "b", title: "Open the sidebar", group: .sidebar),
        ShortcutCommand(id: "sidebar.edit", keys: "g e", title: "Edit the sidebar", group: .sidebar),
        ShortcutCommand(id: "page.new", keys: "n", title: "New page", group: .page),
        ShortcutCommand(id: "page.newSubpage", keys: "shift+n", title: "New subpage", group: .page),
        ShortcutCommand(id: "page.parent", keys: "u", title: "Go to the parent page", group: .page),
        ShortcutCommand(id: "page.favorite", keys: "s", title: "Add to or remove from favorites", group: .page),
        ShortcutCommand(id: "page.move", keys: "m", title: "Move the page", group: .page),
        ShortcutCommand(id: "page.copyLink", keys: "l", title: "Copy the page's link", group: .page),
        ShortcutCommand(id: "page.panel", keys: "mod+shift+;", title: "About this page", group: .page),
        ShortcutCommand(id: "page.history", keys: "shift+h", title: "Page history", group: .page),
        ShortcutCommand(id: "page.publish", keys: "shift+p", title: "Publish to help center", group: .page),
        ShortcutCommand(id: "page.export", keys: "shift+e", title: "Export the page", group: .page),
        ShortcutCommand(id: "page.lock", keys: "shift+l", title: "Lock or unlock the page", group: .page),
        ShortcutCommand(id: "page.save", keys: "mod+s", title: "Save now", group: .page),
    ]

    static func command(_ id: String) -> ShortcutCommand? { commands.first { $0.id == id } }
}

/// One key press of a binding: its modifiers in the order mod, alt, shift, then a key.
struct KeyStep: Hashable, Sendable {
    var mods: [String]
    var key: String

    static let modOrder = ["mod", "alt", "shift"]
    static let namedKeys: Set<String> = [
        "enter", "escape", "space", "tab", "backspace", "delete", "arrowup", "arrowdown", "arrowleft", "arrowright",
        "home", "end", "pageup", "pagedown", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
    ]

    init(mods: [String], key: String) {
        self.mods = KeyStep.modOrder.filter { mods.contains($0) }
        self.key = key
    }

    /// `mod+shift+k`; nil for anything the contract's grammar refuses.
    init?(_ raw: String) {
        var rest = Substring(raw)
        var mods: [String] = []
        var last = -1
        while let index = KeyStep.modOrder.firstIndex(where: { rest.hasPrefix($0 + "+") && rest.count > $0.count + 1 }) {
            guard index > last else { return nil }
            last = index
            mods.append(KeyStep.modOrder[index])
            rest = rest.dropFirst(KeyStep.modOrder[index].count + 1)
        }
        let key = String(rest)
        guard key.count == 1 || KeyStep.namedKeys.contains(key) else { return nil }
        if key.count == 1, let scalar = key.unicodeScalars.first, scalar.value <= 32 || scalar.value == 0x7F { return nil }
        if mods.contains("shift"), key.count == 1, !"abcdefghijklmnopqrstuvwxyz0123456789;".contains(key) { return nil }
        self.mods = mods
        self.key = key
    }

    var raw: String { (mods + [key]).joined(separator: "+") }
    var hasMod: Bool { mods.first == "mod" }

    var modifiers: EventModifiers {
        var out: EventModifiers = []
        if mods.contains("mod") { out.insert(.command) }
        if mods.contains("alt") { out.insert(.option) }
        if mods.contains("shift") { out.insert(.shift) }
        return out
    }

    /// The key the system matches; nil for a key a hardware keyboard on iPhone has no name for.
    var equivalent: KeyEquivalent? {
        switch key {
        case "enter": .return
        case "escape": .escape
        case "space": .space
        case "tab": .tab
        case "backspace": .delete
        case "delete": .deleteForward
        case "arrowup": .upArrow
        case "arrowdown": .downArrow
        case "arrowleft": .leftArrow
        case "arrowright": .rightArrow
        case "home": .home
        case "end": .end
        case "pageup": .pageUp
        case "pagedown": .pageDown
        default: key.count == 1 ? KeyEquivalent(Character(key)) : nil
        }
    }

    /// The step as the keyboard labels it: ⌘⇧K, ⌥←, G.
    var label: String {
        let symbols = mods.map { mod in
            switch mod {
            case "mod": "⌘"
            case "alt": "⌥"
            default: "⇧"
            }
        }.joined()
        let name: String = switch key {
        case "enter": "↩"
        case "escape": "Esc"
        case "space": "Space"
        case "tab": "⇥"
        case "backspace": "⌫"
        case "delete": "⌦"
        case "arrowup": "↑"
        case "arrowdown": "↓"
        case "arrowleft": "←"
        case "arrowright": "→"
        case "home": "Home"
        case "end": "End"
        case "pageup": "Page up"
        case "pagedown": "Page down"
        default: key.uppercased()
        }
        return symbols + name
    }

    /// The step a key press makes, as the binding grammar spells it.
    init?(press: KeyPress) {
        var mods: [String] = []
        if press.modifiers.contains(.command) { mods.append("mod") }
        if press.modifiers.contains(.option) { mods.append("alt") }
        let key: String
        switch press.key {
        case .return: key = "enter"
        case .escape: key = "escape"
        case .space: key = "space"
        case .tab: key = "tab"
        case .delete: key = "backspace"
        case .deleteForward: key = "delete"
        case .upArrow: key = "arrowup"
        case .downArrow: key = "arrowdown"
        case .leftArrow: key = "arrowleft"
        case .rightArrow: key = "arrowright"
        case .home: key = "home"
        case .end: key = "end"
        case .pageUp: key = "pageup"
        case .pageDown: key = "pagedown"
        default:
            // A symbol carries its own shift ("?"); a letter, a digit or ";" names it.
            let character = String(press.key.character).lowercased()
            guard character.count == 1 else { return nil }
            key = character
        }
        if press.modifiers.contains(.shift), key.count > 1 || "abcdefghijklmnopqrstuvwxyz0123456789;".contains(key) { mods.append("shift") }
        self.init(KeyStep(mods: mods, key: key).raw)
    }
}

/// A binding: one or two steps split by a space; a step with mod ends it.
enum ShortcutBinding {
    static func steps(_ binding: String) -> [KeyStep]? {
        let parts = binding.split(separator: " ").map(String.init)
        guard (1 ... 2).contains(parts.count) else { return nil }
        let steps = parts.compactMap(KeyStep.init)
        guard steps.count == parts.count else { return nil }
        if steps.count == 2, steps[0].hasMod { return nil }
        return steps
    }

    /// "⌘K", "G then P".
    static func label(_ binding: String) -> String {
        guard let steps = steps(binding) else { return binding }
        return steps.map(\.label).joined(separator: " then ")
    }
}

/// The person's own keys (`GET/PUT /v1/me/shortcuts`): a shortcut left out keeps its default,
/// one set to null is off.
@MainActor
@Observable
final class ShortcutsStore {
    static let shared = ShortcutsStore()

    /// Shortcut id to the person's keys, nil for one they turned off.
    private(set) var bindings: [String: String?] = [:]
    private(set) var loaded = false
    /// New keys are being recorded: the shortcuts stand aside so the keys reach the recorder.
    var recording = false

    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var key: String?

    func start(env: AppEnvironment) {
        guard let user = env.session.user?.id else { return }
        let api = env.session.api
        let key = "\(ObjectIdentifier(api).hashValue)/\(user)"
        guard key != self.key else { return }
        self.key = key
        self.api = api
        bindings = [:]
        loaded = false
        Task { await load() }
    }

    func load() async {
        guard let api, let answer: JSONValue = try? await api.get("v1/me/shortcuts", workspace: .none) else { return }
        bindings = Self.read(answer)
        loaded = true
    }

    private static func read(_ answer: JSONValue) -> [String: String?] {
        var out: [String: String?] = [:]
        for (id, value) in answer["bindings"]?.object ?? [:] {
            out.updateValue(value.string, forKey: id)
        }
        return out
    }

    /// The keys that run `command` now; nil while it is off.
    func binding(_ command: ShortcutCommand) -> String? {
        if let own = bindings[command.id] { return own }
        return command.keys
    }

    func isChanged(_ command: ShortcutCommand) -> Bool { bindings[command.id] != nil }

    /// The other command already on `binding`, if any.
    func clash(_ binding: String, except id: String) -> ShortcutCommand? {
        ShortcutRegistry.commands.first { $0.id != id && self.binding($0) == binding }
    }

    func set(_ id: String, to binding: String?) async -> String? {
        var next = bindings
        next[id] = .some(binding)
        return await save(next)
    }

    func reset(_ id: String) async -> String? {
        var next = bindings
        next[id] = nil
        return await save(next)
    }

    func resetAll() async -> String? { await save([:]) }

    private func save(_ next: [String: String?]) async -> String? {
        guard let api else { return "Sign in again to change your shortcuts." }
        let previous = bindings
        bindings = next
        let body = JSONValue.object(["bindings": .object(next.mapValues { $0.map(JSONValue.string) ?? .null })])
        do {
            var request = APIRequest(method: "PUT", path: "v1/me/shortcuts", body: try APICoding.encoder.encode(body))
            request.workspace = .none
            let answer: JSONValue = try await api.send(request)
            bindings = Self.read(answer)
            return nil
        } catch {
            bindings = previous
            return (error as? APIError)?.userMessage ?? "Couldn't save your shortcuts."
        }
    }
}
