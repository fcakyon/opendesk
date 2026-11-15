import Foundation

/// A page of the tree with its `#tags` (`GET /v1/wiki/pages`), for the tags list.
struct WikiTaggedNode: Decodable, Sendable {
    var node: WikiNode
    var tags: [String]

    enum CodingKeys: String, CodingKey { case tags }

    init(from decoder: Decoder) throws {
        node = try WikiNode(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tags = c.lenient([String].self, forKey: .tags) ?? []
    }
}

/// What a page does beyond its text (contracts/wiki.md): its look, a database's rows and
/// values, links and tags, analytics and readers, export, publishing and Ollie writing.
extension WikiStore {
    // MARK: Look

    /// Changes the page's look, aliases, verification or a row's values: no version, no revision.
    func setLook(_ id: String, _ patch: WikiLookPatch) async throws -> WikiPage {
        guard let api else { throw APIError.signedOut }
        return try await api.patch("v1/wiki/pages/\(id)", body: patch)
    }

    // MARK: Databases

    /// A database's rows, in order, with their values, and the templates a new row can start from.
    func database(rows databaseID: String) async throws -> WikiDbRows {
        guard let api else { throw APIError.signedOut }
        return try await api.get("v1/wiki/databases/\(databaseID)/rows")
    }

    /// A new row of the database with these values.
    func addRow(to databaseID: String, title: String, props: [String: JSONValue]) async throws -> WikiPage {
        guard let api else { throw APIError.signedOut }
        return try await api.post("v1/wiki/pages", body: WikiRowCreate(parentID: databaseID, title: title, props: props))
    }

    /// A copy of `id` and its subpages: a row from one of the database's templates.
    func duplicate(_ id: String, _ body: WikiDuplicate) async throws -> WikiPage {
        guard let api else { throw APIError.signedOut }
        return try await api.post("v1/wiki/pages/\(id)/duplicate", body: body)
    }

    // MARK: Links and tags

    /// The pages linking to `id`, last edited first.
    func backlinks(_ id: String) async throws -> [WikiSearchHit] {
        guard let api else { throw APIError.signedOut }
        let page: Page<WikiSearchHit> = try await api.get("v1/wiki/pages/\(id)/backlinks")
        return page.data
    }

    /// Pages naming `id` (its title or an alias) without a link to it.
    func unlinkedMentions(_ id: String) async throws -> [WikiSearchHit] {
        guard let api else { throw APIError.signedOut }
        let page: Page<WikiSearchHit> = try await api.get("v1/wiki/pages/\(id)/mentions")
        return page.data
    }

    /// Every link between pages of the workspace.
    func graph() async throws -> [WikiGraphLink] {
        guard let api else { throw APIError.signedOut }
        let page: Page<WikiGraphLink> = try await api.get("v1/wiki/graph")
        return page.data
    }

    /// Every page of one area's tree with its tags.
    func tagged(in area: WikiArea) async throws -> [WikiTaggedNode] {
        guard let api else { throw APIError.signedOut }
        let page: Page<WikiTaggedNode> = try await api.get("v1/wiki/pages", query: [URLQueryItem(name: "area", value: area.rawValue)])
        return page.data.filter { !$0.node.template && $0.node.area == area }
    }

    // MARK: Reads

    func analytics(_ id: String, days: Int = 28) async throws -> WikiPageAnalytics {
        guard let api else { throw APIError.signedOut }
        return try await api.get("v1/wiki/pages/\(id)/analytics", query: [URLQueryItem(name: "days", value: String(days))])
    }

    func readers(_ id: String) async throws -> WikiPageReaders {
        guard let api else { throw APIError.signedOut }
        return try await api.get("v1/wiki/pages/\(id)/views")
    }

    // MARK: Export

    /// The page as a Markdown or HTML file (a canvas as `.canvas`), with subpages a zip.
    func export(_ id: String, format: String, subpages: Bool) async throws -> (data: Data, filename: String?) {
        guard let api else { throw APIError.signedOut }
        return try await api.download("v1/wiki/pages/\(id)/export", query: [
            URLQueryItem(name: "format", value: format), URLQueryItem(name: "subpages", value: subpages ? "true" : "false"),
        ])
    }

    // MARK: Desk

    /// A draft help center article copied from the page.
    func publish(_ body: WikiPublish) async throws -> WikiPublished {
        guard let api else { throw APIError.signedOut }
        return try await api.post("v1/kb/articles/from-wiki", body: body)
    }

    /// Ollie's proposal for the page, streamed: `delta` chunks, then `done` with `{html}`.
    func write(_ body: WikiWriteRequest) async throws -> AsyncThrowingStream<SSEEvent, Error> {
        guard let api else { throw APIError.signedOut }
        return try await api.stream("v1/wiki/ai/write", body: body)
    }
}
