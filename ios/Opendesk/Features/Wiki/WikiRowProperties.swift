import SwiftUI

/// A database row's values on its own page (contracts/wiki.md "Databases": rows open as
/// pages), under the title: each property as its views read it, and Edit values for agents.
struct WikiRowProperties: View {
    let rowID: String
    let databaseID: String

    @Environment(AppEnvironment.self) private var env
    @State private var schema: WikiDatabase?
    @State private var row: WikiDbRow?
    @State private var editing: WikiRowEdit?

    private var store: WikiStore { WikiStore.shared }

    var body: some View {
        Group {
            if let schema, let row {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Button { env.router.push(.wikiPage(databaseID)) } label: {
                            Label(store.node(databaseID)?.displayTitle ?? "Database", systemImage: "tablecells")
                                .font(ODFont.sans(12.5, weight: .medium))
                                .foregroundStyle(Theme.fg3)
                        }
                        .buttonStyle(.plain)
                        Spacer()
                        if env.session.canWrite {
                            Button("Edit values") { editing = WikiRowEdit(row: row) }
                                .buttonStyle(ChipButtonStyle())
                        }
                    }
                    Panel {
                        let properties = schema.properties.filter { $0.type != "title" }
                        ForEach(Array(properties.enumerated()), id: \.element.id) { index, property in
                            if index > 0 { Hairline(inset: 14) }
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Text(property.name)
                                    .font(ODFont.sans(13.5))
                                    .foregroundStyle(Theme.fg3)
                                    .frame(width: 110, alignment: .leading)
                                    .lineLimit(2)
                                if let text = WikiDbValue.text(property, row, people: { env.directory.member($0)?.user.name }) {
                                    WikiChipFlow(spacing: 4) { WikiDbValueChip(property: property, row: row, text: text) }
                                } else {
                                    Text("Empty").font(ODFont.sans(13.5)).foregroundStyle(Theme.fg4)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
        }
        .task(id: rowID) { await load() }
        .onChange(of: store.node(rowID)?.updatedAt) { _, _ in Task { await load() } }
        .sheet(item: $editing) { edit in
            if let schema {
                WikiRowSheet(databaseID: databaseID, schema: schema, edit: edit) { Task { await load() } }
                    .presentationDetents([.large])
                    .presentationCornerRadius(Theme.Radius.sheet)
            }
        }
    }

    private func load() async {
        guard let database = try? await store.page(databaseID), let rows = try? await store.database(rows: databaseID) else { return }
        schema = database.database
        row = rows.data.first { $0.id == rowID }
    }
}
