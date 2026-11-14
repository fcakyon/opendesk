import SwiftUI

/// The wiki (contracts/wiki.md), the team's runbooks, policies and how-tos, or Pages
/// (contracts/pages.md), the workspace's own pages, databases and canvases: one area's tree
/// of pages. The pages edited lately, the person's favorites, then the pages of each
/// teamspace, the workspace and their own private pages, each with its subpages folded
/// under it, today's note, templates and the trash; search finds words in titles and text
/// in both areas, this one's first. Agents and admins add pages here and under any page;
/// viewers read.
struct WikiListView: View {
    var area: WikiArea = .wiki

    @Environment(AppEnvironment.self) private var env
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    @State private var showScopes = false
    @State private var hits: [WikiSearchHit] = []
    @State private var searching = false
    @State private var searchError: String?
    @State private var searchTask: Task<Void, Never>?
    @State private var moving: WikiNode?
    @State private var creating = false
    @State private var listener: UUID?
    /// Where the new page popup adds, while it is open.
    @State private var adding: WikiNewPagePlace?

    private var store: WikiStore { WikiStore.shared }
    private var term: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// This area's pages, templates left out.
    private var pagesHere: [WikiNode] { store.nodes(in: area).filter { !$0.template } }

    private var subtitle: Text? {
        guard store.loadedOnce, !pagesHere.isEmpty else { return nil }
        return Text(Format.plural(pagesHere.count, "page"))
    }

    var body: some View {
        VStack(spacing: 0) {
            GlassHeaderBar(
                title: area.title,
                subtitle: subtitle,
                query: $query,
                searchPrompt: "Search pages",
                searchFocused: $searchFocused,
                menuLabel: "Folders and views",
                onMenu: { showScopes = true }
            ) {
                if env.session.canWrite, !pagesHere.isEmpty {
                    HeaderPrimaryButton(symbol: "plus", label: "New page") { adding = WikiNewPagePlace(area: area) }
                        .disabled(creating)
                }
            }
            content
        }
        .background(Theme.chrome.ignoresSafeArea())
        .toolbarVisibility(.hidden, for: .navigationBar)
        .onChange(of: query) { _, _ in search() }
        .onAppear(perform: appear)
        .onDisappear {
            env.realtime.unsubscribe(listener)
            listener = nil
        }
        .sheet(isPresented: $showScopes) {
            ScopeSheet()
                .presentationDetents([.medium, .large])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(item: $moving) { node in
            WikiMoveSheet(node: node)
                .presentationDetents([.medium, .large])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(item: $adding) { place in
            WikiNewPageSheet(place: place)
                .presentationDetents([.medium, .large])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        #if DEBUG
        .onChange(of: env.router.demoAction) { _, action in demo(action) }
        #endif
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if !store.loadedOnce && store.loading {
            ScrollView { SkeletonRows() }
                .scrollDisabled(true)
                .panelSurface()
        } else if let error = store.error, !store.loadedOnce {
            ErrorState(title: area == .pages ? "Couldn't load Pages" : "Couldn't load the wiki", message: error) { store.reload() }
                .frame(maxHeight: .infinity)
        } else if pagesHere.isEmpty && term.isEmpty {
            ScrollView { firstRun }
                .panelSurface()
                .refreshable { await store.refresh() }
        } else {
            List {
                if term.isEmpty { tree } else { results }
                Color.clear.frame(height: 90)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Theme.surface)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .panelSurface()
            .refreshable { await store.refresh() }
        }
    }

    @ViewBuilder
    private var tree: some View {
        let recent = Array(store.recent(in: area).filter { !$0.template }.prefix(5))
        if pagesHere.count > 3 {
            header("Recently edited")
            ForEach(recent) { node in
                Button { open(node.id) } label: {
                    WikiRecentRow(node: node, path: store.ancestors(of: node.id))
                }
                .buttonStyle(RowPressStyle())
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .listRowBackground(rowBackground(node.id))
                .contextMenu { menu(node) }
            }
        }
        let favorites = store.favoriteNodes(in: area)
        if !favorites.isEmpty {
            header("Favorites")
            ForEach(favorites) { node in
                WikiTreeRow(node: node, level: 0, subpages: 0, expanded: false, onToggle: {}, onOpen: { open(node.id) })
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(rowBackground(node.id))
                    .contextMenu { menu(node) }
            }
        }
        ForEach(store.teamspaces(in: area), id: \.self) { team in
            header(env.directory.teams.first { $0.id == team }?.name ?? "Teamspace")
            pages(in: .team(team))
            if env.session.canWrite {
                newPageRow("New page") { create(WikiPageCreate(space: "team", teamID: team, area: area)) }
            }
        }
        header("Workspace")
        pages(in: .workspace)
        if env.session.canWrite {
            newPageRow("New page") { create(WikiPageCreate(area: area)) }
        }
        if env.session.canWrite || !store.roots(of: .personal, in: area).isEmpty {
            header("Private")
            pages(in: .personal)
            if env.session.canWrite {
                newPageRow("New private page") { create(WikiPageCreate(space: "private", area: area)) }
            }
        }
        Color.clear.frame(height: 12)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Theme.surface)
        if env.session.canWrite {
            placeRow("Today\u{2019}s note", symbol: "calendar", picked: store.today(in: area).map { env.router.picked == .wikiPage($0.id) } ?? false) {
                Task { await WikiCreate.today(in: area, env: env) }
            }
            placeRow("Templates", symbol: "square.on.square", picked: env.router.picked == .wikiTemplates(area)) {
                env.router.pick(.wikiTemplates(area))
            }
        }
        placeRow("Graph", symbol: "point.3.connected.trianglepath.dotted", picked: env.router.picked == .wikiGraph(area)) { env.router.pick(.wikiGraph(area)) }
        placeRow("Tags", symbol: "number", picked: env.router.picked == .wikiTags(area)) { env.router.pick(.wikiTags(area)) }
        placeRow("Random page", symbol: "shuffle", picked: false) {
            if let node = WikiRandom.pick(in: area, besides: nil) {
                env.router.pick(.wikiPage(node.id))
            } else {
                env.toasts.show("There are no pages to pick from yet.", kind: .info)
            }
        }
        placeRow("Trash", symbol: "trash", picked: env.router.picked == .wikiTrash(area)) { env.router.pick(.wikiTrash(area)) }
    }

    /// One of the area's own views under its tree: today's note, templates, the trash.
    private func placeRow(_ title: String, symbol: String, picked: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 13, weight: .medium)).frame(width: 28)
                Text(title).font(ODFont.sans(15))
                Spacer()
                Chevron()
            }
            .foregroundStyle(Theme.fg3)
            .padding(.leading, 8)
            .padding(.trailing, 16)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(picked ? Theme.hover : Theme.surface)
    }

    /// The pages of one section, each with its subpages folded under it.
    @ViewBuilder
    private func pages(in section: WikiSection) -> some View {
        ForEach(store.outline(in: section, area: area)) { item in
            let subpages = store.treeChildren(of: item.node.id).count
            WikiTreeRow(node: item.node, level: item.level, subpages: subpages, expanded: store.expanded.contains(item.node.id), onToggle: {
                Haptics.selection()
                withAnimation(Motion.snappy) { store.toggle(item.node.id) }
            }, onOpen: { open(item.node.id) })
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(rowBackground(item.node.id))
            .contextMenu { menu(item.node) }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if env.session.canWrite {
                    if !item.node.isDatabase {
                        Button { create(WikiPageCreate(parentID: item.node.id)) } label: { Label("Add a subpage", systemImage: "plus") }
                            .tint(Tone.blue.solid)
                    }
                    Button { moving = item.node } label: { Label("Move", systemImage: "folder") }
                        .tint(Tone.violet.solid)
                }
            }
        }
        .motion(Motion.snappy, value: store.expanded)
    }

    private func newPageRow(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "plus").font(.system(size: 13, weight: .semibold)).frame(width: 28)
                Text(title).font(ODFont.sans(15))
                Spacer()
            }
            .foregroundStyle(Theme.fg3)
            .padding(.leading, 8)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .disabled(creating)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(Theme.surface)
    }

    @ViewBuilder
    private var results: some View {
        if hits.isEmpty {
            Group {
                if searching {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
                } else if let searchError {
                    EmptyState(symbol: "exclamationmark.triangle", title: "Couldn't search", message: searchError)
                } else {
                    EmptyState(symbol: "magnifyingglass", title: "No pages match \u{201C}\(term)\u{201D}", message: "Search looks at page titles and text.")
                }
            }
            .listRowSeparator(.hidden)
            .listRowBackground(Theme.surface)
        } else {
            // This area's pages first, then the other's under its name (contracts/pages.md "Search").
            let here = hits.filter { $0.area == area }
            let there = hits.filter { $0.area != area }
            ForEach(here) { hit in hitRow(hit) }
            if !there.isEmpty {
                header(area == .pages ? "In the wiki" : "In Pages")
                ForEach(there) { hit in hitRow(hit) }
            }
        }
    }

    private func hitRow(_ hit: WikiSearchHit) -> some View {
        Button { open(hit.id) } label: { WikiSearchRow(hit: hit) }
            .buttonStyle(RowPressStyle())
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(rowBackground(hit.id))
    }

    /// The page open beside the list stands out in it.
    private func rowBackground(_ id: String) -> Color {
        env.router.picked == .wikiPage(id) ? Theme.hover : Theme.surface
    }

    private func header(_ text: String) -> some View {
        SectionLabel(text)
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 4)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Theme.surface)
    }

    /// A new area: what it is for, the first page, and starter outlines.
    @ViewBuilder
    private var firstRun: some View {
        if area == .pages {
            pagesFirstRun
        } else {
            wikiFirstRun
        }
    }

    /// Pages before its first page: the ways to start (contracts/pages.md "Home").
    private var pagesFirstRun: some View {
        VStack(spacing: 8) {
            EmptyState(
                symbol: "doc.richtext",
                title: "Your workspace\u{2019}s own pages",
                message: env.session.canWrite
                    ? "Docs, notes, plans and projects, beside the wiki. Start with a page, a database or a canvas."
                    : "No one has added a page yet. Agents and admins can add the first one."
            )
            if env.session.canWrite {
                WikiStartPanel(area: area, busy: creating) { start in
                    switch start {
                    case let .kind(kind): create(WikiPageCreate(area: area, kind: kind == "page" ? nil : kind))
                    case .template: adding = WikiNewPagePlace(area: area, templates: true)
                    }
                }
                .padding(.horizontal, 20)
            }
            Button { env.router.pick(.wikiTrash(area)) } label: {
                Label("Open the trash", systemImage: "trash")
                    .font(ODFont.sans(14, weight: .medium))
                    .foregroundStyle(Theme.fg3)
                    .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .padding(.top, 8)
        }
        .padding(.bottom, 90)
    }

    /// The wiki before its first page: what it is for, the first page, and starter outlines.
    private var wikiFirstRun: some View {
        VStack(spacing: 8) {
            EmptyState(
                symbol: "book.pages",
                title: "Write down how your team works",
                message: env.session.canWrite
                    ? "The wiki holds your team's runbooks, policies and how-tos. Only members see it: customers, the help center and the chat widget never do."
                    : "Your team hasn't written any pages yet. Agents and admins can add the first one.",
                actionTitle: env.session.canWrite ? "Create the first page" : nil
            ) { create(WikiPageCreate(area: area)) }
            if env.session.canWrite {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Start from a template")
                    Panel {
                        ForEach(Array(WikiTemplate.all.enumerated()), id: \.element.id) { index, template in
                            if index > 0 { Hairline(inset: 52) }
                            Button {
                                create(WikiPageCreate(title: template.title, icon: template.icon, bodyHTML: template.bodyHTML, area: area))
                            } label: {
                                HStack(spacing: 12) {
                                    Text(template.icon).font(.system(size: 20)).frame(width: 28)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(template.title).font(ODFont.sans(15, weight: .medium)).foregroundStyle(Theme.fg)
                                        Text(template.hint).font(ODFont.sans(12.5)).foregroundStyle(Theme.fg3)
                                    }
                                    Spacer(minLength: 4)
                                    Chevron()
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 11)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(RowPressStyle())
                            .disabled(creating)
                        }
                    }
                }
                .padding(.horizontal, 20)
            }
            Button { env.router.pick(.wikiTrash(area)) } label: {
                Label("Open the trash", systemImage: "trash")
                    .font(ODFont.sans(14, weight: .medium))
                    .foregroundStyle(Theme.fg3)
                    .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .padding(.top, 8)
        }
        .padding(.bottom, 90)
    }

    @ViewBuilder
    private func menu(_ node: WikiNode) -> some View {
        Button { open(node.id) } label: { Label("Open", systemImage: "doc.text") }
        WikiPageMenu(
            node: node,
            onAddSubpage: { create(WikiPageCreate(parentID: node.id)) },
            onMove: { moving = node },
            onDelete: { WikiTrash.move(node, env: env) }
        )
    }

    // MARK: Actions

    private func appear() {
        store.attach(env)
        if listener == nil {
            listener = env.realtime.subscribe { update in WikiStore.shared.handle(update) }
        }
        if store.loadedOnce { store.reload() }
        #if DEBUG
        demo(env.router.demoAction)
        #endif
    }

    private func open(_ id: String) {
        env.router.pick(.wikiPage(id))
    }

    private func create(_ body: WikiPageCreate) {
        guard !creating else { return }
        creating = true
        Task {
            await WikiCreate.page(body, env: env)
            creating = false
        }
    }

    private func search() {
        searchTask?.cancel()
        let text = term
        guard !text.isEmpty else {
            hits = []
            searching = false
            searchError = nil
            return
        }
        searching = true
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            do {
                let found = try await store.search(text)
                guard !Task.isCancelled else { return }
                hits = found
                searchError = nil
            } catch {
                guard !error.isCancellation, !Task.isCancelled else { return }
                hits = []
                searchError = error.userMessage
            }
            searching = false
        }
    }

    #if DEBUG
    /// QA states: `/demo/wiki-expand`, `/demo/wiki-move`, `/demo/wiki-trash`, `/demo/wiki-new`.
    private func demo(_ action: String?) {
        guard let action, action.hasPrefix("wiki-") else { return }
        switch action {
        case "wiki-expand":
            store.expand(store.nodes(in: area).map(\.id))
        case "wiki-move":
            moving = store.children(of: nil).last(where: { $0.area == area })
        case "wiki-trash":
            env.router.pick(.wikiTrash(area))
        case "wiki-new":
            adding = WikiNewPagePlace(area: area)
        default:
            return
        }
        env.router.demoAction = nil
    }
    #endif
}
