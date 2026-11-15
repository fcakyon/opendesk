import Foundation

/// A row of the member's own sidebar section (contracts/collab.md `SidebarItem`): a Space row of
/// this workspace, never a whole section or an Everywhere list.
struct SidebarItem: Codable, Hashable, Sendable, Identifiable {
    var kind: SpaceItemKind
    var itemID: String
    /// The member's own label for the row.
    var name: String?
    var badge: String?
    /// One emoji in place of the row's own icon.
    var icon: String?

    enum CodingKeys: String, CodingKey {
        case kind, name, badge, icon
        case itemID = "id"
    }

    init(kind: SpaceItemKind, itemID: String, name: String? = nil, badge: String? = nil, icon: String? = nil) {
        self.kind = kind
        self.itemID = itemID
        self.name = name
        self.badge = badge
        self.icon = icon
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(SpaceItemKind.self, forKey: .kind)
        itemID = try c.decode(String.self, forKey: .itemID)
        name = c.lenient(String.self, forKey: .name).flatMap { SpaceRules.clean($0).isEmpty ? nil : $0 }
        badge = c.lenient(String.self, forKey: .badge)
        icon = c.lenient(String.self, forKey: .icon).flatMap { $0.isEmpty ? nil : $0 }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encode(itemID, forKey: .itemID)
        let cleaned = name.map(SpaceRules.clean) ?? ""
        if !cleaned.isEmpty { try c.encode(String(cleaned.prefix(SpaceRules.rowName)), forKey: .name) }
        if let badge { try c.encode(badge, forKey: .badge) }
        if let icon, !icon.isEmpty { try c.encode(icon, forKey: .icon) }
    }

    /// The row's key, as `hidden`, `names` and `icons` spell it.
    var key: String { "\(kind.rawValue):\(itemID)" }
    var id: String { key }

    /// The same row as a Space shows it, in `workspace`.
    func spaceItem(in workspace: String) -> SpaceItem {
        SpaceItem(workspaceID: workspace, kind: kind, itemID: itemID, name: name, badge: badge, icon: icon)
    }
}

/// One of the member's own sidebar sections (`SidebarSection`), placed in `order` as `custom:<id>`.
struct SidebarSection: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String = ""
    var collapsed = false
    var icon: String?
    var items: [SidebarItem] = []

    enum CodingKeys: String, CodingKey { case id, title, collapsed, icon, items }

    init(id: String, title: String = "", collapsed: Bool = false, icon: String? = nil, items: [SidebarItem] = []) {
        self.id = id
        self.title = title
        self.collapsed = collapsed
        self.icon = icon
        self.items = items
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.lenient(String.self, forKey: .title) ?? ""
        collapsed = c.lenient(Bool.self, forKey: .collapsed) ?? false
        icon = c.lenient(String.self, forKey: .icon).flatMap { $0.isEmpty ? nil : $0 }
        items = (c.lenient([LenientItem].self, forKey: .items) ?? []).compactMap(\.item)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(String(SpaceRules.clean(title).prefix(SpaceRules.title)), forKey: .title)
        try c.encode(collapsed, forKey: .collapsed)
        if let icon, !icon.isEmpty { try c.encode(icon, forKey: .icon) }
        try c.encode(items, forKey: .items)
    }

    /// One malformed row never drops the section.
    private struct LenientItem: Decodable {
        var item: SidebarItem?
        init(from decoder: Decoder) throws { item = try? SidebarItem(from: decoder) }
    }

    var orderID: String { "custom:" + id }
}

/// A favorite under Favorites (`SidebarPrefs.pinned`).
struct SidebarPin: Codable, Hashable, Sendable {
    var kind: String
    var id: String

    var key: String { "\(kind):\(id)" }
}

/// How the member arranges this workspace's sidebar (`GET/PUT /v1/collab/sidebar`). Everything the
/// app reads is typed; the whole answer is kept too, so a save carries back what the app doesn't edit.
struct SidebarPrefs: Equatable, Sendable {
    var order: [String] = []
    var hidden: [String] = []
    var pinned: [SidebarPin] = []
    var sections: [SidebarSection] = []
    var rowOrder: [String: [String]] = [:]
    var names: [String: String] = [:]
    var icons: [String: String] = [:]
    var showWaitingChats = false
    private var raw: [String: JSONValue] = [:]

    /// The built-in sections in their default order.
    static let builtIn = ["favorites", "inbox", "mail", "teams", "views", "pages", "workspace"]

    init() {}

    init(json: JSONValue) {
        raw = json.object ?? [:]
        let fields = (try? json.decode(Fields.self)) ?? Fields()
        order = fields.order ?? []
        hidden = fields.hidden ?? []
        pinned = fields.pinned ?? []
        sections = fields.sections ?? []
        rowOrder = fields.rowOrder ?? [:]
        names = fields.names ?? [:]
        icons = fields.icons ?? [:]
        showWaitingChats = fields.showWaitingChats ?? false
    }

    /// The whole document to save: what was read, with the app's fields over it.
    var json: JSONValue {
        var out = raw
        out["order"] = .array(order.map(JSONValue.string))
        out["hidden"] = .array(hidden.map(JSONValue.string))
        out["pinned"] = .array(pinned.map { .object(["kind": .string($0.kind), "id": .string($0.id)]) })
        out["sections"] = (try? JSONValue.from(sections)) ?? .array([])
        out["row_order"] = .object(rowOrder.mapValues { .array($0.map(JSONValue.string)) })
        out["names"] = .object(names.mapValues(JSONValue.string))
        out["icons"] = .object(icons.mapValues(JSONValue.string))
        out["show_waiting_chats"] = .bool(showWaitingChats)
        // The fields the server needs whole, kept as they were or at their defaults.
        if out["expanded_accounts"] == nil { out["expanded_accounts"] = .array([]) }
        if out["mark_read_on_open"] == nil { out["mark_read_on_open"] = .bool(true) }
        if out["unified_inbox"] == nil { out["unified_inbox"] = .bool(true) }
        return .object(out)
    }

    static func == (lhs: SidebarPrefs, rhs: SidebarPrefs) -> Bool { lhs.json == rhs.json }

    private struct Fields: Decodable {
        var order: [String]?
        var hidden: [String]?
        var pinned: [SidebarPin]?
        var sections: [SidebarSection]?
        var rowOrder: [String: [String]]?
        var names: [String: String]?
        var icons: [String: String]?
        var showWaitingChats: Bool?

        init() {}

        enum CodingKeys: String, CodingKey {
            case order, hidden, pinned, sections, names, icons
            case rowOrder = "row_order"
            case showWaitingChats = "show_waiting_chats"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            order = c.lenient([String].self, forKey: .order)
            hidden = c.lenient([String].self, forKey: .hidden)
            pinned = c.lenient([SidebarPin].self, forKey: .pinned)
            sections = c.lenient([SidebarSection].self, forKey: .sections)
            rowOrder = c.lenient([String: [String]].self, forKey: .rowOrder)
            names = c.lenient([String: String].self, forKey: .names)
            icons = c.lenient([String: String].self, forKey: .icons)
            showWaitingChats = c.lenient(Bool.self, forKey: .showWaitingChats)
        }
    }

    // MARK: Reading

    func isHidden(_ key: String) -> Bool { hidden.contains(key) }

    /// The member's label for a section (`section:<id>`) or row key, else `fallback`.
    func name(_ key: String, _ fallback: String) -> String {
        guard let name = names[key], !SpaceRules.clean(name).isEmpty else { return fallback }
        return name
    }

    func icon(_ key: String) -> String? {
        guard let icon = icons[key], !icon.isEmpty else { return nil }
        return icon
    }

    func section(_ id: String) -> SidebarSection? { sections.first { $0.id == id } }

    /// The sections top to bottom: the saved order with built-ins it lacks where the default puts
    /// them, then own sections it lacks. Entries naming nothing are kept in `order` and skipped here.
    func resolvedOrder(isKnown: (String) -> Bool) -> [String] {
        var out: [String] = []
        for id in order where !out.contains(id) {
            if Self.builtIn.contains(id) || isKnown(id) {
                out.append(id)
            } else if id.hasPrefix("custom:"), section(String(id.dropFirst(7))) != nil {
                out.append(id)
            }
        }
        for (index, id) in Self.builtIn.enumerated() where !out.contains(id) {
            // After the nearest section before it in the default order.
            let before = Self.builtIn[..<index].reversed().first { out.contains($0) }
            if let before, let at = out.firstIndex(of: before) { out.insert(id, at: at + 1) } else { out.insert(id, at: 0) }
        }
        for section in sections where !out.contains(section.orderID) { out.append(section.orderID) }
        return out
    }

    /// `keys` in the member's order for built-in section `section`; keys it doesn't name follow.
    func ordered(_ keys: [String], in section: String) -> [String] {
        guard let saved = rowOrder[section], !saved.isEmpty else { return keys }
        let first = saved.filter { keys.contains($0) }
        return first + keys.filter { !first.contains($0) }
    }

    func isPinned(_ kind: String, _ id: String) -> Bool { pinned.contains { $0.kind == kind && $0.id == id } }

    // MARK: Changing

    mutating func setHidden(_ key: String, _ on: Bool) {
        hidden.removeAll { $0 == key }
        if on { hidden.append(key) }
    }

    mutating func setName(_ key: String, _ value: String?) {
        let cleaned = SpaceRules.clean(value ?? "")
        names[key] = cleaned.isEmpty ? nil : String(cleaned.prefix(SpaceRules.rowName))
    }

    mutating func setIcon(_ key: String, _ value: String?) {
        icons[key] = value.flatMap { $0.isEmpty ? nil : $0 }
    }

    mutating func setPinned(_ kind: String, _ id: String, _ on: Bool) {
        pinned.removeAll { $0.kind == kind && $0.id == id }
        if on { pinned.append(SidebarPin(kind: kind, id: id)) }
    }

    /// Writes the whole shown order, so a move keeps every section where it shows.
    mutating func setOrder(_ ids: [String]) {
        // Entries naming something gone stay saved, at the end.
        order = ids + order.filter { !ids.contains($0) }
    }

    mutating func update(section id: String, _ change: (inout SidebarSection) -> Void) {
        guard let index = sections.firstIndex(where: { $0.id == id }) else { return }
        change(&sections[index])
    }

    /// A row lives in one own section at most: adding it to one takes it out of the others.
    mutating func add(_ items: [SidebarItem], to sectionID: String) {
        let keys = Set(items.map(\.key))
        for index in sections.indices where sections[index].id != sectionID {
            sections[index].items.removeAll { keys.contains($0.key) }
        }
        update(section: sectionID) { section in
            let fresh = items.filter { item in !section.items.contains { $0.key == item.key } }
            section.items.append(contentsOf: fresh)
        }
    }

    /// Adds an own section titled `title`, placed last, and returns its id.
    @discardableResult
    mutating func newSection(title: String, items: [SidebarItem] = [], icon: String? = nil) -> String {
        let taken = Set(sections.map(\.id))
        let letters = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        var id = ""
        repeat {
            id = "s" + String((0 ..< 8).map { _ in letters.randomElement()! })
        } while taken.contains(id)
        sections.append(SidebarSection(id: id, title: String(SpaceRules.clean(title).prefix(SpaceRules.title)), icon: icon))
        if !order.isEmpty { order.append("custom:" + id) }
        add(items, to: id)
        return id
    }

    mutating func deleteSection(_ id: String) {
        sections.removeAll { $0.id == id }
        order.removeAll { $0 == "custom:" + id }
    }

    /// Order, hidden rows and sections and row order back to the defaults; own sections and
    /// favorites stay (the web's Reset).
    mutating func reset() {
        order = []
        hidden = []
        rowOrder = [:]
    }
}

/// The limits of contracts/collab.md "Your own sections", checked before a save.
enum SidebarRules {
    static let sections = 20
    static let sectionItems = 60
    static let items = 300
    static let pins = 30

    /// What the API would refuse, in words; nil when it can be saved.
    static func problem(in prefs: SidebarPrefs) -> String? {
        if prefs.sections.count > sections { return "Keep to \(sections) sections of your own." }
        var total = 0
        for section in prefs.sections {
            if SpaceRules.clean(section.title).count > SpaceRules.title { return "Keep section titles to \(SpaceRules.title) characters." }
            if section.items.count > sectionItems { return "A section holds at most \(sectionItems) rows." }
            total += section.items.count
        }
        if total > items { return "Your sections hold at most \(items) rows together." }
        if prefs.pinned.count > pins { return "Favorites hold at most \(pins) rows." }
        return nil
    }

    /// The first character of `text` when it is an emoji, the one an icon can be.
    static func emoji(_ text: String) -> String? {
        guard let first = text.trimmingCharacters(in: .whitespaces).first else { return nil }
        let isEmoji = first.unicodeScalars.contains { $0.properties.isEmojiPresentation || ($0.properties.isEmoji && $0.value > 0x238C) }
        return isEmoji ? String(first) : nil
    }

    /// A few to pick in one tap; any other comes from the emoji keyboard.
    static let suggestions = ["📥", "⭐️", "🔥", "✅", "📌", "📬", "💬", "📞", "🧾", "📚", "📝", "🗂️", "📊", "🚀", "🛟", "🐞", "💡", "🎯", "🕒", "👥", "🏷️", "🔔", "❤️", "🌱"]
}
