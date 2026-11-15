import Foundation

// The team's internal wiki (contracts/wiki.md): `WikiNode`, `WikiRef`, `WikiPage`,
// `WikiRevision`, `WikiSearchHit`, the trash, database rows and comments. Keys are
// copied through explicit CodingKeys.

/// Which tree a page is in (contracts/pages.md "Areas"): the wiki's, or Pages', the
/// workspace's own pages beside it. A page from before Pages, or one that says none, is the wiki's.
enum WikiArea: String, Codable, Hashable, Sendable, CaseIterable {
    case wiki, pages

    /// The area's name in the app.
    var title: String { self == .pages ? "Pages" : "Wiki" }

    /// Its web route's first segment: `/wiki/<id>` or `/pages/<id>`.
    var path: String { "/\(rawValue)" }

    /// The area menu's entry for it.
    var appArea: AppArea { self == .pages ? .pages : .wiki }
}

/// A page in the tree, without its body.
struct WikiNode: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var parentID: String?
    var title: String
    var icon: String
    var position: Int
    var version: Int
    var updatedAt: Date
    var createdByID: String?
    /// One member's own page (contracts/wiki.md "Private pages and teamspaces").
    var isPrivate: Bool
    /// The teamspace it is in.
    var teamID: String?
    /// A template, never in the tree.
    var template: Bool
    /// The member's journal: their daily notes are under it.
    var journal: Bool
    var dailyDate: String?
    /// Verified, and not past the day it was verified until.
    var verified: Bool
    /// `page`, `database` (its subpages are its rows) or `canvas`.
    var kind: String
    /// The tree it is in; its subpages are in the same one.
    var area: WikiArea

    enum CodingKeys: String, CodingKey {
        case id, title, icon, position, version, template, journal, verified, kind, area
        case parentID = "parent_id"
        case updatedAt = "updated_at"
        case createdByID = "created_by_id"
        case isPrivate = "private"
        case teamID = "team_id"
        case dailyDate = "daily_date"
    }

    init(id: String, parentID: String?, title: String, icon: String, position: Int, version: Int, updatedAt: Date, createdByID: String?,
         isPrivate: Bool = false, teamID: String? = nil, template: Bool = false, journal: Bool = false, dailyDate: String? = nil, verified: Bool = false, kind: String = "page", area: WikiArea = .wiki) {
        self.id = id
        self.parentID = parentID
        self.title = title
        self.icon = icon
        self.position = position
        self.version = version
        self.updatedAt = updatedAt
        self.createdByID = createdByID
        self.isPrivate = isPrivate
        self.teamID = teamID
        self.template = template
        self.journal = journal
        self.dailyDate = dailyDate
        self.verified = verified
        self.kind = kind
        self.area = area
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        parentID = c.lenient(String.self, forKey: .parentID)
        title = c.lenient(String.self, forKey: .title) ?? ""
        icon = c.lenient(String.self, forKey: .icon) ?? ""
        area = c.lenient(WikiArea.self, forKey: .area) ?? .wiki
        position = c.lenient(Int.self, forKey: .position) ?? 0
        version = c.lenient(Int.self, forKey: .version) ?? 1
        updatedAt = c.lenient(Date.self, forKey: .updatedAt) ?? .now
        createdByID = c.lenient(String.self, forKey: .createdByID)
        isPrivate = c.lenient(Bool.self, forKey: .isPrivate) ?? false
        teamID = c.lenient(String.self, forKey: .teamID)
        template = c.lenient(Bool.self, forKey: .template) ?? false
        journal = c.lenient(Bool.self, forKey: .journal) ?? false
        dailyDate = c.lenient(String.self, forKey: .dailyDate)
        verified = c.lenient(Bool.self, forKey: .verified) ?? false
        kind = c.lenient(String.self, forKey: .kind) ?? "page"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(parentID, forKey: .parentID)
        try c.encode(title, forKey: .title)
        try c.encode(icon, forKey: .icon)
        try c.encode(position, forKey: .position)
        try c.encode(version, forKey: .version)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encode(createdByID, forKey: .createdByID)
        try c.encode(isPrivate, forKey: .isPrivate)
        try c.encode(teamID, forKey: .teamID)
        try c.encode(template, forKey: .template)
        try c.encode(journal, forKey: .journal)
        try c.encodeIfPresent(dailyDate, forKey: .dailyDate)
        try c.encode(verified, forKey: .verified)
        try c.encode(kind, forKey: .kind)
        try c.encode(area, forKey: .area)
    }

    var displayTitle: String { WikiText.title(title) }
    var isDatabase: Bool { kind == "database" }
    var isCanvas: Bool { kind == "canvas" }
}

struct WikiRef: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String
    var icon: String

    enum CodingKeys: String, CodingKey { case id, title, icon }

    init(id: String, title: String, icon: String) {
        self.id = id
        self.title = title
        self.icon = icon
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.lenient(String.self, forKey: .title) ?? ""
        icon = c.lenient(String.self, forKey: .icon) ?? ""
    }

    var displayTitle: String { WikiText.title(title) }
}

/// One page with its body, breadcrumbs and subpages.
struct WikiPage: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var parentID: String?
    var title: String
    var icon: String
    var bodyHTML: String
    var position: Int
    var version: Int
    var createdBy: UserRef?
    var updatedBy: UserRef?
    var createdAt: Date
    var updatedAt: Date
    var breadcrumbs: [WikiRef]
    var children: [WikiRef]
    var isPrivate = false
    var teamID: String?
    var template = false
    var journal = false
    var dailyDate: String?
    /// `page`, or `database` (its subpages are its rows).
    var kind = "page"
    /// The app keeps the page read-only until someone unlocks it (contracts/wiki.md "Page settings").
    var locked = false
    var verification: WikiVerification?
    /// In the trash since; nil for a page in the tree.
    var deletedAt: Date?
    var deletedBy: UserRef?
    /// A database's properties; nil for a page.
    var database: WikiDatabase?
    var area: WikiArea = .wiki
    /// Its look, aliases, tags, a row's values and a canvas (`WikiPageExtras`).
    var extras = WikiPageExtras()

    enum CodingKeys: String, CodingKey {
        case id, title, icon, position, version, breadcrumbs, children, template, journal, kind, locked, verification, database, area
        case parentID = "parent_id"
        case bodyHTML = "body_html"
        case createdBy = "created_by"
        case updatedBy = "updated_by"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case isPrivate = "private"
        case teamID = "team_id"
        case dailyDate = "daily_date"
        case deletedAt = "deleted_at"
        case deletedBy = "deleted_by"
    }

    init(id: String, parentID: String?, title: String, icon: String, bodyHTML: String, position: Int, version: Int, createdBy: UserRef?, updatedBy: UserRef?, createdAt: Date, updatedAt: Date, breadcrumbs: [WikiRef], children: [WikiRef]) {
        self.id = id
        self.parentID = parentID
        self.title = title
        self.icon = icon
        self.bodyHTML = bodyHTML
        self.position = position
        self.version = version
        self.createdBy = createdBy
        self.updatedBy = updatedBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.breadcrumbs = breadcrumbs
        self.children = children
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        parentID = c.lenient(String.self, forKey: .parentID)
        title = c.lenient(String.self, forKey: .title) ?? ""
        icon = c.lenient(String.self, forKey: .icon) ?? ""
        bodyHTML = c.lenient(String.self, forKey: .bodyHTML) ?? ""
        position = c.lenient(Int.self, forKey: .position) ?? 0
        version = c.lenient(Int.self, forKey: .version) ?? 1
        createdBy = c.lenient(UserRef.self, forKey: .createdBy)
        updatedBy = c.lenient(UserRef.self, forKey: .updatedBy)
        createdAt = c.lenient(Date.self, forKey: .createdAt) ?? .now
        updatedAt = c.lenient(Date.self, forKey: .updatedAt) ?? createdAt
        breadcrumbs = c.lenient([WikiRef].self, forKey: .breadcrumbs) ?? []
        children = c.lenient([WikiRef].self, forKey: .children) ?? []
        isPrivate = c.lenient(Bool.self, forKey: .isPrivate) ?? false
        teamID = c.lenient(String.self, forKey: .teamID)
        template = c.lenient(Bool.self, forKey: .template) ?? false
        journal = c.lenient(Bool.self, forKey: .journal) ?? false
        dailyDate = c.lenient(String.self, forKey: .dailyDate)
        kind = c.lenient(String.self, forKey: .kind) ?? "page"
        locked = c.lenient(Bool.self, forKey: .locked) ?? false
        verification = c.lenient(WikiVerification.self, forKey: .verification)
        deletedAt = c.lenient(Date.self, forKey: .deletedAt)
        deletedBy = c.lenient(UserRef.self, forKey: .deletedBy)
        database = c.lenient(WikiDatabase.self, forKey: .database)
        area = c.lenient(WikiArea.self, forKey: .area) ?? .wiki
        extras = (try? WikiPageExtras(from: decoder)) ?? WikiPageExtras()
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(parentID, forKey: .parentID)
        try c.encode(title, forKey: .title)
        try c.encode(icon, forKey: .icon)
        try c.encode(bodyHTML, forKey: .bodyHTML)
        try c.encode(position, forKey: .position)
        try c.encode(version, forKey: .version)
        try c.encode(createdBy, forKey: .createdBy)
        try c.encode(updatedBy, forKey: .updatedBy)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encode(breadcrumbs, forKey: .breadcrumbs)
        try c.encode(children, forKey: .children)
        try c.encode(isPrivate, forKey: .isPrivate)
        try c.encode(teamID, forKey: .teamID)
        try c.encode(template, forKey: .template)
        try c.encode(journal, forKey: .journal)
        try c.encodeIfPresent(dailyDate, forKey: .dailyDate)
        try c.encode(kind, forKey: .kind)
        try c.encode(locked, forKey: .locked)
        try c.encodeIfPresent(verification, forKey: .verification)
        try c.encodeIfPresent(deletedAt, forKey: .deletedAt)
        try c.encodeIfPresent(deletedBy, forKey: .deletedBy)
        try c.encodeIfPresent(database, forKey: .database)
        try c.encode(area, forKey: .area)
        try extras.encode(to: encoder)
    }

    /// The page as the tree holds it.
    var node: WikiNode {
        WikiNode(id: id, parentID: parentID, title: title, icon: icon, position: position, version: version, updatedAt: updatedAt, createdByID: createdBy?.id,
                 isPrivate: isPrivate, teamID: teamID, template: template, journal: journal, dailyDate: dailyDate,
                 verified: verification.map { !$0.expired } ?? false, kind: kind, area: area)
    }

    var displayTitle: String { WikiText.title(title) }
    var isDatabase: Bool { kind == "database" }
    var isCanvas: Bool { kind == "canvas" }
    var inTrash: Bool { deletedAt != nil }
}

/// Who vouched for a page and until when (contracts/wiki.md "Verified pages").
struct WikiVerification: Codable, Hashable, Sendable {
    var by: UserRef?
    var at: Date
    /// Nil: verified until someone changes the page.
    var until: Date?
    var expired: Bool

    enum CodingKeys: String, CodingKey { case by, at, until, expired }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        by = c.lenient(UserRef.self, forKey: .by)
        at = c.lenient(Date.self, forKey: .at) ?? .now
        until = c.lenient(Date.self, forKey: .until)
        expired = c.lenient(Bool.self, forKey: .expired) ?? false
    }
}

/// A database's properties and views (contracts/wiki.md "Databases"). Filtering, sorting and
/// grouping run in the app (`WikiDbQuery`).
struct WikiDatabase: Codable, Hashable, Sendable {
    var properties: [WikiDbProperty]
    var views: [WikiDbView]

    enum CodingKeys: String, CodingKey { case properties, views }

    init(properties: [WikiDbProperty], views: [WikiDbView] = []) {
        self.properties = properties
        self.views = views
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        properties = c.lenient([WikiDbProperty].self, forKey: .properties) ?? []
        views = c.lenient([WikiDbView].self, forKey: .views) ?? []
    }

    func property(_ id: String?) -> WikiDbProperty? {
        guard let id else { return nil }
        return properties.first { $0.id == id }
    }
}

struct WikiDbProperty: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    /// `title`, `text`, `number`, `select`, `status`, `date`, `person`, `checkbox`, ...
    var type: String
    var options: [WikiDbOption]
    /// unique_id: letters before the number.
    var prefix: String?
    /// number: how it reads (`number`, `comma`, `percent`, `usd`, `eur`, ...).
    var numberFormat: String?
    /// date: values have a time of day.
    var dateTime: Bool?
    /// relation: the related database.
    var databaseID: String?

    enum CodingKeys: String, CodingKey {
        case id, name, type, options, prefix
        case numberFormat = "number_format"
        case dateTime = "date_time"
        case databaseID = "database_id"
    }

    init(id: String, name: String, type: String, options: [WikiDbOption] = []) {
        self.id = id
        self.name = name
        self.type = type
        self.options = options
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, forKey: .name) ?? ""
        type = c.lenient(String.self, forKey: .type) ?? "text"
        options = c.lenient([WikiDbOption].self, forKey: .options) ?? []
        prefix = c.lenient(String.self, forKey: .prefix)
        numberFormat = c.lenient(String.self, forKey: .numberFormat)
        dateTime = c.lenient(Bool.self, forKey: .dateTime)
        databaseID = c.lenient(String.self, forKey: .databaseID)
    }

    /// Whether a row keeps a value of it; the app computes the rest.
    var stored: Bool {
        !["title", "rollup", "formula", "created_time", "created_by", "edited_time", "edited_by", "unique_id"].contains(type)
    }

    func option(_ id: String?) -> WikiDbOption? {
        guard let id else { return nil }
        return options.first { $0.id == id }
    }
}

struct WikiDbOption: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    /// A tone name (`gray`, `blue`, ...).
    var color: String?

    init(id: String, name: String, color: String? = nil) {
        self.id = id
        self.name = name
        self.color = color
    }

    var tone: Tone { Tone(label: color) }
}

/// One saved way of showing a database's rows. Its settings belong to the app (web
/// `DbViewSettings`): read here as they are kept, never written.
struct WikiDbView: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    /// `table`, `board`, `list`, `gallery`, `calendar`, `timeline`, `chart` or `form`.
    var type: String
    var settings: JSONValue?

    enum CodingKeys: String, CodingKey { case id, name, type, settings }

    init(id: String, name: String, type: String, settings: JSONValue? = nil) {
        self.id = id
        self.name = name
        self.type = type
        self.settings = settings
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, forKey: .name) ?? ""
        type = c.lenient(String.self, forKey: .type) ?? "table"
        settings = c.lenient(JSONValue.self, forKey: .settings)
    }

    var groupBy: String? { settings?["group_by"]?.string }
    var dateProperty: String? { settings?["date_property"]?.string }
    var hidden: [String] { settings?["hidden"]?.array?.compactMap(\.string) ?? [] }
    var order: [String] { settings?["order"]?.array?.compactMap(\.string) ?? [] }
    var hideEmptyGroups: Bool { settings?["hide_empty_groups"]?.bool ?? false }

    var symbol: String {
        switch type {
        case "board": "rectangle.split.3x1"
        case "list": "list.bullet"
        case "gallery": "square.grid.2x2"
        case "calendar": "calendar"
        case "timeline": "chart.bar.doc.horizontal"
        case "chart": "chart.pie"
        case "form": "list.bullet.clipboard"
        default: "tablecells"
        }
    }
}

/// A database's row as its views read it (`GET /v1/wiki/databases/{id}/rows`).
struct WikiDbRow: Decodable, Hashable, Sendable, Identifiable {
    var node: WikiNode
    /// Its values, by property id.
    var props: [String: JSONValue]
    var createdAt: Date
    var createdBy: UserRef?
    var updatedBy: UserRef?
    /// How its text starts.
    var excerpt: String
    var cover: String

    var id: String { node.id }

    enum CodingKeys: String, CodingKey {
        case props, excerpt, cover
        case createdAt = "created_at"
        case createdBy = "created_by"
        case updatedBy = "updated_by"
    }

    init(from decoder: Decoder) throws {
        node = try WikiNode(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        props = c.lenient([String: JSONValue].self, forKey: .props) ?? [:]
        createdAt = c.lenient(Date.self, forKey: .createdAt) ?? node.updatedAt
        createdBy = c.lenient(UserRef.self, forKey: .createdBy)
        updatedBy = c.lenient(UserRef.self, forKey: .updatedBy)
        excerpt = c.lenient(String.self, forKey: .excerpt) ?? ""
        cover = c.lenient(String.self, forKey: .cover) ?? ""
    }
}

struct WikiDbRows: Decodable, Sendable {
    var data: [WikiDbRow]
    /// The database's own templates, which a new row can start as a copy of.
    var templates: [WikiNode]

    enum CodingKeys: String, CodingKey { case data, templates }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        data = c.lenient([WikiDbRow].self, forKey: .data) ?? []
        templates = c.lenient([WikiNode].self, forKey: .templates) ?? []
    }
}

/// A page in the trash, with what went with it (contracts/wiki.md "Trash").
struct WikiTrashedPage: Decodable, Hashable, Sendable, Identifiable {
    var node: WikiNode
    var deletedAt: Date
    var deletedBy: UserRef?
    /// When it goes for good.
    var purgeAt: Date
    /// How many pages went to the trash with it.
    var subpages: Int
    /// Where it was: its ancestors when it was trashed, the top-level page first.
    var path: [WikiRef]

    var id: String { node.id }

    enum CodingKeys: String, CodingKey {
        case subpages, path
        case deletedAt = "deleted_at"
        case deletedBy = "deleted_by"
        case purgeAt = "purge_at"
    }

    init(from decoder: Decoder) throws {
        node = try WikiNode(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deletedAt = c.lenient(Date.self, forKey: .deletedAt) ?? .now
        deletedBy = c.lenient(UserRef.self, forKey: .deletedBy)
        purgeAt = c.lenient(Date.self, forKey: .purgeAt) ?? deletedAt.addingTimeInterval(30 * 24 * 3600)
        subpages = c.lenient(Int.self, forKey: .subpages) ?? 0
        path = c.lenient([WikiRef].self, forKey: .path) ?? []
    }
}

// MARK: - Comments

/// One comment of a thread (contracts/wiki.md "Comments").
struct WikiComment: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var threadID: String
    /// Nil for a deleted account.
    var author: UserRef?
    var bodyHTML: String
    var createdAt: Date
    var editedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, author
        case threadID = "thread_id"
        case bodyHTML = "body_html"
        case createdAt = "created_at"
        case editedAt = "edited_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        threadID = c.lenient(String.self, forKey: .threadID) ?? ""
        author = c.lenient(UserRef.self, forKey: .author)
        bodyHTML = c.lenient(String.self, forKey: .bodyHTML) ?? ""
        createdAt = c.lenient(Date.self, forKey: .createdAt) ?? .now
        editedAt = c.lenient(Date.self, forKey: .editedAt)
    }
}

/// A thread on a page: its first comment and the replies, oldest first; inline threads keep
/// the text they were made on as `quote`.
struct WikiThread: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var pageID: String
    var quote: String
    var inline: Bool
    var createdAt: Date
    var resolvedAt: Date?
    var resolvedBy: UserRef?
    var comments: [WikiComment]

    enum CodingKeys: String, CodingKey {
        case id, quote, inline, comments
        case pageID = "page_id"
        case createdAt = "created_at"
        case resolvedAt = "resolved_at"
        case resolvedBy = "resolved_by"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        pageID = c.lenient(String.self, forKey: .pageID) ?? ""
        quote = c.lenient(String.self, forKey: .quote) ?? ""
        inline = c.lenient(Bool.self, forKey: .inline) ?? false
        createdAt = c.lenient(Date.self, forKey: .createdAt) ?? .now
        resolvedAt = c.lenient(Date.self, forKey: .resolvedAt)
        resolvedBy = c.lenient(UserRef.self, forKey: .resolvedBy)
        comments = c.lenient([WikiComment].self, forKey: .comments) ?? []
    }

    var resolved: Bool { resolvedAt != nil }
}

/// A page's threads, open and resolved, and whether the caller follows the page.
struct WikiComments: Decodable, Sendable {
    var data: [WikiThread]
    var following: Bool

    enum CodingKeys: String, CodingKey { case data, following }

    init(data: [WikiThread], following: Bool) {
        self.data = data
        self.following = following
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        data = c.lenient([WikiThread].self, forKey: .data) ?? []
        following = c.lenient(Bool.self, forKey: .following) ?? false
    }

    var open: [WikiThread] { data.filter { !$0.resolved } }
}

/// Body of `POST /v1/wiki/pages/{id}/comments`: a new thread, or a reply with `threadID`.
struct WikiCommentCreate: Encodable, Sendable {
    var bodyHTML: String
    var threadID: String?

    enum CodingKeys: String, CodingKey {
        case bodyHTML = "body_html"
        case threadID = "thread_id"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(bodyHTML, forKey: .bodyHTML)
        try c.encodeIfPresent(threadID, forKey: .threadID)
    }
}

/// `{following}` of `PUT /v1/wiki/pages/{id}/follow`.
struct WikiFollowing: Codable, Sendable {
    var following: Bool
}

/// A kept version of a page; `bodyHTML` only when one revision is read.
struct WikiRevision: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String
    var icon: String
    var bodyHTML: String?
    var author: UserRef?
    var createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, title, icon, author
        case bodyHTML = "body_html"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(id: String, title: String, icon: String, bodyHTML: String?, author: UserRef?, createdAt: Date, updatedAt: Date) {
        self.id = id
        self.title = title
        self.icon = icon
        self.bodyHTML = bodyHTML
        self.author = author
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.lenient(String.self, forKey: .title) ?? ""
        icon = c.lenient(String.self, forKey: .icon) ?? ""
        bodyHTML = c.lenient(String.self, forKey: .bodyHTML)
        author = c.lenient(UserRef.self, forKey: .author)
        createdAt = c.lenient(Date.self, forKey: .createdAt) ?? .now
        updatedAt = c.lenient(Date.self, forKey: .updatedAt) ?? createdAt
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(icon, forKey: .icon)
        try c.encodeIfPresent(bodyHTML, forKey: .bodyHTML)
        try c.encode(author, forKey: .author)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
    }

    var displayTitle: String { WikiText.title(title) }
}

struct WikiSearchHit: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var parentID: String?
    var title: String
    var icon: String
    var snippet: String
    var path: [WikiRef]
    var updatedAt: Date
    var area: WikiArea = .wiki

    enum CodingKeys: String, CodingKey {
        case id, title, icon, snippet, path, area
        case parentID = "parent_id"
        case updatedAt = "updated_at"
    }

    init(id: String, parentID: String?, title: String, icon: String, snippet: String, path: [WikiRef], updatedAt: Date, area: WikiArea = .wiki) {
        self.area = area
        self.id = id
        self.parentID = parentID
        self.title = title
        self.icon = icon
        self.snippet = snippet
        self.path = path
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        parentID = c.lenient(String.self, forKey: .parentID)
        title = c.lenient(String.self, forKey: .title) ?? ""
        icon = c.lenient(String.self, forKey: .icon) ?? ""
        snippet = c.lenient(String.self, forKey: .snippet) ?? ""
        path = c.lenient([WikiRef].self, forKey: .path) ?? []
        updatedAt = c.lenient(Date.self, forKey: .updatedAt) ?? .now
        area = c.lenient(WikiArea.self, forKey: .area) ?? .wiki
    }

    var displayTitle: String { WikiText.title(title) }
}

/// Body of `POST /v1/wiki/pages`.
struct WikiPageCreate: Encodable, Sendable {
    var parentID: String?
    var title: String?
    var icon: String?
    var bodyHTML: String?
    /// Where a top-level page lives: `workspace` (the default), `private` or `team` with `teamID`.
    var space: String?
    var teamID: String?
    /// The tree a top-level page goes in (`wiki` when left out); a subpage goes in its parent's.
    var area: WikiArea?
    /// `page` when left out, `database` or `canvas` (contracts/wiki.md "Databases", "Canvas").
    var kind: String?

    enum CodingKeys: String, CodingKey {
        case title, icon, space, area, kind
        case parentID = "parent_id"
        case bodyHTML = "body_html"
        case teamID = "team_id"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(parentID, forKey: .parentID)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(icon, forKey: .icon)
        try c.encodeIfPresent(bodyHTML, forKey: .bodyHTML)
        try c.encodeIfPresent(space, forKey: .space)
        try c.encodeIfPresent(teamID, forKey: .teamID)
        try c.encodeIfPresent(area, forKey: .area)
        try c.encodeIfPresent(kind, forKey: .kind)
    }
}

/// Body of `POST /v1/wiki/pages/{id}/duplicate`: Use a template copies the template here.
struct WikiDuplicate: Encodable, Sendable {
    var parentID: String?
    var space: String?
    var teamID: String?
    var title: String?
    var area: WikiArea?
    /// Left out, the copy is what the page is: Use a template sends false, for a page of the tree.
    var template: Bool?

    enum CodingKeys: String, CodingKey {
        case space, title, area, template
        case parentID = "parent_id"
        case teamID = "team_id"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(parentID, forKey: .parentID)
        try c.encodeIfPresent(space, forKey: .space)
        try c.encodeIfPresent(teamID, forKey: .teamID)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(area, forKey: .area)
        try c.encodeIfPresent(template, forKey: .template)
    }
}

/// Body of `POST /v1/wiki/daily`: opens the caller's note of `date`, making it (and their
/// journal) when there is none (contracts/wiki.md "Journal").
struct WikiDailyOpen: Encodable, Sendable {
    /// `YYYY-MM-DD`.
    var date: String
    var title: String
    var journalTitle: String
    var area: WikiArea

    enum CodingKeys: String, CodingKey {
        case date, title, area
        case journalTitle = "journal_title"
    }
}

/// Body of `PATCH /v1/wiki/pages/{id}`: only what changed, with the version it edited.
struct WikiPagePatch: Encodable, Sendable {
    var title: String?
    var icon: String?
    var bodyHTML: String?
    var version: Int

    enum CodingKeys: String, CodingKey {
        case title, icon, version
        case bodyHTML = "body_html"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(icon, forKey: .icon)
        try c.encodeIfPresent(bodyHTML, forKey: .bodyHTML)
        try c.encode(version, forKey: .version)
    }

    var isEmpty: Bool { title == nil && icon == nil && bodyHTML == nil }
}

/// Body of `POST /v1/wiki/pages/{id}/move`; a null parent is the top level.
struct WikiMove: Encodable, Sendable {
    var parentID: String?
    var position: Int
    /// At the top level, the tree it moves to with its subpages (contracts/pages.md "Areas").
    var area: WikiArea?

    enum CodingKeys: String, CodingKey {
        case position, area
        case parentID = "parent_id"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(parentID, forKey: .parentID)
        try c.encode(position, forKey: .position)
        try c.encodeIfPresent(area, forKey: .area)
    }
}

enum WikiText {
    /// The longest title the API takes.
    static let maxTitle = 200
    /// How deep pages nest.
    static let maxDepth = 10

    /// A page's title for display: "Untitled" until it has one.
    static func title(_ title: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Untitled" : trimmed
    }
}

/// Starter pages a new wiki offers (web `components/wiki/templates.ts`): an outline to fill in.
struct WikiTemplate: Identifiable, Sendable {
    let id: String
    let icon: String
    let title: String
    let hint: String
    let bodyHTML: String

    static let all: [WikiTemplate] = [
        WikiTemplate(
            id: "escalation", icon: "🚨", title: "Escalation process", hint: "When and how to hand a ticket up.",
            bodyHTML: "<p>Escalate when a customer is blocked, money is at stake, or you have tried twice without progress.</p><h2>Before you escalate</h2><ul><li><p>Read the ticket's history and search the wiki.</p></li><li><p>Write down what you tried.</p></li></ul><h2>Steps</h2><ol><li><p>Set the ticket to urgent.</p></li><li><p>Leave an internal note with what the customer needs.</p></li><li><p>Assign it to the lead on call.</p></li><li><p>Tell the customer who has it now and when they will hear back.</p></li></ol><h2>Who is on call</h2><p>Add your rota, or a link to it, here.</p>"
        ),
        WikiTemplate(
            id: "refunds", icon: "💸", title: "Refund policy", hint: "Who can refund what, and when.",
            bodyHTML: "<p>Who can refund what, and when.</p><h2>The rule</h2><p>Refund any charge within 30 days, no questions asked.</p><h2>Exceptions</h2><ul><li><p>Duplicate charges: refund at once and apologize.</p></li><li><p>Over 100 euros: a lead approves it first.</p></li><li><p>Chargebacks: don't refund twice. Hand the ticket to billing.</p></li></ul><h2>How to refund</h2><ol><li><p>Find the charge in the billing tool.</p></li><li><p>Refund it and note the amount on the ticket.</p></li></ol>"
        ),
        WikiTemplate(
            id: "onboarding", icon: "👋", title: "Onboarding checklist", hint: "A new teammate's first two weeks.",
            bodyHTML: "<p>What a new teammate does in their first two weeks.</p><h2>Week one</h2><ul><li><p>Get access to the helpdesk, chat and billing tools.</p></li><li><p>Read the escalation process and the refund policy.</p></li><li><p>Shadow a teammate for two shifts.</p></li></ul><h2>Week two</h2><ul><li><p>Answer tickets with a buddy reviewing your drafts.</p></li><li><p>Take your own queue for half a day.</p></li></ul>"
        ),
    ]
}
