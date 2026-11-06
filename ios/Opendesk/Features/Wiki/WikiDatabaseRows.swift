import SwiftUI

/// A database's rows as a plain list (contracts/wiki.md "Databases"): each row's title and
/// its first two values as text; a row opens as its page. Views, filters and editing the
/// values are the web app's.
struct WikiDatabaseRows: View {
    let databaseID: String
    /// Its properties when the page at hand is the database; else read from its page.
    var database: WikiDatabase?
    /// A heading for a database shown inside another page.
    var title: String?

    @Environment(AppEnvironment.self) private var env
    @State private var rows: [WikiDbRow] = []
    @State private var schema: WikiDatabase?
    @State private var loaded = false
    @State private var error: String?

    private var store: WikiStore { WikiStore.shared }

    /// The first two properties a row shows besides its title (computed ones are the web's).
    private var shown: [WikiDbProperty] {
        let properties = (database ?? schema)?.properties ?? []
        return Array(properties.filter { !["title", "formula", "rollup"].contains($0.type) }.prefix(2))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "tablecells").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.fg3)
                SectionLabel(title ?? "Rows")
                if loaded, !rows.isEmpty {
                    Text("\(rows.count)").font(ODFont.mono(11.5)).foregroundStyle(Theme.fg4)
                }
            }
            Panel {
                if !loaded && error == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 18)
                } else if let error, rows.isEmpty {
                    Notice(text: error, tone: .red, symbol: "exclamationmark.triangle")
                        .padding(12)
                } else if rows.isEmpty {
                    Text("No rows yet. Add them on the web.")
                        .font(ODFont.sans(14))
                        .foregroundStyle(Theme.fg3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                } else {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        if index > 0 { Hairline(inset: 44) }
                        Button { env.router.push(.wikiPage(row.id)) } label: { line(row) }
                            .buttonStyle(RowPressStyle())
                    }
                }
            }
            Text("Views, filters and values are edited on the web.")
                .font(ODFont.sans(11.5))
                .foregroundStyle(Theme.fg4)
        }
        .task(id: databaseID) { await load() }
        .onChange(of: store.node(databaseID)?.version) { _, _ in Task { await load() } }
    }

    private func line(_ row: WikiDbRow) -> some View {
        let values = shown.compactMap { property in text(property, row).map { "\(property.name): \($0)" } }
        return HStack(alignment: .top, spacing: 10) {
            WikiPageIcon(icon: row.node.icon, size: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.node.displayTitle)
                    .font(ODFont.sans(15))
                    .foregroundStyle(row.node.title.trimmingCharacters(in: .whitespaces).isEmpty ? Theme.fg3 : Theme.fg)
                    .lineLimit(1)
                if !values.isEmpty {
                    Text(values.joined(separator: " · "))
                        .font(ODFont.sans(12.5))
                        .foregroundStyle(Theme.fg3)
                        .lineLimit(2)
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

    /// A value as text (contracts/wiki.md "Databases", the stored values), nil when empty.
    private func text(_ property: WikiDbProperty, _ row: WikiDbRow) -> String? {
        switch property.type {
        case "created_time": return Format.shortDate(row.createdAt)
        case "edited_time": return Format.shortDate(row.node.updatedAt)
        case "created_by": return row.createdBy?.displayName
        case "edited_by": return row.updatedBy?.displayName
        default: break
        }
        guard let value = row.props[property.id], !value.isNull else { return nil }
        let found: String?
        switch property.type {
        case "checkbox":
            found = value.bool.map { $0 ? "Yes" : "No" }
        case "select", "status":
            found = value.string.map { id in property.options.first { $0.id == id }?.name ?? id }
        case "multi_select":
            let names = (value.array ?? []).compactMap(\.string).map { id in property.options.first { $0.id == id }?.name ?? id }
            found = names.isEmpty ? nil : names.joined(separator: ", ")
        case "date":
            let start = value["start"]?.string ?? value.string
            let end = value["end"]?.string
            found = start.map { start in end.map { "\(start) to \($0)" } ?? start }
        case "person":
            let names = (value.array ?? []).compactMap(\.string).map { env.directory.member($0)?.user.name ?? "Someone" }
            found = names.isEmpty ? nil : names.joined(separator: ", ")
        case "relation":
            let count = value.array?.count ?? 0
            found = count == 0 ? nil : Format.plural(count, "page")
        case "ticket":
            let count = value.array?.count ?? 0
            found = count == 0 ? nil : Format.plural(count, "ticket")
        case "files":
            let names = (value.array ?? []).compactMap { $0["name"]?.string ?? $0["url"]?.string }
            found = names.isEmpty ? nil : names.joined(separator: ", ")
        case "unique_id":
            found = value.displayText.map { (property.prefix.map { $0.isEmpty ? "" : $0 + "-" } ?? "") + $0 }
        default:
            found = value.displayText
        }
        guard let answer = found, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return answer
    }

    private func load() async {
        do {
            if database == nil, schema == nil {
                schema = try await store.page(databaseID).database
            }
            rows = try await store.rows(of: databaseID)
            error = nil
        } catch {
            guard !error.isCancellation else { return }
            self.error = error.userMessage
        }
        loaded = true
    }
}
