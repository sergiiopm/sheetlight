# src/grid

Canvas-based, virtualized spreadsheet grid (WS1). No DOM element per cell, no
React state for cell data, 60 fps scrolling on 1,048,576 x 16,384 sheets.

## Public surface

Other modules import only from `@/grid` (`index.ts`) and the types in `api.ts`:

- `<SpreadsheetGrid {...GridProps} ref={GridHandle} />`: React host. It mounts
  one imperative `Grid` per engine/document (sheet switches reuse it) and
  forwards prop changes; React never re-renders on scroll or selection.
- `GridProps`: engine, doc, sheet, `SelectionStore`, `initialView`, `onApply`
  (every grid-originated mutation: resize, autofit, fill handle, Delete),
  `onEditRequest` (typing, F2, double click, Backspace), `onUnhandledKey`,
  `onContextMenu`, `onFilterButton`, `onViewportChange`, `readOnly`.
- `GridHandle`: focus, cell/range rects, scroll, zoom (50–200%), ref
  highlights, reference picker, copy marquee, cursor mode, `measureAutofit`,
  overlay host for charts, viewport subscription.
- `useGridViewport(handle)`: low-frequency `{ topLeft, zoom }` for chrome.

The grid only reads from the engine (`getSheetInfo`, `fetchBlocks`,
`getStyles`, `findDataEdge`, `getColumnTextSamples`, `subscribe`); it never
calls `apply`.

## Layout

| Folder | What |
| --- | --- |
| `core/` | `Grid` (composition root, DOM, `GridHandle`), `Viewport` (scroll, zoom, layout, Excel scroll extent), `RenderScheduler` (damage tracking, rAF loop, block prefetch), `FrameStats` |
| `geometry/` | `AxisModel` (sparse sizes/hidden + prefix sums, O(log k)), `MergeIndex`, `SheetGeometry`, `layout.ts` (panes, exact device-pixel math) |
| `data/` | `EngineDataSource` (one sheet of a `WorkbookEngine`: blocks, styles, SheetInfo, events, data edge), `BlockCache` (sync LRU of 64x16 blocks, stale-while-refresh, `knownVersions`), `GridBlock`, `dataEdge.ts` (Ctrl+Arrow skipping hidden rows) |
| `render/` | `BaseRenderer` (cell layer), `OverlayRenderer` (selection layer), `StyleResolver`, `TextMeasurer`, `CanvasLayer`, `theme.ts` |
| `input/` | `PointerController` (mouse), `keyboard.ts`, `GridInteractions` (Excel semantics, ops), `SmoothScroller`, `NativeScrollbars`, `hitTest.ts` |
| `selection/` | Pure Excel selection functions over `SelectionState` (`src/model/selection.ts`), visible stepping |
| `a11y/` | Hidden ARIA grid mirroring the active cell + polite live region |

## Rendering

- DOM: `root > [base canvas, overlay canvas, native scroller > spacer,
  overlay host, a11y]`. The scroller is transparent and on top, so scrollbars
  and pointer events are native; the grid's own scroll (sheet units) is the
  source of truth.
- Cell layer order: placeholders, gridlines, fills, overflow gridline erasure,
  text (Excel overflow/clipping, `####`, wrap, fill, shrink-to-fit, rotation,
  vertical text, underline/strike), borders, merges, autofilter buttons,
  headers (hidden markers), frozen lines.
- Every edge is `round(position * dpr) - scrollDev` with the scroll snapped to
  device pixels, so a scroll of N device px moves everything by exactly N and
  the previous frame is blitted: one `drawImage(self)` per scroll axis, then
  only the exposed strips (grown by the border reach) and the rows of
  arriving blocks are repainted. Selection changes repaint only the overlay.
- Hot paths reuse typed arrays and shadow canvas state; blocks are split into
  per-cell strings once on arrival, never per frame.

## Tests

- Node (`tests/grid/*.test.ts`): axis model, geometry/layout invariants,
  merges, block cache, data source against `MemoryEngine`, selection,
  interactions and keyboard against a fake host.
- Headless Chromium (`tests/grid/browser/*.test.ts`, part of `npm test`): a
  Vite-served harness mounts the real `Grid` over `SyntheticEngine`. The blit
  test checks incremental frames against full redraws (DPR 1/1.5/2, zoom
  50/100/125%, frozen on/off); the interaction test drives real mouse and
  keyboard input; the perf test scrolls a 1M-row sheet. They are skipped when
  no Chromium build is found (`PLAYWRIGHT_BROWSERS_PATH`, `/opt/pw-browsers`
  or `SHEETLIGHT_CHROMIUM`); never run `playwright install` for them.

## Known gaps

- Excel "End mode" (End, then an arrow) is not implemented (Ctrl+arrows is).
- Rotated text is clipped to its cell (no overflow); auto row height for
  wrapped text is not computed by the grid.
- Text overflowing into view is scanned up to 256 columns beyond the pane.
- Diagonal scroll frames need two blits (vertical-only or horizontal-only
  frames need one).
