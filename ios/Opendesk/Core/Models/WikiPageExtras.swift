import CoreGraphics
import Foundation

// What a wiki page carries besides its title, icon and body (contracts/wiki.md "Page settings",
// "Aliases", "Links and tags", "Databases", "Canvas"), and the shapes of the page's panel:
// links, analytics and readers, publishing and Ollie writing. Keys are copied through explicit
// CodingKeys.

/// A page's look, other names, tags, a row's values and a canvas, read from the same object
/// as `WikiPage` (`WikiPage.extras`).
struct WikiPageExtras: Codable, Hashable, Sendable {
    /// "" (none), `gradient:<name>`, or an image: https or `/v1/attachments/<id>`.
    var cover = ""
    /// 0...100: which part of an image cover shows, top to bottom.
    var coverY = 50.0
    var fullWidth = false
    var smallText = false
    /// `default`, `serif` or `mono`.
    var font = "default"
    var aliases: [String] = []
    /// The `#tags` in its text, lower case.
    var tags: [String] = []
    /// A database row's values, by property id.
    var props: [String: JSONValue] = [:]
    var canvas: WikiCanvas?

    enum CodingKeys: String, CodingKey {
        case cover, font, aliases, tags, props, canvas
        case coverY = "cover_y"
        case fullWidth = "full_width"
        case smallText = "small_text"
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cover = c.lenient(String.self, forKey: .cover) ?? ""
        coverY = c.lenient(Double.self, forKey: .coverY) ?? 50
        fullWidth = c.lenient(Bool.self, forKey: .fullWidth) ?? false
        smallText = c.lenient(Bool.self, forKey: .smallText) ?? false
        font = c.lenient(String.self, forKey: .font) ?? "default"
        aliases = c.lenient([String].self, forKey: .aliases) ?? []
        tags = c.lenient([String].self, forKey: .tags) ?? []
        props = c.lenient([String: JSONValue].self, forKey: .props) ?? [:]
        canvas = c.lenient(WikiCanvas.self, forKey: .canvas)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(cover, forKey: .cover)
        try c.encode(coverY, forKey: .coverY)
        try c.encode(fullWidth, forKey: .fullWidth)
        try c.encode(smallText, forKey: .smallText)
        try c.encode(font, forKey: .font)
        try c.encode(aliases, forKey: .aliases)
        try c.encode(tags, forKey: .tags)
        if !props.isEmpty { try c.encode(props, forKey: .props) }
        try c.encodeIfPresent(canvas, forKey: .canvas)
    }
}

/// The app's cover gradients (web `components/wiki/covers.ts`), drawn as two colours.
enum WikiCover {
    static let gradients: [(name: String, from: UInt32, to: UInt32)] = [
        ("dawn", 0xFBC2EB, 0xA6C1EE), ("ocean", 0x2E3192, 0x1BFFFF), ("forest", 0x134E5E, 0x71B280),
        ("dusk", 0x2C3E50, 0xFD746C), ("sand", 0xE6DADA, 0x274046), ("slate", 0x485563, 0x29323C),
        ("rose", 0xF4C4F3, 0xFC67FA), ("lagoon", 0x43C6AC, 0x191654), ("aurora", 0x00C9FF, 0x92FE9D),
        ("ember", 0xF12711, 0xF5AF19),
    ]

    /// The gradient a `gradient:<name>` cover names.
    static func gradient(_ cover: String) -> (from: UInt32, to: UInt32)? {
        guard cover.hasPrefix("gradient:") else { return nil }
        let name = String(cover.dropFirst("gradient:".count))
        return gradients.first { $0.name == name }.map { ($0.from, $0.to) }
    }
}

/// Body of `PATCH /v1/wiki/pages/{id}` for what is not the page's text: its look, aliases,
/// verification and a row's values. None of it takes a version (contracts/wiki.md).
struct WikiLookPatch: Encodable, Sendable {
    var cover: String?
    var coverY: Double?
    var fullWidth: Bool?
    var smallText: Bool?
    var font: String?
    var locked: Bool?
    var aliases: [String]?
    var verified: Bool?
    var verifiedDays: Int?
    /// Merged into a row's values; `.null` takes one away.
    var props: [String: JSONValue]?

    enum CodingKeys: String, CodingKey {
        case cover, font, locked, aliases, verified, props
        case coverY = "cover_y"
        case fullWidth = "full_width"
        case smallText = "small_text"
        case verifiedDays = "verified_days"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(cover, forKey: .cover)
        try c.encodeIfPresent(coverY, forKey: .coverY)
        try c.encodeIfPresent(fullWidth, forKey: .fullWidth)
        try c.encodeIfPresent(smallText, forKey: .smallText)
        try c.encodeIfPresent(font, forKey: .font)
        try c.encodeIfPresent(locked, forKey: .locked)
        try c.encodeIfPresent(aliases, forKey: .aliases)
        try c.encodeIfPresent(verified, forKey: .verified)
        try c.encodeIfPresent(verifiedDays, forKey: .verifiedDays)
        try c.encodeIfPresent(props, forKey: .props)
    }
}

/// Body of `POST /v1/wiki/pages` for a database row (`parent_id` the database) with its values.
struct WikiRowCreate: Encodable, Sendable {
    var parentID: String
    var title: String
    var props: [String: JSONValue]

    enum CodingKeys: String, CodingKey {
        case title, props
        case parentID = "parent_id"
    }
}

// MARK: - Canvas

/// A canvas page's board (contracts/wiki.md "Canvas", JSON Canvas 1.0): cards in z order, later above.
struct WikiCanvas: Codable, Hashable, Sendable {
    var nodes: [WikiCanvasNode]
    var edges: [WikiCanvasEdge]

    enum CodingKeys: String, CodingKey { case nodes, edges }

    init(nodes: [WikiCanvasNode] = [], edges: [WikiCanvasEdge] = []) {
        self.nodes = nodes
        self.edges = edges
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        nodes = c.lenient([WikiCanvasNode].self, forKey: .nodes) ?? []
        edges = c.lenient([WikiCanvasEdge].self, forKey: .edges) ?? []
    }
}

struct WikiCanvasNode: Codable, Hashable, Sendable, Identifiable {
    var id: String
    /// `text`, `page`, `link`, `file` or `group`.
    var type: String
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    /// "1"..."6" (red, orange, yellow, green, cyan, purple) or "#rrggbb".
    var color: String?
    var html: String?
    var pageID: String?
    var url: String?
    var title: String?
    var description: String?
    var src: String?
    var name: String?
    var label: String?

    enum CodingKeys: String, CodingKey {
        case id, type, x, y, width, height, color, html, url, title, description, src, name, label
        case pageID = "page_id"
    }

    init(id: String, type: String, x: Double, y: Double, width: Double, height: Double, color: String? = nil, html: String? = nil,
         pageID: String? = nil, url: String? = nil, title: String? = nil, label: String? = nil) {
        self.id = id
        self.type = type
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.color = color
        self.html = html
        self.pageID = pageID
        self.url = url
        self.title = title
        self.label = label
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = c.lenient(String.self, forKey: .type) ?? "text"
        x = c.lenient(Double.self, forKey: .x) ?? 0
        y = c.lenient(Double.self, forKey: .y) ?? 0
        width = max(20, c.lenient(Double.self, forKey: .width) ?? 240)
        height = max(20, c.lenient(Double.self, forKey: .height) ?? 120)
        color = c.lenient(String.self, forKey: .color)
        html = c.lenient(String.self, forKey: .html)
        pageID = c.lenient(String.self, forKey: .pageID)
        url = c.lenient(String.self, forKey: .url)
        title = c.lenient(String.self, forKey: .title)
        description = c.lenient(String.self, forKey: .description)
        src = c.lenient(String.self, forKey: .src)
        name = c.lenient(String.self, forKey: .name)
        label = c.lenient(String.self, forKey: .label)
    }

    var frame: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

struct WikiCanvasEdge: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var fromNode: String
    var toNode: String
    var fromSide: String?
    var toSide: String?
    /// `none` (the default) or `arrow`.
    var fromEnd: String?
    /// `arrow` (the default) or `none`.
    var toEnd: String?
    var color: String?
    var label: String?

    enum CodingKeys: String, CodingKey { case id, fromNode, toNode, fromSide, toSide, fromEnd, toEnd, color, label }

    init(id: String, fromNode: String, toNode: String, label: String? = nil) {
        self.id = id
        self.fromNode = fromNode
        self.toNode = toNode
        self.label = label
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        fromNode = c.lenient(String.self, forKey: .fromNode) ?? ""
        toNode = c.lenient(String.self, forKey: .toNode) ?? ""
        fromSide = c.lenient(String.self, forKey: .fromSide)
        toSide = c.lenient(String.self, forKey: .toSide)
        fromEnd = c.lenient(String.self, forKey: .fromEnd)
        toEnd = c.lenient(String.self, forKey: .toEnd)
        color = c.lenient(String.self, forKey: .color)
        label = c.lenient(String.self, forKey: .label)
    }
}

// MARK: - Links, analytics, readers

/// One link of the workspace's graph (`GET /v1/wiki/graph`).
struct WikiGraphLink: Codable, Hashable, Sendable {
    var from: String
    var to: String
}

/// How a page was read (`GET /v1/wiki/pages/{id}/analytics`): counts only, per day, today last.
struct WikiPageAnalytics: Decodable, Sendable {
    struct Day: Decodable, Hashable, Sendable, Identifiable {
        var date: String
        var views: Int
        var viewers: Int
        var id: String { date }

        enum CodingKeys: String, CodingKey { case date, views, viewers }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            date = c.lenient(String.self, forKey: .date) ?? ""
            views = c.lenient(Int.self, forKey: .views) ?? 0
            viewers = c.lenient(Int.self, forKey: .viewers) ?? 0
        }
    }

    var days: [Day]
    var totalViews: Int
    var totalViewers: Int

    enum CodingKeys: String, CodingKey {
        case days
        case totalViews = "total_views"
        case totalViewers = "total_viewers"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        days = c.lenient([Day].self, forKey: .days) ?? []
        totalViews = c.lenient(Int.self, forKey: .totalViews) ?? 0
        totalViewers = c.lenient(Int.self, forKey: .totalViewers) ?? 0
    }
}

/// Who read a page lately (`GET /v1/wiki/pages/{id}/views`), the latest 20.
struct WikiPageReaders: Decodable, Sendable {
    struct Reader: Decodable, Hashable, Sendable, Identifiable {
        var user: UserRef
        var visits: Int
        var lastAt: Date
        var id: String { user.id }

        enum CodingKeys: String, CodingKey {
            case user, visits
            case lastAt = "last_at"
        }
    }

    var views: Int
    var people: Int
    var readers: [Reader]

    enum CodingKeys: String, CodingKey { case views, people, readers }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        views = c.lenient(Int.self, forKey: .views) ?? 0
        people = c.lenient(Int.self, forKey: .people) ?? 0
        readers = c.lenient([Reader].self, forKey: .readers) ?? []
    }
}

// MARK: - Publishing and Ollie

/// Body of `POST /v1/kb/articles/from-wiki`.
struct WikiPublish: Encodable, Sendable {
    var pageID: String
    var title: String?
    var collectionID: String?
    var brandID: String?

    enum CodingKeys: String, CodingKey {
        case title
        case pageID = "page_id"
        case collectionID = "collection_id"
        case brandID = "brand_id"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(pageID, forKey: .pageID)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(collectionID, forKey: .collectionID)
        try c.encodeIfPresent(brandID, forKey: .brandID)
    }
}

/// The draft article a page became, and how many parts of it stayed in the wiki.
struct WikiPublished: Decodable, Sendable {
    var article: KBArticle
    var leftOut: Int

    enum CodingKeys: String, CodingKey {
        case article
        case leftOut = "left_out"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        article = try c.decode(KBArticle.self, forKey: .article)
        leftOut = c.lenient(Int.self, forKey: .leftOut) ?? 0
    }
}

/// A brand a page can be published for (`GET /v1/brands`, the name only).
struct WikiPublishBrand: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var isDefault: Bool

    enum CodingKeys: String, CodingKey {
        case id, name
        case isDefault = "is_default"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, forKey: .name) ?? ""
        isDefault = c.lenient(Bool.self, forKey: .isDefault) ?? false
    }
}

/// What Ollie does with a page (`POST /v1/wiki/ai/write`, contracts/ai.md).
enum WikiWriteMode: String, CaseIterable, Identifiable, Sendable {
    case improve
    case fixGrammar = "fix_grammar"
    case shorter, longer, simplify
    case moreFormal = "more_formal"
    case friendlier, summarize
    case actionItems = "action_items"
    case explain
    case keepWriting = "continue"
    case custom

    var id: String { rawValue }

    var title: String {
        switch self {
        case .improve: "Improve writing"
        case .fixGrammar: "Fix spelling and grammar"
        case .shorter: "Make shorter"
        case .longer: "Make longer"
        case .simplify: "Simplify"
        case .moreFormal: "More formal"
        case .friendlier: "Friendlier"
        case .summarize: "Summarize"
        case .actionItems: "Find action items"
        case .explain: "Explain"
        case .keepWriting: "Continue writing"
        case .custom: "Ask Ollie"
        }
    }

    var symbol: String {
        switch self {
        case .improve: "wand.and.stars"
        case .fixGrammar: "checkmark.circle"
        case .shorter: "text.badge.minus"
        case .longer: "text.badge.plus"
        case .simplify: "textformat.size.smaller"
        case .moreFormal: "briefcase"
        case .friendlier: "face.smiling"
        case .summarize: "text.alignleft"
        case .actionItems: "checklist"
        case .explain: "questionmark.bubble"
        case .keepWriting: "arrow.forward.to.line"
        case .custom: "sparkles"
        }
    }

    /// Whether the answer takes the text's place; else it goes below it.
    var replaces: Bool {
        switch self {
        case .summarize, .actionItems, .explain, .keepWriting, .custom: false
        default: true
        }
    }
}

/// Body of `POST /v1/wiki/ai/write`.
struct WikiWriteRequest: Encodable, Sendable {
    var mode: String
    var html: String?
    var contextHTML: String?
    var title: String?
    var instructions: String?

    enum CodingKeys: String, CodingKey {
        case mode, html, title, instructions
        case contextHTML = "context_html"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(mode, forKey: .mode)
        try c.encodeIfPresent(html, forKey: .html)
        try c.encodeIfPresent(contextHTML, forKey: .contextHTML)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(instructions, forKey: .instructions)
    }
}
