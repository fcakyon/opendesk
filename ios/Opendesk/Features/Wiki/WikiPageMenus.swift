import SwiftUI

/// A tag whose pages a sheet lists ("" for every tag of the area).
struct WikiTagTarget: Identifiable {
    let tag: String
    var area: WikiArea = .wiki
    var id: String { "\(area.rawValue):\(tag)" }
}

/// Which of a page's tools is open: its settings, its panel, tags, publishing, Ollie writing,
/// the full-screen canvas, and an export waiting for the share sheet.
struct WikiPageToolsState {
    var settings = false
    var info = false
    var publish = false
    var write = false
    var canvas = false
    var tag: WikiTagTarget?
    var export: WikiExportFile?
    var exporting = false

    /// The page's font in the reader (contracts/wiki.md "Page settings").
    static func fontCSS(_ font: String) -> String {
        switch font {
        case "serif": "body { font-family: ui-serif, Georgia, serif; }"
        case "mono": "body { font-family: ui-monospace, \"Geist Mono\", Menlo, monospace; }"
        default: ""
        }
    }
}

/// The page menu's tools beyond the tree's own (`WikiPageMenu`): settings, the page's panel,
/// tags, a random page, Ollie writing, publishing and export.
struct WikiPageMoreMenu: View {
    let page: WikiPage
    let canEdit: Bool
    @Binding var tools: WikiPageToolsState

    @Environment(AppEnvironment.self) private var env

    /// Templates, the journal and databases are not articles (contracts/wiki.md "Publishing").
    private var publishable: Bool { env.session.canWrite && !page.template && !page.journal && !page.isDatabase && !page.isCanvas }

    var body: some View {
        Divider()
        Button { tools.settings = true } label: { Label("Page settings", systemImage: "paintbrush") }
        Button { tools.info = true } label: { Label("About this page", systemImage: "info.circle") }
        Button { tools.tag = WikiTagTarget(tag: "", area: page.area) } label: { Label("Tags", systemImage: "number") }
        Button { env.router.push(.wikiGraph(page.area)) } label: { Label("Graph", systemImage: "point.3.connected.trianglepath.dotted") }
        Button { openRandom() } label: { Label("Random page", systemImage: "shuffle") }
        if canEdit, env.directory.ai.enabled, !page.isDatabase, !page.isCanvas {
            Button { tools.write = true } label: { Label("Ask Ollie", systemImage: "sparkles") }
        }
        if publishable {
            Button { tools.publish = true } label: { Label("Publish to help center", systemImage: "book.closed") }
        }
        Menu {
            Button { export("markdown", subpages: false) } label: { Label(page.isCanvas ? "JSON Canvas" : "Markdown", systemImage: "doc.plaintext") }
            Button { export("html", subpages: false) } label: { Label("HTML", systemImage: "chevron.left.forwardslash.chevron.right") }
            if !page.children.isEmpty || !WikiStore.shared.children(of: page.id).isEmpty {
                Button { export("markdown", subpages: true) } label: { Label("Markdown with subpages", systemImage: "doc.zipper") }
                Button { export("html", subpages: true) } label: { Label("HTML with subpages", systemImage: "doc.zipper") }
            }
        } label: {
            Label("Export", systemImage: "square.and.arrow.up.on.square")
        }
        .disabled(tools.exporting)
    }

    private func openRandom() {
        guard let node = WikiRandom.pick(in: page.area, besides: page.id) else {
            env.toasts.show("There's no other page yet.", kind: .info)
            return
        }
        Haptics.selection()
        env.router.push(.wikiPage(node.id))
    }

    private func export(_ format: String, subpages: Bool) {
        tools.exporting = true
        env.toasts.show("Exporting…", kind: .info)
        Task {
            let file = await WikiExport.file(page: page, format: format, subpages: subpages, env: env)
            tools.exporting = false
            tools.export = file
        }
    }
}

/// The sheets of a page's tools, on the page screen.
struct WikiPageToolsSheets: ViewModifier {
    @Binding var tools: WikiPageToolsState
    let saver: WikiSaver?
    let onBody: (String, Bool) -> Void

    @Environment(AppEnvironment.self) private var env

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $tools.settings) {
                if let saver {
                    WikiPageSettingsSheet(page: saver.page) { saver.takeLook($0) }
                        .presentationDetents([.large])
                        .presentationCornerRadius(Theme.Radius.sheet)
                }
            }
            .sheet(isPresented: $tools.info) {
                if let saver {
                    WikiPageInfoSheet(page: saver.page, body: saver.draft.body, onOpen: { id in
                        env.router.push(.wikiPage(id))
                    }, onTag: { tag in
                        Task {
                            try? await Task.sleep(for: .milliseconds(450))
                            tools.tag = WikiTagTarget(tag: tag, area: saver.page.area)
                        }
                    })
                    .presentationDetents([.large])
                    .presentationCornerRadius(Theme.Radius.sheet)
                }
            }
            .sheet(item: $tools.tag) { target in
                WikiTagsSheet(area: target.area, tag: target.tag.isEmpty ? nil : target.tag) { id in env.router.push(.wikiPage(id)) }
                    .presentationDetents([.medium, .large])
                    .presentationCornerRadius(Theme.Radius.sheet)
            }
            .sheet(isPresented: $tools.publish) {
                if let saver {
                    WikiPublishSheet(page: saver.page)
                        .presentationDetents([.medium, .large])
                        .presentationCornerRadius(Theme.Radius.sheet)
                }
            }
            .sheet(isPresented: $tools.write) {
                if let saver {
                    WikiWriteSheet(title: saver.draft.title, bodyHTML: saver.draft.body, onApply: onBody)
                        .presentationDetents([.large])
                        .presentationCornerRadius(Theme.Radius.sheet)
                }
            }
            .sheet(item: $tools.export) { file in
                WikiShareSheet(url: file.url)
                    .presentationDetents([.medium, .large])
            }
            .fullScreenCover(isPresented: $tools.canvas) {
                if let saver {
                    WikiCanvasScreen(title: saver.page.displayTitle, canvas: saver.page.extras.canvas ?? WikiCanvas())
                        .environment(env)
                }
            }
    }
}

/// A page's own keyboard shortcuts with a hardware keyboard (`ShortcutCommand.Group.page`), on the
/// person's keys: a key alone answers only while nothing is being typed.
struct WikiPageShortcutKeys: View {
    /// The page is in its editor.
    let editing: Bool
    let run: (String) -> Void

    @State private var typing = false

    private var store: ShortcutsStore { .shared }

    private struct Entry: Identifiable {
        var id: String
        var title: String
        var key: KeyEquivalent
        var modifiers: EventModifiers
    }

    private var entries: [Entry] {
        var out: [Entry] = []
        for command in ShortcutRegistry.commands where command.group == .page {
            guard let binding = store.binding(command), let steps = ShortcutBinding.steps(binding), steps.count == 1,
                  let step = steps.first, let key = step.equivalent else { continue }
            if editing || typing, step.mods.isEmpty || step.mods == ["shift"] { continue }
            out.append(Entry(id: command.id, title: command.title, key: key, modifiers: step.modifiers))
        }
        return out
    }

    var body: some View {
        ZStack {
            if !store.recording {
                ForEach(entries) { entry in
                    Button(entry.title) { run(entry.id) }
                        .keyboardShortcut(entry.key, modifiers: entry.modifiers)
                }
            }
        }
        .frame(width: 0, height: 0)
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidBeginEditingNotification)) { _ in typing = true }
        .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidEndEditingNotification)) { _ in typing = false }
        .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidBeginEditingNotification)) { _ in typing = true }
        .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidEndEditingNotification)) { _ in typing = false }
    }
}

extension View {
    func wikiPageTools(_ tools: Binding<WikiPageToolsState>, saver: WikiSaver?, onBody: @escaping (String, Bool) -> Void) -> some View {
        modifier(WikiPageToolsSheets(tools: tools, saver: saver, onBody: onBody))
    }
}
