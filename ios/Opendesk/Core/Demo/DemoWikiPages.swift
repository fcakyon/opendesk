#if DEBUG
import Foundation

// What a demo page does beyond its text (contracts/wiki.md): a bug tracker database with its
// rows and views, a canvas, aliases, tags and a ticket mention in Margin's wiki; and the routes
// for a page's look, rows, links, analytics, readers, export, publishing and Ollie writing.
//
//   11 Bug tracker (database)       12..15 its rows             16 Support journey (canvas), all in Pages

extension DemoWiki {
    /// Margin's database, canvas, aliases, tags and ticket mention, beside the seeded pages.
    mutating func addPagesWork() {
        let maya = DemoPerson.maya.ref
        let at = DemoSeed.ago(3 * 1440)
        func page(_ n: Int, parent: Int?, position: Int, icon: String, title: String, body: String = "", kind: String = "page") -> WikiPage {
            var page = WikiPage(id: DemoWiki.pageID(n), parentID: parent.map(DemoWiki.pageID), title: title, icon: icon, bodyHTML: body, position: position,
                                version: 1, createdBy: maya, updatedBy: maya, createdAt: at, updatedAt: at, breadcrumbs: [], children: [])
            page.kind = kind
            page.area = .pages
            return page
        }
        let top = pages.filter { $0.parentID == nil && $0.area == .pages && !$0.template }.count

        var tracker = page(11, parent: nil, position: top, icon: "🐞", title: "Bug tracker", kind: "database")
        let status = WikiDbProperty(id: "status", name: "Status", type: "status", options: [
            WikiDbOption(id: "triage", name: "Triage", color: "gray"), WikiDbOption(id: "doing", name: "In progress", color: "blue"),
            WikiDbOption(id: "fixed", name: "Fixed", color: "green"),
        ])
        let area = WikiDbProperty(id: "area", name: "Area", type: "select", options: [
            WikiDbOption(id: "billing", name: "Billing", color: "amber"), WikiDbOption(id: "login", name: "Login", color: "violet"),
            WikiDbOption(id: "mobile", name: "Mobile", color: "teal"),
        ])
        var due = WikiDbProperty(id: "due", name: "Due", type: "date")
        due.dateTime = false
        var tickets = WikiDbProperty(id: "tickets", name: "Tickets", type: "number")
        tickets.numberFormat = "number"
        tracker.database = WikiDatabase(properties: [
            WikiDbProperty(id: "title", name: "Name", type: "title"), status, area,
            WikiDbProperty(id: "owner", name: "Owner", type: "person"), due,
            WikiDbProperty(id: "customer", name: "Customer facing", type: "checkbox"), tickets,
        ], views: [
            WikiDbView(id: "all", name: "All bugs", type: "table", settings: .object(["sorts": .array([.object(["property": .string("due"), "dir": .string("asc")])])])),
            WikiDbView(id: "board", name: "Board", type: "board", settings: .object(["group_by": .string("status")])),
            WikiDbView(id: "calendar", name: "Calendar", type: "calendar", settings: .object(["date_property": .string("due")])),
            WikiDbView(id: "form", name: "Report a bug", type: "form", settings: .object(["form": .object([
                "title": .string("Report a bug"), "description": .string("What broke, and where. Support reads every report."),
                "fields": .array([
                    .object(["property": .string("area"), "required": .bool(true)]),
                    .object(["property": .string("customer"), "help": .string("Did a customer run into it?")]),
                ]),
                "submitted": .string("Thanks, the bug is on the board."),
            ])])),
        ])
        tracker.bodyHTML = "<p>Bugs customers reported, until they are fixed.</p>"
        pages.append(tracker)

        let rows: [(Int, String, String, String, String?, Bool, Double)] = [
            (12, "Invoice PDF shows the wrong VAT", "doing", "billing", DemoWiki.day(2), true, 4),
            (13, "SSO loop after password reset", "triage", "login", DemoWiki.day(5), true, 2),
            (14, "Push arrives twice on iPad", "fixed", "mobile", DemoWiki.day(-3), false, 1),
            (15, "Card declined message is vague", "triage", "billing", nil, true, 6),
        ]
        for (index, row) in rows.enumerated() {
            var item = page(row.0, parent: 11, position: index, icon: "", title: row.1, body: "<p>Steps to see it, and what the customer expected.</p>")
            var props: [String: JSONValue] = ["status": .string(row.2), "area": .string(row.3), "customer": .bool(row.5), "tickets": .number(row.6)]
            props["owner"] = .array([.string(DemoPerson.maya.ref.id)])
            if let day = row.4 { props["due"] = .object(["start": .string(day)]) }
            item.extras.props = props
            pages.append(item)
        }

        var journey = page(16, parent: nil, position: top + 1, icon: "🗺️", title: "Support journey", kind: "canvas")
        journey.extras.canvas = WikiCanvas(nodes: [
            WikiCanvasNode(id: "g1", type: "group", x: -40, y: -60, width: 760, height: 300, label: "When a customer writes"),
            WikiCanvasNode(id: "t1", type: "text", x: 0, y: 0, width: 200, height: 110, html: "<p><strong>New ticket</strong></p><p>Ollie triages it and picks a team.</p>"),
            WikiCanvasNode(id: "p1", type: "page", x: 260, y: 0, width: 200, height: 80, color: "4", pageID: DemoWiki.pageID(1)),
            WikiCanvasNode(id: "p2", type: "page", x: 500, y: 0, width: 200, height: 80, color: "2", pageID: DemoWiki.pageID(4)),
            WikiCanvasNode(id: "t2", type: "text", x: 260, y: 140, width: 220, height: 80, html: "<p>Solved, then a survey goes out.</p>"),
            WikiCanvasNode(id: "l1", type: "link", x: 0, y: 320, width: 260, height: 100, url: "https://docs.opendesk.sh", title: "opendesk docs"),
        ], edges: [
            WikiCanvasEdge(id: "e1", fromNode: "t1", toNode: "p1", label: "urgent"),
            WikiCanvasEdge(id: "e2", fromNode: "t1", toNode: "p2", label: "refund"),
            WikiCanvasEdge(id: "e3", fromNode: "p1", toNode: "t2"),
        ])
        pages.append(journey)

        if let refunds = pages.firstIndex(where: { $0.id == DemoWiki.pageID(4) }) {
            pages[refunds].extras.aliases = ["Refunds", "Money back"]
            pages[refunds].bodyHTML += "<p>#policy #billing/refunds</p>"
        }
        if let incident = pages.firstIndex(where: { $0.id == DemoWiki.pageID(2) }) {
            let ticket = DemoSeed.ticketID(1068)
            pages[incident].bodyHTML += "<p>Last used on <a data-type=\"ticket\" data-id=\"\(ticket)\" href=\"/tickets/1068\">#1068</a>. #process #incident</p>"
        }
        if let escalation = pages.firstIndex(where: { $0.id == DemoWiki.pageID(1) }) {
            pages[escalation].bodyHTML += "<p>See the <a href=\"/wiki/\(DemoWiki.pageID(4))\">Refund policy</a> for money questions. #process</p>"
        }
    }

    static func day(_ offset: Int) -> String {
        let date = Calendar.current.date(byAdding: .day, value: offset, to: DemoMode.anchor) ?? DemoMode.anchor
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 2026, parts.month ?? 1, parts.day ?? 1)
    }

    /// The `#tags` of a body: `#` and letters, digits, `_`, `/` or `-` with a letter, after a space or at a line's start.
    static func tags(in html: String) -> [String] {
        let text = HTMLText.plain(from: html)
        guard let regex = try? NSRegularExpression(pattern: "(?:^|\\s)#([A-Za-z0-9_/-]*[A-Za-z][A-Za-z0-9_/-]*)", options: [.anchorsMatchLines]) else { return [] }
        var out: [String] = []
        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let range = Range(match.range(at: 1), in: text) else { continue }
            let tag = text[range].lowercased()
            if !out.contains(tag) { out.append(tag) }
        }
        return out
    }

    /// A tree node as the list answers it, with its tags.
    func nodeJSON(_ page: WikiPage) -> JSONValue {
        var object = DemoSeed.json(page.node).object ?? [:]
        object["tags"] = .array(DemoWiki.tags(in: page.bodyHTML).map(JSONValue.string))
        if !page.extras.aliases.isEmpty { object["aliases"] = .array(page.extras.aliases.map(JSONValue.string)) }
        return .object(object)
    }

    /// The pages `id` links to: page links in its body and page cards on its canvas.
    func links(from page: WikiPage) -> [String] {
        var out: [String] = []
        for other in pages where other.id != page.id {
            if page.bodyHTML.contains("/wiki/\(other.id)") || page.bodyHTML.contains("data-id=\"\(other.id)\"")
                || (page.extras.canvas?.nodes.contains { $0.pageID == other.id } ?? false) {
                out.append(other.id)
            }
        }
        return out
    }
}

extension DemoBackend {
    /// A page's look, rows, links, reads, export and publishing; nil when the call is another one.
    func wikiPagesRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        let wiki = ws.kb.wiki
        if let id = call.match("GET", "wiki/databases/*/rows")?.first {
            guard wiki.page(id)?.isDatabase == true else { throw notFound("database") }
            let rows: [JSONValue] = wiki.children(of: id).filter { !$0.template }.map { row in
                var object = DemoSeed.json(row.node).object ?? [:]
                object["props"] = .object(row.extras.props)
                object["excerpt"] = .string(String(HTMLText.plain(from: row.bodyHTML).prefix(140)))
                object["cover"] = .string(row.extras.cover)
                object["created_at"] = .string(DemoSeed.stamp(row.createdAt))
                object["created_by"] = DemoSeed.json(row.createdBy)
                object["updated_by"] = DemoSeed.json(row.updatedBy)
                return .object(object)
            }
            return .some(encode(JSONValue.object(["data": .array(rows), "templates": .array([])])))
        }
        if call.match("POST", "wiki/pages") != nil, let parent = call.string("parent_id"), wiki.page(parent)?.isDatabase == true {
            let at = now()
            var row = WikiPage(id: made(), parentID: parent, title: String((call.string("title") ?? "").prefix(200)), icon: "", bodyHTML: "",
                               position: wiki.children(of: parent).count, version: 1, createdBy: me, updatedBy: me, createdAt: at, updatedAt: at, breadcrumbs: [], children: [])
            row.area = wiki.page(parent)?.area ?? .wiki
            if row.area == .pages, !ws.workspace.pagesOn { throw pagesOff() }
            row.extras.props = (call.body["props"]?.object ?? [:]).filter { !$0.value.isNull }
            ws.kb.wiki.pages.append(row)
            publish("wiki_page.created", ["wiki_page": DemoSeed.json(row.node), "updated_by": DemoSeed.json(me)], in: &ws)
            return .some(encode(ws.kb.wiki.full(row.id)))
        }
        if let id = call.match("PATCH", "wiki/pages/*")?.first, call.body["title"] == nil, call.body["icon"] == nil, call.body["body_html"] == nil {
            guard let index = ws.kb.wiki.pages.firstIndex(where: { $0.id == id }) else { throw notFound("page") }
            var page = ws.kb.wiki.pages[index]
            let body = call.body
            if let cover = body["cover"]?.string { page.extras.cover = cover }
            if let y = body["cover_y"]?.double { page.extras.coverY = y }
            if let on = body["full_width"]?.bool { page.extras.fullWidth = on }
            if let on = body["small_text"]?.bool { page.extras.smallText = on }
            if let font = body["font"]?.string { page.extras.font = font }
            if let on = body["locked"]?.bool { page.locked = on }
            if let names = body["aliases"]?.array { page.extras.aliases = Array(names.compactMap(\.string).prefix(10)) }
            if let props = body["props"]?.object {
                for (key, value) in props { page.extras.props[key] = value.isNull ? nil : value }
                page.updatedAt = now()
                page.updatedBy = me
            }
            if let verified = body["verified"]?.bool {
                if verified {
                    let until: JSONValue = body["verified_days"]?.int.map { JSONValue.string(DemoSeed.stamp(DemoMode.anchor.addingTimeInterval(Double($0) * 86400))) } ?? .null
                    let verification: JSONValue = .object(["by": DemoSeed.json(me), "at": .string(DemoSeed.stamp(now())), "expired": .bool(false), "until": until])
                    page.verification = try? verification.decode(WikiVerification.self)
                } else {
                    page.verification = nil
                }
            }
            ws.kb.wiki.pages[index] = page
            publish("wiki_page.updated", ["wiki_page": DemoSeed.json(page.node), "updated_by": DemoSeed.json(me)], in: &ws)
            return .some(encode(ws.kb.wiki.full(id)))
        }
        if let id = call.match("GET", "wiki/pages/*/backlinks")?.first {
            guard let target = wiki.page(id) else { throw notFound("page") }
            let hits = wiki.pages.filter { wiki.links(from: $0).contains(target.id) }.map { hit($0, in: wiki) }
            return .some(encode(ListBody(data: hits)))
        }
        if let id = call.match("GET", "wiki/pages/*/mentions")?.first {
            guard let target = wiki.page(id) else { throw notFound("page") }
            let names = ([target.title] + target.extras.aliases).filter { !$0.isEmpty }
            let hits = wiki.pages.filter { other in
                guard other.id != id, !wiki.links(from: other).contains(id) else { return false }
                let text = HTMLText.plain(from: other.bodyHTML)
                return names.contains { text.localizedCaseInsensitiveContains($0) }
            }.map { hit($0, in: wiki) }
            return .some(encode(ListBody(data: hits)))
        }
        if call.match("GET", "wiki/graph") != nil {
            let links = wiki.pages.flatMap { page in wiki.links(from: page).map { WikiGraphLink(from: page.id, to: $0) } }
            return .some(encode(ListBody(data: links)))
        }
        if let id = call.match("GET", "wiki/pages/*/analytics")?.first {
            guard wiki.page(id) != nil else { throw notFound("page") }
            let seed = id.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) % 9973 }
            let days: [JSONValue] = (0 ..< 28).map { back in
                let date = Calendar.current.date(byAdding: .day, value: back - 27, to: DemoMode.anchor) ?? DemoMode.anchor
                let views = (seed + back * 7) % 5 == 0 ? 0 : (seed + back * 3) % 6
                return .object(["date": .string(DemoSeed.stamp(date).prefix(10).description), "views": .number(Double(views)), "viewers": .number(Double(min(views, 3)))])
            }
            let total = days.compactMap { $0["views"]?.int }.reduce(0, +)
            return .some(encode(JSONValue.object(["days": .array(days), "total_views": .number(Double(total)), "total_viewers": .number(Double(min(total, 4))), "edits": .array([])])))
        }
        if let id = call.match("GET", "wiki/pages/*/views")?.first {
            guard wiki.page(id) != nil else { throw notFound("page") }
            let readers: [JSONValue] = ws.members.prefix(3).enumerated().map { index, member in
                .object(["user": DemoSeed.json(member.ref), "visits": .number(Double(4 - index)), "last_at": .string(DemoSeed.stamp(DemoSeed.ago(Double(index + 1) * 95)))])
            }
            return .some(encode(JSONValue.object(["views": .number(9), "people": .number(Double(readers.count)), "readers": .array(readers)])))
        }
        if let id = call.match("GET", "wiki/pages/*/export")?.first {
            guard let page = wiki.page(id) else { throw notFound("page") }
            if call.query["format"] == "html" {
                return .some(Data("<!doctype html><title>\(HTMLText.escape(page.displayTitle))</title><h1>\(HTMLText.escape(page.displayTitle))</h1>\(page.bodyHTML)".utf8))
            }
            if page.isCanvas, let canvas = page.extras.canvas { return .some(encode(canvas)) }
            let body = KBMarkdown.markdown(from: page.bodyHTML) ?? HTMLText.plain(from: page.bodyHTML)
            return .some(Data("---\ntitle: \(page.displayTitle)\n---\n\n# \(page.displayTitle)\n\n\(body)\n".utf8))
        }
        if let key = call.match("GET", "tickets/*/wiki")?.first {
            let index = try ticket(key, in: ws)
            let ticketID = ws.tickets[index].id
            let found = wiki.pages.filter { $0.bodyHTML.contains("data-id=\"\(ticketID)\"") && !$0.template }.sorted { $0.updatedAt > $1.updatedAt }.map(\.node)
            return .some(encode(ListBody(data: found)))
        }
        if call.match("POST", "kb/articles/from-wiki") != nil {
            guard let page = wiki.page(call.string("page_id") ?? "") else { throw notFound("page") }
            let title = (call.string("title") ?? page.title).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { throw Failure(status: 422, code: "invalid", detail: "Give the article a title.") }
            let slug = title.lowercased().split { !$0.isLetter && !$0.isNumber }.joined(separator: "-") + "-" + made().suffix(4)
            let article = KBArticle(
                id: made(), collectionID: call.string("collection_id"), title: title, slug: slug, excerpt: "", bodyHTML: page.bodyHTML,
                status: .draft, author: me, views: 0, publishedAt: nil, updatedAt: now()
            )
            ws.kb.articles.insert(article, at: 0)
            publish("kb_article.created", ["article": DemoSeed.json(article)], in: &ws)
            let leftOut = page.bodyHTML.components(separatedBy: "data-type=\"database\"").count - 1
            return .some(encode(JSONValue.object(["article": DemoSeed.json(article), "left_out": .number(Double(leftOut))])))
        }
        return nil
    }

    private func hit(_ page: WikiPage, in wiki: DemoWiki) -> WikiSearchHit {
        WikiSearchHit(id: page.id, parentID: page.parentID, title: page.title, icon: page.icon,
                      snippet: String(HTMLText.plain(from: page.bodyHTML).replacingOccurrences(of: "\n", with: " ").prefix(120)),
                      path: wiki.ancestors(of: page.id).map { WikiRef(id: $0.id, title: $0.title, icon: $0.icon) }, updatedAt: page.updatedAt, area: page.area)
    }

    /// Ollie writing on a page, paced like a model: `delta` chunks, then `done` with `{html}`.
    func wikiWriteStream(_ call: Call) throws -> [Beat]? {
        guard call.match("POST", "wiki/ai/write") != nil else { return nil }
        let mode = call.string("mode") ?? "improve"
        let source = HTMLText.plain(from: call.string("html") ?? call.string("context_html") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let first = source.split(separator: "\n").first.map(String.init) ?? (call.string("title") ?? "this page")
        let text: String
        switch mode {
        case "summarize": text = "In short: \(first.prefix(120)). The rest of the page explains who does what, and when."
        case "action_items": text = "Read the page once a quarter. Check the steps still match the tools. Ask the team lead about anything unclear."
        case "explain": text = "This page tells the team what to do and in which order, so a customer gets the same answer whoever replies."
        case "continue", "custom": text = call.string("instructions").flatMap { $0.isEmpty ? nil : "Here is a first go at \"\($0)\". Change anything that doesn't fit your team." } ?? "Once that is done, tell the customer what happens next and when they will hear from you."
        default: text = source.isEmpty ? "A clear, friendly page the whole team can follow." : String(source.prefix(400))
        }
        let html = mode == "action_items"
            ? "<ul data-type=\"taskList\">" + text.split(separator: ".").map { "<li data-type=\"taskItem\" data-checked=\"false\"><p>\($0.trimmingCharacters(in: .whitespaces)).</p></li>" }.filter { !$0.contains("<p>.</p>") }.joined() + "</ul>"
            : "<p>" + HTMLText.escape(text) + "</p>"
        let deltas = words(text).map { Beat(event: "delta", data: $0.data, pause: $0.pause) }
        return deltas + [Beat(event: "done", data: .object(["html": .string(html)]), pause: 120)]
    }
}
#endif
