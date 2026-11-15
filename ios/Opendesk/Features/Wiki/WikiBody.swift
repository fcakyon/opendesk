import SwiftUI
import UIKit

/// A stored wiki body (contracts/wiki.md "Blocks") as the page's reader shows it, with
/// JavaScript off: the blocks the web app draws itself (files, media, bookmarks, embeds,
/// equations, subpages, databases, a view's tickets) become links and cards; links to
/// pages, tickets and contacts open their screens in the app; callouts, toggles, to-do
/// lists, columns, mentions, dates and colours are styled by `css`. Only for reading: the
/// editor and the saver always work on the stored body.
@MainActor
enum WikiBody {
    /// The scheme of the links the reader hands back to the app (`link(_:)`).
    static let scheme = "opendesk-wiki"

    enum Link: Equatable {
        case page(String)
        case ticket(String)
        case contact(String)
        /// An app path, such as `/views/<id>` (`DeepLink.parse(path:)`).
        case path(String)
    }

    /// What a tapped link of `readable(_:apiBase:title:)` opens, or nil for any other link.
    static func link(_ url: URL) -> Link? {
        guard url.scheme?.lowercased() == scheme, let host = url.host()?.lowercased() else { return nil }
        let path = url.path()
        let id = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        switch host {
        case "page": return id.isEmpty ? nil : .page(id)
        case "ticket": return id.isEmpty ? nil : .ticket(id)
        case "contact": return id.isEmpty ? nil : .contact(id)
        case "path": return path.isEmpty ? nil : .path(path + (url.query().map { "?" + $0 } ?? ""))
        default: return nil
        }
    }

    /// The body with its blocks made readable; `title` names a page by id (subpage blocks,
    /// databases), `apiBase` makes our attachments' addresses whole.
    static func readable(_ html: String, apiBase: URL?, title: (String) -> String?) -> String {
        let base = apiBase.map { $0.absoluteString.hasSuffix("/") ? String($0.absoluteString.dropLast()) : $0.absoluteString }
        func whole(_ src: String) -> String {
            guard src.hasPrefix("/"), !src.hasPrefix("//"), let base else { return src }
            return base + src
        }

        // Atoms: a div with nothing in it, its data in data-* (stored values stay escaped).
        var out = replace(#"<div\b([^>]*)>\s*</div>"#, in: html) { tag, a in
            switch a["data-type"] ?? "" {
            case "file", "video", "audio":
                let kind = a["data-type"] ?? "file"
                let mark = kind == "video" ? "🎬" : kind == "audio" ? "🎧" : "📎"
                let label = a["data-name"].flatMap { $0.isEmpty ? nil : $0 } ?? (kind == "video" ? "Video" : kind == "audio" ? "Audio" : "File")
                let size = a["data-size"].flatMap(Int.init).map { " <small>\(Format.bytes($0))</small>" } ?? ""
                guard let src = a["data-src"], !src.isEmpty else { return "<p class=\"od-file\">\(mark) \(label)\(size)</p>" }
                return "<p class=\"od-file\"><a href=\"\(whole(src))\">\(mark) \(label)</a>\(size)</p>"
            case "bookmark":
                guard let url = a["data-url"], !url.isEmpty else { return "" }
                let heading = a["data-title"].flatMap { $0.isEmpty ? nil : $0 } ?? url
                let about = a["data-description"].flatMap { $0.isEmpty ? nil : "<span>\($0)</span>" } ?? ""
                return "<a class=\"od-card\" href=\"\(url)\"><strong>\(heading)</strong>\(about)<small>\(url)</small></a>"
            case "embed":
                guard let url = a["data-url"], !url.isEmpty else { return "" }
                return "<a class=\"od-card\" href=\"\(url)\"><strong>Embedded content</strong><small>\(url)</small></a>"
            case "block-math":
                return "<pre class=\"od-math\"><code>\(a["data-latex"] ?? "")</code></pre>"
            case "subpage":
                guard let id = a["data-id"], !id.isEmpty else { return "" }
                let name = HTMLText.escape(title(id) ?? "Untitled")
                return "<a class=\"od-card\" href=\"\(scheme)://page/\(id)\"><strong>📄 \(name)</strong></a>"
            case "database":
                guard let id = a["data-id"], !id.isEmpty else { return "" }
                let name = HTMLText.escape(title(id) ?? "Untitled")
                return "<a class=\"od-card\" href=\"\(scheme)://page/\(id)\"><strong>▦ \(name)</strong><small>Database</small></a>"
            case "tickets":
                guard let id = a["data-id"], !id.isEmpty else { return "" }
                return "<a class=\"od-card\" href=\"\(scheme)://path/views/\(id)\"><strong>Tickets from a view</strong><small>Opens the view</small></a>"
            case "toc":
                return ""
            default:
                return tag
            }
        }
        out = replace(#"<span\b([^>]*)>\s*</span>"#, in: out) { tag, a in
            a["data-type"] == "inline-math" ? "<code class=\"od-math\">\(a["data-latex"] ?? "")</code>" : tag
        }
        out = replace(#"<a\b([^>]*)>"#, in: out) { tag, a in
            if let type = a["data-type"], ["page", "ticket", "contact"].contains(type), let id = a["data-id"], !id.isEmpty {
                return "<a class=\"od-ref\" href=\"\(scheme)://\(type)/\(id)\">"
            }
            if let href = a["href"], href.hasPrefix("/"), !href.hasPrefix("//") {
                return "<a href=\"\(scheme)://path\(href)\">"
            }
            return tag
        }
        if let base {
            out = replace(#"<img\b([^>]*)>"#, in: out) { tag, a in
                guard let src = a["src"], src.hasPrefix("/"), !src.hasPrefix("//") else { return tag }
                return tag.replacingOccurrences(of: "src=\"\(src)\"", with: "src=\"\(base)\(src)\"")
            }
        }
        return out
    }

    /// The databases the body shows, in order (`<div data-type="database" data-id>`).
    static func databaseIDs(in html: String) -> [String] {
        var ids: [String] = []
        _ = replace(#"<div\b([^>]*)>"#, in: html) { tag, a in
            if a["data-type"] == "database", let id = a["data-id"], !id.isEmpty, !ids.contains(id) { ids.append(id) }
            return tag
        }
        return ids
    }

    /// Nothing to read: no text, and no image, divider or block.
    static func isBlank(_ html: String) -> Bool {
        guard HTMLText.plain(from: html).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return !html.contains("<img") && !html.contains("<hr") && !html.contains("data-type=\"")
    }

    // MARK: Styles

    private static func hex(_ color: Color, dark: Bool) -> String {
        UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light)).cssHex
    }

    /// The blocks' look in the reader, in the app's ink and soft tones.
    static func css(dark: Bool) -> String {
        let fg = hex(Theme.fg, dark: dark)
        let fg2 = hex(Theme.fg2, dark: dark)
        let fg3 = hex(Theme.fg3, dark: dark)
        let line = hex(Theme.line, dark: dark)
        let sunken = hex(Theme.sunken, dark: dark)
        let hover = hex(Theme.hover, dark: dark)
        let blue = hex(Tone.blue.solid, dark: dark)
        let green = hex(Tone.green.solid, dark: dark)
        let yellow = hex(Tone.yellow.solid, dark: dark)
        // The web's block tones (contracts/wiki.md "Blocks") on the app's tones.
        let tones: [(String, Tone)] = [
            ("gray", .gray), ("brown", .amber), ("orange", .orange), ("yellow", .yellow), ("green", .green),
            ("blue", .blue), ("purple", .purple), ("pink", .pink), ("red", .red),
        ]
        let toned = tones.map { name, tone in
            let solid = hex(tone.solid, dark: dark)
            return """
            div[data-type="callout"][data-tone="\(name)"] { background: \(solid)1A; border-color: \(solid)2E; }
            [data-color="\(name)"] { color: \(solid); }
            [data-bg="\(name)"] { background: \(solid)1F; border-radius: 4px; }
            mark[data-bg="\(name)"] { background: \(solid)33; }
            """
        }.joined(separator: "\n")
        return """
        a.od-card { display: block; margin: 0.9em 0; padding: 0.7em 0.95em; background: \(sunken); border: 1px solid \(line); border-radius: 10px; color: \(fg2); }
        a.od-card strong { display: block; color: \(fg); font-weight: 600; }
        a.od-card span { display: block; margin-top: 0.2em; font-size: 0.92em; }
        a.od-card small { display: block; margin-top: 0.25em; color: \(fg3); font-size: 0.8em; overflow-wrap: anywhere; }
        p.od-file small { color: \(fg3); font-size: 0.82em; }
        code.od-math, pre.od-math code { color: \(fg); }
        a.od-ref { font-weight: 500; }
        span.mention, span[data-type="mention"] { color: \(blue); background: \(blue)1A; border-radius: 5px; padding: 0 0.25em; font-weight: 500; }
        time[data-type="date"] { color: \(fg); background: \(hover); border-radius: 5px; padding: 0 0.3em; }
        mark { background: \(yellow)33; color: inherit; border-radius: 3px; padding: 0 0.1em; }
        ul[data-type="taskList"] { list-style: none; padding-left: 0.1em; }
        li[data-type="taskItem"] { display: flex; gap: 0.5em; align-items: baseline; padding-left: 0; }
        li[data-type="taskItem"]::before { content: "☐"; color: \(fg3); flex: none; }
        li[data-type="taskItem"][data-checked="true"]::before { content: "☑"; color: \(green); }
        li[data-type="taskItem"] > * { flex: 1; margin: 0; }
        li[data-type="taskItem"][data-checked="true"] > * { color: \(fg3); text-decoration: line-through; }
        details { margin: 0.7em 0; }
        summary { color: \(fg); font-weight: 500; }
        summary > * { display: inline; margin: 0; }
        div[data-type="detailsContent"] { padding: 0.35em 0 0 1.15em; }
        div[data-type="callout"] { position: relative; margin: 1em 0; padding: 0.75em 1em 0.75em 2.6em; background: \(hover); border: 1px solid \(line); border-radius: 10px; color: \(fg); }
        div[data-type="callout"]::before { content: attr(data-icon); position: absolute; left: 0.85em; top: 0.72em; }
        div[data-type="callout"] > :last-child { margin-bottom: 0; }
        div[data-type="columns"] { margin: 0.6em 0; }
        div[data-type="column"] { margin: 0 0 0.6em; }
        \(toned)
        """
    }

    // MARK: Matching

    /// Replaces every match of `pattern` (its first group: the tag's attributes) with what
    /// `transform` answers for the whole match and its attributes.
    private static func replace(_ pattern: String, in html: String, _ transform: (String, [String: String]) -> String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return html }
        let text = html as NSString
        var out = ""
        var last = 0
        for match in regex.matches(in: html, range: NSRange(location: 0, length: text.length)) {
            out += text.substring(with: NSRange(location: last, length: match.range.location - last))
            let group = match.numberOfRanges > 1 ? match.range(at: 1) : NSRange(location: NSNotFound, length: 0)
            let raw = group.location == NSNotFound ? "" : text.substring(with: group)
            out += transform(text.substring(with: match.range), attributes(raw))
            last = match.range.location + match.range.length
        }
        out += text.substring(from: last)
        return out
    }

    /// `name="value"` pairs of a tag (the server writes every value in double quotes, escaped).
    private static func attributes(_ raw: String) -> [String: String] {
        guard !raw.isEmpty, let regex = try? NSRegularExpression(pattern: #"([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)""#) else { return [:] }
        let text = raw as NSString
        var out: [String: String] = [:]
        for match in regex.matches(in: raw, range: NSRange(location: 0, length: text.length)) {
            out[text.substring(with: match.range(at: 1)).lowercased()] = text.substring(with: match.range(at: 2))
        }
        return out
    }
}
