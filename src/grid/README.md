# src/grid

Canvas-based, virtualized grid renderer. No DOM element per cell.

Responsibilities:

- Viewport: visible row/column range, scroll position, frozen panes, zoom
- Rendering: cells, gridlines, headers, selection, fill handle, ref highlights
- Hit-testing: map pointer coordinates to cells, headers and resize handles
- Interaction: selection with mouse and keyboard, row/column resize, scroll
- Must stay at 60 fps with 1M rows (see performance targets in `docs/PLAN.md`)

The grid reads cell data through the `GridModel` contract (defined in Phase 1)
and never talks to the formula engine directly.
