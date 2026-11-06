import SwiftUI

/// A side of the screen the system keeps for itself, such as the status column down the folded
/// iPhone Duo's outer display. Its controls go there the way the system's toolbars do: a
/// header's buttons under the clock, the tab bar at the foot.
struct SideColumn: Equatable {
    var edge: HorizontalEdge
    var width: CGFloat

    /// Where the system's own toolbar starts in the column, under the clock and battery (the
    /// window reports them as neither a safe-area inset nor a status bar frame).
    static let controlsTop: CGFloat = 173

    /// The column for a window with these safe-area insets, or nil when it has none. An iPhone
    /// on its side keeps both sides alike and has none.
    static func of(insets: EdgeInsets) -> SideColumn? {
        let edge: HorizontalEdge
        if insets.trailing >= 44, insets.leading < 20 {
            edge = .trailing
        } else if insets.leading >= 44, insets.trailing < 20 {
            edge = .leading
        } else {
            return nil
        }
        return SideColumn(edge: edge, width: edge == .trailing ? insets.trailing : insets.leading)
    }
}

extension EnvironmentValues {
    @Entry var sideColumn: SideColumn?
}

private struct SideColumnActions<Actions: View>: ViewModifier {
    @Environment(\.sideColumn) private var column
    @ViewBuilder var actions: () -> Actions
    @State private var minY: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { minY = $0 }
            .overlay(alignment: column?.edge == .leading ? .topLeading : .topTrailing) {
                if let column {
                    GlassEffectContainer(spacing: 12) {
                        VStack(spacing: 12) { actions() }
                    }
                    .frame(width: column.width)
                    .offset(x: column.edge == .trailing ? column.width : -column.width, y: SideColumn.controlsTop - minY)
                }
            }
    }
}

extension View {
    /// Stands `actions` in the side column, under the clock, while the window has one
    /// (`SideColumn`). The view this is on runs to the column's edge.
    func sideColumnActions<Actions: View>(@ViewBuilder _ actions: @escaping () -> Actions) -> some View {
        modifier(SideColumnActions(actions: actions))
    }
}
