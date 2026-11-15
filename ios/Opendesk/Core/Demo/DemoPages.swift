#if DEBUG
import Foundation

// Pages in the demo (contracts/pages.md): each list reads one area, Pages off refuses its
// pages, and the routes the app's Pages screens use: templates, Use a template and the
// journal's daily notes.

extension DemoBackend {
    /// What every route on a page of Pages answers while the workspace has Pages off.
    func pagesOff() -> Failure {
        Failure(status: 403, code: "feature_disabled", detail: "Pages is turned off in this workspace.")
    }

    func wikiAreaRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        let pagesOn = ws.workspace.pagesOn
        if call.match("GET", "wiki/pages") != nil {
            let area = call.query["area"].flatMap(WikiArea.init(rawValue:)) ?? .wiki
            if area == .pages, !pagesOn { throw pagesOff() }
            let wiki = ws.kb.wiki
            return .some(encode(ListBody(data: wiki.pages.filter { $0.area == area }.map { wiki.nodeJSON($0) })))
        }
        if let id = call.match("GET", "wiki/pages/*")?.first, ws.kb.wiki.page(id)?.area == .pages, !pagesOn {
            throw pagesOff()
        }
        if call.match("GET", "wiki/templates") != nil {
            let list = ws.kb.wiki.pages.filter { $0.template && $0.parentID == nil && (pagesOn || $0.area != .pages) }
            return .some(encode(ListBody(data: list.map(\.node))))
        }
        if let id = call.match("POST", "wiki/pages/*/duplicate")?.first {
            guard let source = ws.kb.wiki.page(id) else { throw notFound("page") }
            let parent = call.string("parent_id").flatMap { $0.isEmpty ? nil : $0 }
            let area = parent.flatMap { ws.kb.wiki.page($0)?.area } ?? call.string("area").flatMap(WikiArea.init(rawValue:)) ?? .wiki
            if area == .pages, !pagesOn { throw pagesOff() }
            let at = now()
            var page = WikiPage(
                id: made(), parentID: parent, title: call.string("title") ?? source.title, icon: source.icon, bodyHTML: source.bodyHTML,
                position: ws.kb.wiki.children(of: parent).count, version: 1, createdBy: me, updatedBy: me, createdAt: at, updatedAt: at,
                breadcrumbs: [], children: []
            )
            page.area = area
            page.kind = source.kind
            page.database = source.database
            page.template = call.body["template"]?.bool ?? source.template
            page.isPrivate = parent.flatMap { ws.kb.wiki.page($0)?.isPrivate } ?? (call.string("space") == "private")
            page.teamID = parent.flatMap { ws.kb.wiki.page($0)?.teamID } ?? (call.string("space") == "team" ? call.string("team_id") : nil)
            ws.kb.wiki.pages.append(page)
            ws.kb.wiki.revisions[page.id] = [WikiRevision(id: made(), title: page.title, icon: page.icon, bodyHTML: page.bodyHTML, author: me, createdAt: at, updatedAt: at)]
            publish("wiki_page.created", ["wiki_page": DemoSeed.json(page.node), "updated_by": DemoSeed.json(me)], in: &ws)
            return .some(encode(ws.kb.wiki.full(page.id)))
        }
        if call.match("POST", "wiki/daily") != nil {
            guard let date = call.string("date"), date.count == 10 else {
                throw Failure(status: 422, code: "invalid", detail: "A daily note needs its day.")
            }
            let area = call.string("area").flatMap(WikiArea.init(rawValue:)) ?? .wiki
            if area == .pages, !pagesOn { throw pagesOff() }
            let at = now()
            // The person's journal in this area: a private top-level page, made the first time.
            let journal: WikiPage
            if let found = ws.kb.wiki.pages.first(where: { $0.journal && $0.area == area && $0.createdBy?.id == me.id }) {
                journal = found
            } else {
                var fresh = WikiPage(
                    id: made(), parentID: nil, title: call.string("journal_title") ?? "Journal", icon: "📓", bodyHTML: "",
                    position: 0, version: 1, createdBy: me, updatedBy: me, createdAt: at, updatedAt: at, breadcrumbs: [], children: []
                )
                fresh.area = area
                fresh.journal = true
                fresh.isPrivate = true
                ws.kb.wiki.pages.append(fresh)
                journal = fresh
            }
            if let note = ws.kb.wiki.pages.first(where: { $0.parentID == journal.id && $0.dailyDate == date }) {
                return .some(encode(ws.kb.wiki.full(note.id)))
            }
            var note = WikiPage(
                id: made(), parentID: journal.id, title: call.string("title") ?? date, icon: "", bodyHTML: call.string("body_html") ?? "",
                position: 0, version: 1, createdBy: me, updatedBy: me, createdAt: at, updatedAt: at, breadcrumbs: [], children: []
            )
            note.area = area
            note.isPrivate = true
            note.dailyDate = date
            // Newest first under the journal.
            for index in ws.kb.wiki.pages.indices where ws.kb.wiki.pages[index].parentID == journal.id {
                ws.kb.wiki.pages[index].position += 1
            }
            ws.kb.wiki.pages.append(note)
            ws.kb.wiki.revisions[note.id] = [WikiRevision(id: made(), title: note.title, icon: note.icon, bodyHTML: note.bodyHTML, author: me, createdAt: at, updatedAt: at)]
            publish("wiki_page.created", ["wiki_page": DemoSeed.json(note.node), "updated_by": DemoSeed.json(me)], in: &ws)
            return .some(encode(ws.kb.wiki.full(note.id)))
        }
        return nil
    }
}
#endif
