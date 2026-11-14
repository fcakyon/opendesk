import Foundation

/// A database row's values read as the views read them (web `lib/wiki/db/values.ts`): text,
/// numbers, dates and lists of ids, by property type. Computed values the API sends nothing for
/// (formulas, rollups) read as empty.
@MainActor
enum WikiDbValue {
    /// The stored value of `property` on `row`, nil when empty.
    static func raw(_ property: WikiDbProperty, _ row: WikiDbRow) -> JSONValue? {
        guard let value = row.props[property.id], !value.isNull else { return nil }
        if let text = value.string, text.isEmpty { return nil }
        if let list = value.array, list.isEmpty { return nil }
        return value
    }

    /// The ids a list-like value holds (multi-select, person, relation, ticket; a select's one id).
    static func ids(_ property: WikiDbProperty, _ row: WikiDbRow) -> [String] {
        switch property.type {
        case "created_by": return row.createdBy.map { [$0.id] } ?? []
        case "edited_by": return row.updatedBy.map { [$0.id] } ?? []
        default: break
        }
        guard let value = raw(property, row) else { return [] }
        if let one = value.string { return [one] }
        return (value.array ?? []).compactMap { $0.string ?? $0["url"]?.string }
    }

    static func number(_ property: WikiDbProperty, _ row: WikiDbRow) -> Double? {
        if property.type == "unique_id" { return row.props[property.id]?.double }
        return raw(property, row)?.double
    }

    /// A date value's first and last day (a range's end, or its start again).
    static func dates(_ property: WikiDbProperty, _ row: WikiDbRow) -> (start: Date, end: Date)? {
        switch property.type {
        case "created_time": return (row.createdAt, row.createdAt)
        case "edited_time": return (row.node.updatedAt, row.node.updatedAt)
        default: break
        }
        guard let value = raw(property, row) else { return nil }
        guard let start = parse(value["start"]?.string ?? value.string) else { return nil }
        return (start, parse(value["end"]?.string) ?? start)
    }

    static func parse(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        if raw.count == 10 {
            let parts = raw.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return nil }
            return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        }
        let full = ISO8601DateFormatter()
        full.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = full.date(from: raw) { return date }
        full.formatOptions = [.withInternetDateTime]
        return full.date(from: raw)
    }

    /// A day as the API stores a date without a time: `YYYY-MM-DD` in the person's calendar.
    static func day(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 1, parts.day ?? 1)
    }

    static func stamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    /// The value as one line of text, nil when empty.
    static func text(_ property: WikiDbProperty, _ row: WikiDbRow, people: (String) -> String?) -> String? {
        let answer: String?
        switch property.type {
        case "title": answer = row.node.title
        case "created_time": answer = Format.shortDate(row.createdAt)
        case "edited_time": answer = Format.shortDate(row.node.updatedAt)
        case "created_by": answer = row.createdBy?.displayName
        case "edited_by": answer = row.updatedBy?.displayName
        case "unique_id":
            answer = number(property, row).map { (property.prefix.map { $0.isEmpty ? "" : $0 + "-" } ?? "") + String(Int($0)) }
        case "checkbox": answer = raw(property, row)?.bool.map { $0 ? "Yes" : "No" }
        case "select", "status": answer = property.option(raw(property, row)?.string)?.name ?? raw(property, row)?.string
        case "multi_select":
            let names = ids(property, row).map { id in property.option(id)?.name ?? id }
            answer = names.isEmpty ? nil : names.joined(separator: ", ")
        case "date":
            guard let range = dates(property, row) else { return nil }
            let start = dateText(range.start, time: property.dateTime == true)
            answer = range.end == range.start ? start : "\(start) to \(dateText(range.end, time: property.dateTime == true))"
        case "person":
            let names = ids(property, row).map { people($0) ?? "Someone" }
            answer = names.isEmpty ? nil : names.joined(separator: ", ")
        case "relation":
            let count = ids(property, row).count
            answer = count == 0 ? nil : Format.plural(count, "page")
        case "ticket":
            let count = ids(property, row).count
            answer = count == 0 ? nil : Format.plural(count, "ticket")
        case "files":
            let names = (raw(property, row)?.array ?? []).compactMap { $0["name"]?.string ?? $0["url"]?.string }
            answer = names.isEmpty ? nil : names.joined(separator: ", ")
        case "number":
            answer = number(property, row).map { numberText($0, format: property.numberFormat) }
        default:
            answer = raw(property, row)?.displayText
        }
        guard let answer, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return answer
    }

    static func dateText(_ date: Date, time: Bool) -> String {
        time ? date.formatted(date: .abbreviated, time: .shortened) : date.formatted(date: .abbreviated, time: .omitted)
    }

    /// A number in the property's format (web `lib/wiki/db/format.ts`).
    static func numberText(_ value: Double, format: String?) -> String {
        let currencies = ["usd": "USD", "eur": "EUR", "gbp": "GBP", "jpy": "JPY", "chf": "CHF", "cad": "CAD", "aud": "AUD", "inr": "INR", "brl": "BRL", "huf": "HUF", "pln": "PLN"]
        switch format {
        case "comma": return value.formatted(.number.grouping(.automatic))
        case "percent": return value.formatted(.percent.precision(.fractionLength(0 ... 2)))
        case let code? where currencies[code] != nil: return value.formatted(.currency(code: currencies[code] ?? "USD"))
        default:
            return value.rounded() == value && abs(value) < 1e15 ? String(Int(value)) : String(value)
        }
    }
}

/// Which rows a view shows and in what order (web `lib/wiki/db/filter.ts`, `sort.ts`,
/// `group.ts`). As on the web, a rule still being written (no value yet) or naming a removed
/// property is ignored, and so is a rule on a formula or rollup, which the app computes.
@MainActor
enum WikiDbQuery {
    static func rows(_ rows: [WikiDbRow], view: WikiDbView?, schema: WikiDatabase, search: String = "") -> [WikiDbRow] {
        var out = rows
        if let filter = view?.settings?["filter"] {
            out = out.filter { matches(filter, $0, schema) }
        }
        let term = fold(search.trimmingCharacters(in: .whitespacesAndNewlines))
        if !term.isEmpty {
            out = out.filter { row in
                fold(row.node.title).contains(term) || schema.properties.contains { property in
                    WikiDbValue.text(property, row, people: { _ in nil }).map { fold($0).contains(term) } ?? false
                }
            }
        }
        let sorts = (view?.settings?["sorts"]?.array ?? []).compactMap { sort -> (WikiDbProperty, Bool)? in
            guard let property = schema.property(sort["property"]?.string) else { return nil }
            return (property, sort["dir"]?.string == "desc")
        }
        guard !sorts.isEmpty else { return out }
        return out.enumerated().sorted { a, b in
            for (property, desc) in sorts {
                let order = compare(property, a.element, b.element)
                if order != .orderedSame {
                    // Empty values stay last either way.
                    if isEmpty(property, a.element) != isEmpty(property, b.element) { return !isEmpty(property, a.element) }
                    return desc ? order == .orderedDescending : order == .orderedAscending
                }
            }
            return a.offset < b.offset
        }.map(\.element)
    }

    static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    static func isEmpty(_ property: WikiDbProperty, _ row: WikiDbRow) -> Bool {
        switch property.type {
        case "title": return row.node.title.trimmingCharacters(in: .whitespaces).isEmpty
        case "created_time", "edited_time": return false
        case "created_by": return row.createdBy == nil
        case "edited_by": return row.updatedBy == nil
        case "checkbox": return row.props[property.id]?.bool != true
        case "unique_id": return row.props[property.id]?.double == nil
        default: return WikiDbValue.raw(property, row) == nil
        }
    }

    private static func compare(_ property: WikiDbProperty, _ a: WikiDbRow, _ b: WikiDbRow) -> ComparisonResult {
        switch property.type {
        case "number", "unique_id":
            let x = WikiDbValue.number(property, a) ?? -.infinity
            let y = WikiDbValue.number(property, b) ?? -.infinity
            return x == y ? .orderedSame : (x < y ? .orderedAscending : .orderedDescending)
        case "date", "created_time", "edited_time":
            let x = WikiDbValue.dates(property, a)?.start ?? .distantPast
            let y = WikiDbValue.dates(property, b)?.start ?? .distantPast
            return x == y ? .orderedSame : (x < y ? .orderedAscending : .orderedDescending)
        case "checkbox":
            let x = a.props[property.id]?.bool == true
            let y = b.props[property.id]?.bool == true
            return x == y ? .orderedSame : (!x ? .orderedAscending : .orderedDescending)
        case "select", "status":
            // Options sort in their own order, as on the web.
            let x = property.options.firstIndex { $0.id == WikiDbValue.raw(property, a)?.string } ?? Int.max
            let y = property.options.firstIndex { $0.id == WikiDbValue.raw(property, b)?.string } ?? Int.max
            return x == y ? .orderedSame : (x < y ? .orderedAscending : .orderedDescending)
        default:
            let x = WikiDbValue.text(property, a, people: { _ in nil }) ?? ""
            let y = WikiDbValue.text(property, b, people: { _ in nil }) ?? ""
            return x.localizedStandardCompare(y)
        }
    }

    // MARK: Filter

    private static func matches(_ group: JSONValue, _ row: WikiDbRow, _ schema: WikiDatabase) -> Bool {
        let rules = group["rules"]?.array ?? []
        guard !rules.isEmpty else { return true }
        let results = rules.compactMap { rule -> Bool? in
            if rule["rules"] != nil { return matches(rule, row, schema) }
            return check(rule, row, schema)
        }
        guard !results.isEmpty else { return true }
        return group["op"]?.string == "or" ? results.contains(true) : !results.contains(false)
    }

    /// One rule; nil when it doesn't count (no value yet, a removed or computed property).
    private static func check(_ rule: JSONValue, _ row: WikiDbRow, _ schema: WikiDatabase) -> Bool? {
        guard let property = schema.property(rule["property"]?.string), let op = rule["op"]?.string else { return nil }
        if ["formula", "rollup"].contains(property.type) { return nil }
        let empty = isEmpty(property, row)
        if op == "is_empty" { return empty }
        if op == "is_not_empty" { return !empty }
        let value = rule["value"]
        if property.type == "checkbox" {
            guard op == "is", let want = value?.bool else { return nil }
            return (row.props[property.id]?.bool == true) == want
        }
        guard let value, !value.isNull, value.string != "" else { return nil }
        let negative = ["is_not", "does_not_contain", "neq"].contains(op)
        if empty { return negative }
        switch property.type {
        case "number", "unique_id":
            guard let target = value.double ?? value.string.flatMap(Double.init), let n = WikiDbValue.number(property, row) else { return nil }
            switch op {
            case "eq": return n == target
            case "neq": return n != target
            case "gt": return n > target
            case "lt": return n < target
            case "gte": return n >= target
            case "lte": return n <= target
            default: return nil
            }
        case "select", "status":
            let id = WikiDbValue.raw(property, row)?.string
            switch op {
            case "is": return id == value.string
            case "is_not": return id != value.string
            default: return nil
            }
        case "multi_select", "person", "relation", "ticket", "files", "created_by", "edited_by":
            let list = WikiDbValue.ids(property, row)
            let wanted = value.array?.compactMap(\.string) ?? [value.string].compactMap { $0 }
            switch op {
            case "contains": return wanted.contains { list.contains($0) }
            case "does_not_contain": return !wanted.contains { list.contains($0) }
            default: return nil
            }
        case "date", "created_time", "edited_time":
            guard let range = WikiDbValue.dates(property, row) else { return false }
            let calendar = Calendar.current
            let start = calendar.startOfDay(for: range.start)
            let end = calendar.startOfDay(for: range.end)
            if op == "is_relative" {
                guard let span = relative(value.string ?? "") else { return nil }
                return start <= span.to && end >= span.from
            }
            guard let day = WikiDbValue.parse(value.string).map({ calendar.startOfDay(for: $0) }) else { return nil }
            switch op {
            case "is": return start <= day && end >= day
            case "before": return start < day
            case "after": return start > day
            case "on_or_before": return start <= day
            case "on_or_after": return start >= day
            default: return nil
            }
        default:
            let hay = fold(WikiDbValue.text(property, row, people: { _ in nil }) ?? "")
            let needle = fold(value.string ?? value.displayText ?? "")
            switch op {
            case "is": return hay == needle
            case "is_not": return hay != needle
            case "contains": return hay.contains(needle)
            case "does_not_contain": return !hay.contains(needle)
            case "starts_with": return hay.hasPrefix(needle)
            case "ends_with": return hay.hasSuffix(needle)
            default: return nil
            }
        }
    }

    /// The days a relative date names; weeks start on Monday, past and next weeks run from today.
    private static func relative(_ name: String) -> (from: Date, to: Date)? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 2
        let today = calendar.startOfDay(for: AppClock.now)
        func add(_ unit: Calendar.Component, _ n: Int) -> Date { calendar.date(byAdding: unit, value: n, to: today) ?? today }
        func span(_ unit: Calendar.Component) -> (Date, Date) {
            let interval = calendar.dateInterval(of: unit, for: today)
            let start = interval?.start ?? today
            let end = interval.map { calendar.startOfDay(for: $0.end.addingTimeInterval(-1)) } ?? today
            return (start, end)
        }
        switch name {
        case "today": return (today, today)
        case "tomorrow": return (add(.day, 1), add(.day, 1))
        case "yesterday": return (add(.day, -1), add(.day, -1))
        case "this_week": return span(.weekOfYear)
        case "past_week": return (add(.day, -7), today)
        case "next_week": return (today, add(.day, 7))
        case "this_month": return span(.month)
        case "past_month": return (add(.month, -1), today)
        case "next_month": return (today, add(.month, 1))
        case "this_year": return span(.year)
        default: return nil
        }
    }

    // MARK: Groups

    struct Group: Identifiable {
        /// The option, person or value; "" for the rows without one.
        var id: String
        var title: String
        var tone: Tone
        var rows: [WikiDbRow]
    }

    /// Board columns, or a list's groups, by `property`: options in their order, then the rows
    /// without a value. A row with several values (multi-select, people) is in each of them.
    static func groups(_ rows: [WikiDbRow], by property: WikiDbProperty, hideEmpty: Bool, people: (String) -> String?) -> [Group] {
        var out: [Group] = []
        switch property.type {
        case "select", "status", "multi_select":
            for option in property.options {
                out.append(Group(id: option.id, title: option.name, tone: option.tone, rows: rows.filter { WikiDbValue.ids(property, $0).contains(option.id) }))
            }
        case "checkbox":
            out.append(Group(id: "true", title: "Checked", tone: .green, rows: rows.filter { $0.props[property.id]?.bool == true }))
            out.append(Group(id: "false", title: "Unchecked", tone: .gray, rows: rows.filter { $0.props[property.id]?.bool != true }))
            return out
        case "person", "created_by", "edited_by":
            var seen: [String] = []
            for row in rows { for id in WikiDbValue.ids(property, row) where !seen.contains(id) { seen.append(id) } }
            for id in seen {
                out.append(Group(id: id, title: people(id) ?? "Someone", tone: .gray, rows: rows.filter { WikiDbValue.ids(property, $0).contains(id) }))
            }
        default:
            var seen: [String] = []
            for row in rows {
                if let text = WikiDbValue.text(property, row, people: people), !seen.contains(text) { seen.append(text) }
            }
            for text in seen {
                out.append(Group(id: text, title: text, tone: .gray, rows: rows.filter { WikiDbValue.text(property, $0, people: people) == text }))
            }
        }
        let rest = rows.filter { isEmpty(property, $0) }
        out.append(Group(id: "", title: "No \(property.name)", tone: .gray, rows: rest))
        return hideEmpty ? out.filter { !$0.rows.isEmpty } : out
    }
}
