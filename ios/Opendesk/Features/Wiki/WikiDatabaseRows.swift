import SwiftUI

/// A database (contracts/wiki.md "Databases"): its saved views, each drawn the phone's way
/// (tables and lists as rows, boards as columns that scroll sideways, galleries as cards,
/// calendars and timelines as an agenda, charts as bars, forms as a form), with the view's
/// filter, sorts and groups applied (`WikiDbQuery`). Agents add rows, change their values and
/// move them to the trash; a row opens as its page.
struct WikiDatabaseRows: View {
    let databaseID: String
    /// Its properties when the page at hand is the database; else read from its page.
    var database: WikiDatabase?
    /// A heading for a database shown inside another page.
    var title: String?

    @Environment(AppEnvironment.self) private var env
    @State private var rows: [WikiDbRow] = []
    @State private var templates: [WikiNode] = []
    @State private var schema: WikiDatabase?
    @State private var viewID: String?
    @State private var search = ""
    @State private var searching = false
    @State private var loaded = false
    @State private var error: String?
    @State private var editing: WikiRowEdit?

    private var store: WikiStore { WikiStore.shared }
    private var current: WikiDatabase { database ?? schema ?? WikiDatabase(properties: []) }
    private var view: WikiDbView? { current.views.first { $0.id == viewID } ?? current.views.first }
    private var shown: [WikiDbRow] { WikiDbQuery.rows(rows, view: view, schema: current, search: search) }
    private var canWrite: Bool { env.session.canWrite }

    /// What a row shows besides its title: the view's order, without its hidden properties.
    private var columns: [WikiDbProperty] {
        let all = current.properties.filter { $0.type != "title" }
        let order = view?.order ?? []
        let hidden = Set(view?.hidden ?? [])
        let ordered = order.compactMap { id in all.first { $0.id == id } } + all.filter { !order.contains($0.id) }
        return ordered.filter { !hidden.contains($0.id) }
    }

    /// The rows' order of the tree as the store knows it, so a teammate's change reloads them.
    private var treeMark: String {
        store.children(of: databaseID).map { "\($0.id):\($0.version):\($0.updatedAt.timeIntervalSince1970)" }.joined(separator: ",")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if current.views.count > 1 { viewStrip }
            if searching {
                ODSearchLine(text: $search)
            }
            content
        }
        .task(id: databaseID) { await load() }
        .onChange(of: store.node(databaseID)?.version) { _, _ in Task { await load() } }
        .onChange(of: treeMark) { _, _ in Task { await load() } }
        .sheet(item: $editing) { edit in
            WikiRowSheet(databaseID: databaseID, schema: current, edit: edit, templates: edit.row == nil ? templates : []) {
                Task { await load() }
            }
            .presentationDetents([.large])
            .presentationCornerRadius(Theme.Radius.sheet)
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: view?.symbol ?? "tablecells").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.fg3)
            Text(title ?? view?.name ?? "Rows")
                .font(ODFont.sans(12.5, weight: .medium))
                .foregroundStyle(Theme.fg3)
                .lineLimit(1)
            if loaded, !rows.isEmpty {
                Text("\(shown.count)").font(ODFont.mono(11.5)).foregroundStyle(Theme.fg4)
            }
            Spacer(minLength: 6)
            Button {
                withAnimation(Motion.snappy) { searching.toggle() }
                if !searching { search = "" }
            } label: {
                Image(systemName: "magnifyingglass").font(.system(size: 13, weight: .medium)).frame(width: 30, height: 28)
            }
            .buttonStyle(.plain)
            .foregroundStyle(searching ? Theme.fg : Theme.fg3)
            .accessibilityLabel(searching ? "Stop searching the rows" : "Search the rows")
            if canWrite, view?.type != "form" {
                Button { editing = WikiRowEdit(row: nil) } label: {
                    Label("New", systemImage: "plus").font(ODFont.sans(13, weight: .medium))
                }
                .buttonStyle(ChipButtonStyle())
                .accessibilityLabel("New row")
            }
        }
    }

    private var viewStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(current.views) { item in
                    let on = item.id == view?.id
                    Button {
                        Haptics.selection()
                        viewID = item.id
                    } label: {
                        Label(item.name.isEmpty ? "View" : item.name, systemImage: item.symbol)
                    }
                    .buttonStyle(ChipButtonStyle(filled: on))
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if !loaded && error == nil {
            Panel { ProgressView().frame(maxWidth: .infinity).padding(.vertical, 18) }
        } else if let error, rows.isEmpty {
            Panel { Notice(text: error, tone: .red, symbol: "exclamationmark.triangle").padding(12) }
        } else {
            switch view?.type {
            case "board": board
            case "gallery": gallery
            case "calendar", "timeline": agenda
            case "chart": chart
            case "form": form
            default: list
            }
        }
    }

    private var emptyLine: some View {
        Text(rows.isEmpty ? (canWrite ? "No rows yet. Add one with New." : "No rows yet.") : "No row matches this view.")
            .font(ODFont.sans(14))
            .foregroundStyle(Theme.fg3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
    }

    @ViewBuilder
    private var list: some View {
        let visible = shown
        if let group = current.property(view?.groupBy) {
            ForEach(WikiDbQuery.groups(visible, by: group, hideEmpty: true, people: name)) { section in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        TonePill(text: section.title, tone: section.tone)
                        Text("\(section.rows.count)").font(ODFont.mono(11.5)).foregroundStyle(Theme.fg4)
                    }
                    rowsPanel(section.rows)
                }
            }
            if visible.isEmpty { Panel { emptyLine } }
        } else {
            rowsPanel(visible)
        }
    }

    private func rowsPanel(_ list: [WikiDbRow]) -> some View {
        Panel {
            if list.isEmpty {
                emptyLine
            } else {
                ForEach(Array(list.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Hairline(inset: 44) }
                    Button { open(row) } label: { line(row) }
                        .buttonStyle(RowPressStyle())
                        .contextMenu { rowMenu(row) }
                }
            }
        }
    }

    private func line(_ row: WikiDbRow) -> some View {
        let values = columns.prefix(3).filter { valueText($0, row) != nil }
        return HStack(alignment: .top, spacing: 10) {
            WikiPageIcon(icon: row.node.icon, size: 16)
            VStack(alignment: .leading, spacing: 4) {
                rowTitle(row)
                if !values.isEmpty {
                    WikiChipFlow(spacing: 4) {
                        ForEach(Array(values)) { property in
                            WikiDbValueChip(property: property, row: row, text: valueText(property, row) ?? "")
                        }
                    }
                }
            }
            Spacer(minLength: 6)
            Chevron()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func rowTitle(_ row: WikiDbRow) -> some View {
        Text(row.node.displayTitle)
            .font(ODFont.sans(15))
            .foregroundStyle(row.node.title.trimmingCharacters(in: .whitespaces).isEmpty ? Theme.fg3 : Theme.fg)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
    }

    @ViewBuilder
    private func rowMenu(_ row: WikiDbRow) -> some View {
        Button { open(row) } label: { Label("Open", systemImage: "doc.text") }
        if canWrite {
            Button { editing = WikiRowEdit(row: row) } label: { Label("Edit values", systemImage: "slider.horizontal.3") }
            Divider()
            Button(role: .destructive) { trash(row) } label: { Label("Move to trash", systemImage: "trash") }
        }
    }

    // MARK: Board

    @ViewBuilder
    private var board: some View {
        if let group = current.property(view?.groupBy) ?? current.properties.first(where: { ["status", "select"].contains($0.type) }) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 10) {
                    ForEach(WikiDbQuery.groups(shown, by: group, hideEmpty: view?.hideEmptyGroups ?? false, people: name)) { column in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 6) {
                                TonePill(text: column.title, tone: column.tone)
                                Text("\(column.rows.count)").font(ODFont.mono(11.5)).foregroundStyle(Theme.fg4)
                                Spacer(minLength: 0)
                                if canWrite, ["select", "status", "checkbox"].contains(group.type) {
                                    Button { editing = WikiRowEdit(row: nil, prefill: prefill(group, column.id)) } label: {
                                        Image(systemName: "plus").font(.system(size: 12, weight: .semibold)).frame(width: 26, height: 24)
                                    }
                                    .buttonStyle(.plain)
                                    .foregroundStyle(Theme.fg3)
                                    .accessibilityLabel("New row in \(column.title)")
                                }
                            }
                            ForEach(column.rows) { row in
                                Button { open(row) } label: { card(row, skipping: group.id) }
                                    .buttonStyle(TapScaleStyle())
                                    .contextMenu {
                                        rowMenu(row)
                                        if canWrite, ["select", "status"].contains(group.type) {
                                            Menu("Move to") {
                                                ForEach(group.options) { option in
                                                    Button(option.name) { setValue(row, group, .string(option.id)) }
                                                }
                                            }
                                        }
                                    }
                            }
                        }
                        .padding(8)
                        .frame(width: 252, alignment: .topLeading)
                        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                    }
                }
            }
        } else {
            list
        }
    }

    private func card(_ row: WikiDbRow, skipping: String? = nil) -> some View {
        let values = columns.filter { $0.id != skipping && valueText($0, row) != nil }.prefix(3)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 6) {
                if !row.node.icon.isEmpty { Text(row.node.icon) }
                rowTitle(row)
                Spacer(minLength: 0)
            }
            if !values.isEmpty {
                WikiChipFlow(spacing: 4) {
                    ForEach(Array(values)) { property in
                        WikiDbValueChip(property: property, row: row, text: valueText(property, row) ?? "")
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
        .contentShape(Rectangle())
    }

    // MARK: Gallery

    @ViewBuilder
    private var gallery: some View {
        let visible = shown
        if visible.isEmpty {
            Panel { emptyLine }
        } else {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(visible) { row in
                    Button { open(row) } label: {
                        VStack(alignment: .leading, spacing: 0) {
                            WikiCoverStrip(cover: row.cover, icon: row.node.icon, height: 70, apiBase: env.session.instance.apiURL)
                            VStack(alignment: .leading, spacing: 4) {
                                rowTitle(row)
                                if !row.excerpt.isEmpty {
                                    Text(row.excerpt)
                                        .font(ODFont.sans(12))
                                        .foregroundStyle(Theme.fg3)
                                        .lineLimit(3)
                                        .multilineTextAlignment(.leading)
                                }
                            }
                            .padding(10)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
                    }
                    .buttonStyle(TapScaleStyle())
                    .contextMenu { rowMenu(row) }
                }
            }
        }
    }

    // MARK: Calendar and timeline

    @ViewBuilder
    private var agenda: some View {
        let property = current.property(view?.dateProperty) ?? current.properties.first { $0.type == "date" }
        if let property {
            let visible = shown
            let dated = visible.compactMap { row in WikiDbValue.dates(property, row).map { (row, $0) } }
            let days = Dictionary(grouping: dated) { Calendar.current.startOfDay(for: $0.1.start) }
            let undated = visible.filter { WikiDbValue.dates(property, $0) == nil }
            if visible.isEmpty { Panel { emptyLine } }
            ForEach(days.keys.sorted(), id: \.self) { day in
                VStack(alignment: .leading, spacing: 6) {
                    Text(Format.dayLabel(day))
                        .font(ODFont.sans(12.5, weight: .semibold))
                        .foregroundStyle(Calendar.current.isDateInToday(day) ? Tone.blue.text : Theme.fg2)
                    rowsPanel((days[day] ?? []).map(\.0))
                }
            }
            if !undated.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel("No \(property.name)")
                    rowsPanel(undated)
                }
            }
        } else {
            list
        }
    }

    // MARK: Chart

    @ViewBuilder
    private var chart: some View {
        let x = current.property(view?.settings?["chart"]?["x"]?.string) ?? current.properties.first { ["select", "status"].contains($0.type) }
        if let x {
            let groups = WikiDbQuery.groups(shown, by: x, hideEmpty: true, people: name)
            let most = max(1, groups.map(\.rows.count).max() ?? 1)
            Panel(padding: 12) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Rows by \(x.name)").font(ODFont.sans(12.5, weight: .medium)).foregroundStyle(Theme.fg3)
                    ForEach(groups) { group in
                        HStack(spacing: 8) {
                            Text(group.title).font(ODFont.sans(13)).foregroundStyle(Theme.fg2).frame(width: 96, alignment: .leading).lineLimit(1)
                            GeometryReader { proxy in
                                RoundedRectangle(cornerRadius: 3, style: .continuous)
                                    .fill(group.tone == .gray ? Tone.blue.solid : group.tone.solid)
                                    .frame(width: max(4, proxy.size.width * CGFloat(group.rows.count) / CGFloat(most)))
                            }
                            .frame(height: 14)
                            Text("\(group.rows.count)").font(ODFont.mono(12)).foregroundStyle(Theme.fg3).frame(minWidth: 24, alignment: .trailing)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        } else {
            list
        }
    }

    // MARK: Form

    @ViewBuilder
    private var form: some View {
        let settings = view?.settings?["form"]
        Panel(padding: 14) {
            VStack(alignment: .leading, spacing: 8) {
                Text(settings?["title"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? view?.name ?? "Form")
                    .font(ODFont.sans(16, weight: .semibold))
                    .foregroundStyle(Theme.fg)
                if let description = settings?["description"]?.string, !description.isEmpty {
                    Text(description).font(ODFont.sans(13.5)).foregroundStyle(Theme.fg2).fixedSize(horizontal: false, vertical: true)
                }
                if canWrite {
                    Button { editing = WikiRowEdit(row: nil, form: settings) } label: { Text("Fill in the form") }
                        .buttonStyle(InkButtonStyle(fullWidth: false, height: 36))
                        .padding(.top, 4)
                } else {
                    Text("Viewers read the form; agents send it.").font(ODFont.footnote).foregroundStyle(Theme.fg3)
                }
            }
        }
    }

    // MARK: Values

    private func name(_ id: String) -> String? { env.directory.member(id)?.user.name }

    private func valueText(_ property: WikiDbProperty, _ row: WikiDbRow) -> String? {
        WikiDbValue.text(property, row, people: name)
    }

    /// The value a new row in a board column starts with.
    private func prefill(_ property: WikiDbProperty, _ column: String) -> [String: JSONValue] {
        switch property.type {
        case "checkbox": return [property.id: .bool(column == "true")]
        default: return column.isEmpty ? [:] : [property.id: .string(column)]
        }
    }

    // MARK: Actions

    private func open(_ row: WikiDbRow) {
        env.router.push(.wikiPage(row.id))
    }

    private func setValue(_ row: WikiDbRow, _ property: WikiDbProperty, _ value: JSONValue) {
        guard let index = rows.firstIndex(where: { $0.id == row.id }) else { return }
        let before = rows[index]
        rows[index].props[property.id] = value
        Haptics.selection()
        Task {
            do {
                _ = try await store.setLook(row.id, WikiLookPatch(props: [property.id: value]))
            } catch {
                if let at = rows.firstIndex(where: { $0.id == row.id }) { rows[at] = before }
                env.toasts.error(error)
            }
        }
    }

    private func trash(_ row: WikiDbRow) {
        rows.removeAll { $0.id == row.id }
        WikiTrash.move(row.node, env: env)
    }

    private func load() async {
        do {
            if database == nil {
                schema = try await store.page(databaseID).database
            }
            let answer = try await store.database(rows: databaseID)
            rows = answer.data
            templates = answer.templates
            error = nil
        } catch {
            guard !error.isCancellation else { return }
            self.error = error.userMessage
        }
        loaded = true
    }
}

/// A row being added or changed: nil `row` adds one, with `prefill` values (a board column)
/// or the questions of a form view.
struct WikiRowEdit: Identifiable {
    let id = UUID()
    var row: WikiDbRow?
    var prefill: [String: JSONValue] = [:]
    /// A form view's `settings.form`: the properties it asks, in order.
    var form: JSONValue?
}

/// One value of a row as a small chip: options in their colour, the rest as plain text.
struct WikiDbValueChip: View {
    let property: WikiDbProperty
    let row: WikiDbRow
    let text: String

    var body: some View {
        switch property.type {
        case "select", "status":
            TonePill(text: text, tone: property.option(row.props[property.id]?.string)?.tone ?? .gray, height: 18)
        case "multi_select":
            ForEach(WikiDbValue.ids(property, row), id: \.self) { id in
                TonePill(text: property.option(id)?.name ?? id, tone: property.option(id)?.tone ?? .gray, height: 18)
            }
        case "checkbox":
            Label(property.name, systemImage: row.props[property.id]?.bool == true ? "checkmark.square.fill" : "square")
                .font(ODFont.sans(11.5))
                .foregroundStyle(Theme.fg3)
                .labelStyle(.titleAndIcon)
        default:
            Text(text)
                .font(ODFont.sans(11.5))
                .foregroundStyle(Theme.fg3)
                .lineLimit(1)
                .padding(.horizontal, 6)
                .frame(height: 18)
                .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.Radius.pill, style: .continuous))
        }
    }
}

/// Chips that wrap onto the next line.
struct WikiChipFlow: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        var widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                y += line + spacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

/// A search field on one line, for the rows of a database.
struct ODSearchLine: View {
    @Binding var text: String
    var prompt = "Search the rows"
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundStyle(Theme.fg3)
            TextField(prompt, text: $text)
                .font(ODFont.sans(14.5))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused)
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.fg4) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 36)
        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        .onAppear { focused = true }
    }
}
