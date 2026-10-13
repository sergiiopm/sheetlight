# Sheetlight Phase 0 / Spike B: canvas grid prototype

**Verdict: GO.** A custom canvas-virtualized grid holds the 60 fps target with a lot of headroom on
an Excel-sized sheet (1,048,576 x 16,384) with 1M rows of styled data behind an async provider.
On the test machine every scenario runs at the display's native 144 Hz, and grid work per frame stays
around 1 ms. With 4x CPU throttling (a proxy for a low-end laptop) it still holds 60 fps on more than
99% of frames. Incremental rendering (pixel-exact scroll blit) is what makes the low-end numbers
work, so it must be kept.

## 0. Results at a glance

Headed Chromium, RTX 4060 Ti, 144 Hz display, production build, 1,048,576 x 16,384 sheet with
1M x 20 styled rows behind an async Worker provider (2–5 ms latency), frozen panes on.

| Target | Result | Verdict |
|---|---|---|
| 60 fps scroll & selection at 1M rows (1080p and 4K, zoom 100% and 50%) | **142–144 fps** in every scenario (vsync-capped). **2 of ~29,000** frames exceeded 16.7 ms. Grid main-thread work **p99 ≤ 3.3 ms** per frame | **PASS, large headroom** |
| Same, with 4x CPU throttling (low-end laptop proxy) | 100% zoom: ≤ 0.3% of frames > 16.7 ms. 50% zoom: 0.6–1.0%. Worst: 3.3% (3840x2160 CSS @50%, where thumb-drag "teleport" scrolling can't blit) | **PASS at 100%, acceptable at 50%** |
| Full redraw (no blit) with 4x throttling, 50% zoom | 15–33% of frames > 16.7 ms, min 27–53 fps | shows that incremental rendering is **required** |
| Time to first paint (browser, from navigation) | first grid frame **92–204 ms**; first frame with all visible data **124–232 ms** (4x throttled: 253–317 / 422–470 ms) | fits the < 1 s cold-start budget (Tauri/WebView2 startup not included) |
| JS heap after scrolling all 1M rows | **17.9 MB** after GC (≤ 27 MB at the end of a full run; block cache capped at 768 blocks) | fits the < 150 MB idle target |
| Data latency after a far jump (scroll to first fully loaded frame) | p50 5–29 ms, p95 ≤ 37 ms (2–5 ms simulated IPC + structured clone + vsync alignment; block generation is only 0.07 ms/block) | instant to the eye |
| Selection-only updates (overlay layer) | 0.1–0.3 ms per frame (≤ 2 ms at 4x) | trivial |

Worst case per viewport/zoom across the seven scroll/drag scenarios (frames > 16.7 ms counted over
all of them; same build, `--full-redraw` toggles the blit off):

| CPU | Rendering | Viewport | Zoom | min fps (any scenario) | frames > 16.7 ms (all scenarios) | worst grid-work p95 / p99 (ms) | worst scenario |
|---|---|---|---|---|---|---|---|
| 1x | incremental | 1080p@1 | 100% | 144 | 0 / 3616 (0.0%) | 0.7 / 1.0 | vscroll-3000pxs |
| 1x | incremental | 1080p@1 | 50% | 144 | 0 / 3617 (0.0%) | 1.6 / 2.3 | hscroll-data |
| 1x | incremental | 4K@1.5 (2560x1440 css) | 100% | 143 | 0 / 3616 (0.0%) | 1.0 / 1.3 | vscroll-3000pxs |
| 1x | incremental | 4K@1.5 (2560x1440 css) | 50% | 143 | 0 / 3613 (0.0%) | 1.4 / 2.2 | drag-autoscroll |
| 1x | incremental | 4K@2 (1920x1080 css) | 100% | 144 | 0 / 3615 (0.0%) | 0.9 / 1.1 | drag-select |
| 1x | incremental | 4K@2 (1920x1080 css) | 50% | 144 | 0 / 3617 (0.0%) | 1.2 / 1.7 | vscroll-3000pxs |
| 1x | incremental | 4K@1 (3840x2160 css) | 100% | 143 | 0 / 3615 (0.0%) | 1.2 / 3.3 | drag-select |
| 1x | incremental | 4K@1 (3840x2160 css) | 50% | 143 | 2 / 3615 (0.1%) | 2.0 / 2.6 | vscroll-3000pxs |
| 1x | full redraw | 1080p@1 | 100% | 144 | 0 / 3616 (0.0%) | 1.2 / 1.8 | hscroll-full |
| 1x | full redraw | 1080p@1 | 50% | 144 | 0 / 3616 (0.0%) | 2.4 / 2.8 | vscroll-full |
| 1x | full redraw | 4K@1.5 (2560x1440 css) | 100% | 144 | 0 / 3616 (0.0%) | 1.8 / 2.2 | vscroll-3000pxs |
| 1x | full redraw | 4K@1.5 (2560x1440 css) | 50% | 144 | 0 / 3616 (0.0%) | 3.2 / 3.9 | hscroll-data |
| 1x | full redraw | 4K@2 (1920x1080 css) | 100% | 144 | 0 / 3616 (0.0%) | 1.4 / 1.8 | drag-autoscroll |
| 1x | full redraw | 4K@2 (1920x1080 css) | 50% | 144 | 0 / 3616 (0.0%) | 2.5 / 3.6 | hscroll-full |
| 1x | full redraw | 4K@1 (3840x2160 css) | 100% | 144 | 0 / 3616 (0.0%) | 2.2 / 2.6 | vscroll-full |
| 1x | full redraw | 4K@1 (3840x2160 css) | 50% | 142 | 1 / 3606 (0.0%) | 4.4 / 5.5 | vscroll-3000pxs |
| 4x | incremental | 1080p@1 | 100% | 115 | 4 / 3527 (0.1%) | 5.8 / 7.0 | drag-autoscroll |
| 4x | incremental | 1080p@1 | 50% | 117 | 34 / 3483 (1.0%) | 13.2 / 23.8 | wheel-fling |
| 4x | incremental | 4K@1.5 (2560x1440 css) | 100% | 138 | 3 / 3593 (0.1%) | 5.0 / 6.8 | drag-autoscroll |
| 4x | incremental | 4K@1.5 (2560x1440 css) | 50% | 101 | 33 / 3568 (0.9%) | 8.3 / 11.3 | vscroll-full |
| 4x | incremental | 4K@2 (1920x1080 css) | 100% | 128 | 4 / 3568 (0.1%) | 5.6 / 7.3 | drag-autoscroll |
| 4x | incremental | 4K@2 (1920x1080 css) | 50% | 118 | 23 / 3558 (0.6%) | 6.5 / 9.3 | vscroll-full |
| 4x | incremental | 4K@1 (3840x2160 css) | 100% | 120 | 12 / 3562 (0.3%) | 7.4 / 11.0 | vscroll-full |
| 4x | incremental | 4K@1 (3840x2160 css) | 50% | 88 | 115 / 3505 (3.3%) | 12.2 / 18.6 | vscroll-full |
| 4x | full redraw | 1080p@1 | 100% | 94 | 9 / 3327 (0.3%) | 8.4 / 10.9 | wheel-fling |
| 4x | full redraw | 1080p@1 | 50% | 46 | 556 / 3111 (17.9%) | 18.2 / 21.6 | wheel-fling |
| 4x | full redraw | 4K@1.5 (2560x1440 css) | 100% | 74 | 51 / 3209 (1.6%) | 10.0 / 12.1 | wheel-fling |
| 4x | full redraw | 4K@1.5 (2560x1440 css) | 50% | 40 | 857 / 3039 (28.2%) | 18.5 / 29.5 | wheel-fling |
| 4x | full redraw | 4K@2 (1920x1080 css) | 100% | 100 | 6 / 3371 (0.2%) | 6.8 / 8.8 | drag-autoscroll |
| 4x | full redraw | 4K@2 (1920x1080 css) | 50% | 53 | 472 / 3136 (15.1%) | 13.6 / 17.9 | wheel-fling |
| 4x | full redraw | 4K@1 (3840x2160 css) | 100% | 53 | 548 / 3076 (17.8%) | 14.7 / 17.4 | wheel-fling |
| 4x | full redraw | 4K@1 (3840x2160 css) | 50% | 27 | 983 / 2953 (33.3%) | 29.4 / 52.4 | wheel-fling |


## 1. How to run

```bash
npm install
npm run dev                      # http://localhost:5173  (?latency=2-5 sets provider latency, ?full=1 disables blit)
npm run test:unit                # AxisModel randomized test vs brute force
npm run test:e2e                 # needs `npm run dev` running: interaction checks + blit pixel-exactness
npm run build && npm run bench   # headed Chromium benchmark -> bench/results/*.json
npm run bench -- --cpu=4         # same with 4x CPU throttling (CDP Emulation.setCPUThrottlingRate)
npm run bench -- --full-redraw   # A/B: disable incremental rendering
node bench/table.mjs bench/results/<file>.json   # markdown tables
python bench/summary.py          # A/B worst-case summary
```

## 2. Architecture

```
src/grid/                      (promotable to sheetlight/src/grid; no React except react/)
  core/
    types.ts                   CellAddress, CellRange, MAX_ROWS/COLS, A1 names
    GridController.ts          owns DOM, models, rAF loop, damage tracking, public API
    FrameStats.ts              per-frame cost ring buffer + recording (HUD / bench)
  geometry/
    AxisModel.ts               rows or cols: default size + sparse sorted overrides (size/hidden)
                               + lazily rebuilt prefix sums -> O(log k) offset<->index
    MergeIndex.ts              merged ranges, bucketed by 64-row bands; expand(range) for selection
    SheetGeometry.ts           rows + cols + merges + frozen panes
    layout.ts                  panes (corner/top/left/main), device-pixel snapped scroll,
                               devX/devY, hit-test helpers, blit compatibility
  data/
    model.ts                   CellDataProvider contract, CellBlock, CellStyle, SheetInfo, events
    BlockCache.ts              sync LRU cache of 64x16 blocks in front of the async provider
  render/
    CanvasLayer.ts             DPR-aware canvas
    BaseRenderer.ts            cell layer: placeholders, gridlines, fills, text (overflow, clip,
                               wrap, ####), borders, merges, headers, frozen lines; full or
                               incremental (blit + exposed strips + dirty rows)
    OverlayRenderer.ts         selection layer: ranges, active cell, fill handle, header highlight
    TextMeasurer.ts            measureText cache per font string, font metrics, wrap cache
    StyleResolver.ts           style id -> resolved style with prebuilt font for current scale
    theme.ts
  input/
    NativeScrollbars.ts        native OS scrollbars over the canvas; >33.5M px range scaling
    SmoothScroller.ts          wheel (animated notches) / trackpad (direct) scrolling
    PointerController.ts       click/drag/shift/ctrl selection, headers, resize, autofit, auto-scroll
    keyboard.ts                Excel keyboard navigation
    hitTest.ts
  selection/
    SelectionModel.ts          multi-range selection with Excel semantics (anchor/focus/active)
    navigation.ts              visible stepping across hidden rows/cols and merges
  react/SpreadsheetGrid.tsx    thin React host + useGridViewState (useSyncExternalStore)
src/demo/                      synthetic 1M x 20 sheet in a Web Worker + demo chrome + bench API
bench/  run.mjs (Playwright benchmark), table.mjs, summary.py, shot.mjs (screenshots), results/
tests/  axis.test.mjs, interaction.mjs (real-input checks), blit.mjs (pixel-exactness)
```

About 4,100 lines of strict TypeScript (`strict`, `noUnusedLocals/Parameters`, `noImplicitOverride`),
with zero `any`. The only casts are at the worker RPC boundary and one known-non-null block slot.

### 2.1 Key design points

* **Two canvases plus a transparent native scroller.**
  `root > [base canvas (opaque), overlay canvas, scroller > spacer]`. The scroller sits on top, so
  the OS scrollbars and pointer events are native, and the canvases are never scrolled by the browser.
  The grid's own scroll position (sheet units) is the source of truth and is mapped onto the native
  scroller.
* **Chromium scroll cap.** A sheet at 200% zoom is ~42M px tall, beyond Chromium's ~33.5M px
  LayoutUnit limit. The native range is capped at 30M and mapped linearly. Rendering never uses the
  native value, so it stays pixel-exact; only thumb-drag granularity becomes ~1.4 px. This is tested:
  the scrollbar end reaches row 1,048,576 at 200%.
* **Device-pixel exact geometry.** Every edge is `round((paneX + (offset - paneBase) * zoom) * dpr) - scrollDev`,
  with the scroll snapped to whole device pixels. Gridlines are `fillRect`s on the last device pixel
  of each cell, so lines are crisp at any DPR or zoom. Because a scroll of N device px moves every edge
  by exactly N, the previous frame can be blitted. `tests/blit.mjs` proves blit+strips is
  **bit-identical** to a full redraw for DPR 1/1.5/2, zoom 50/100/125% and frozen on/off; a deliberate
  off-by-one mutation is caught (190k px differ).
* **Rendering pipeline (cell layer).** Placeholders, then gridlines, then fills, then overflow gridline
  erasure, then text, then borders, then merged cells, then headers, then frozen-pane lines. Per pane
  and per 64-row band, block pointers are resolved once, and each cell is one array index. Canvas
  state (font/fill/align) is shadowed to avoid redundant state changes. Clipping happens only when
  text actually overflows a blocked neighbor, wraps, or shows `####`. `text.length * maxCharW <= avail`
  skips `measureText` for most cells.
* **Incremental frames.** A scroll-only frame shifts each pane and the header strips with
  `drawImage(self)` and repaints only the exposed strips (plus one extra row on each side for glyph
  bleed). Arriving blocks repaint only their rows across the pane width, because text can overflow
  sideways. Zoom/resize/geometry/data changes do a full repaint. Selection changes only touch the
  overlay canvas.
* **Data path.** `CellDataProvider` is async (Worker RPC with 2–5 ms artificial latency). `BlockCache`
  is a synchronous LRU of 64x16 blocks (768 blocks max) that never blocks rendering. Missing blocks
  render as a light placeholder, and stale blocks keep rendering last-known data until refreshed.
  Prefetch goes one screen ahead in the scroll direction. Blocks outside `usedRange` are known-empty
  and never requested.
* **Text overflow (Excel rules).** Left-aligned text flows right, right-aligned flows left and
  centered flows both ways into empty, non-merged neighbors. The covered gridlines are erased.
  Numbers never overflow: they show `####`. Cells up to 12 columns outside the viewport are scanned,
  so text overflowing *into* view from off-screen cells is drawn.
* **React stays out of the hot path.** The controller is framework-agnostic. React only mounts it and
  subscribes to low-frequency `GridViewState` (selection, zoom, frozen). Nothing re-renders on scroll.

## 3. Feature checklist

| Area | Status |
|---|---|
| Layered canvases, DPR-aware crisp 1px lines, rAF-driven redraw, no per-cell DOM | done |
| 1,048,576 x 16,384 geometry; sparse custom row heights / col widths; hidden rows/cols; O(log k) lookup | done (20,000 row overrides in the demo; ~80 ns per `indexAt`) |
| Chromium max-scroll handling (scaled native range, pixel-exact rendering) | done + tested at 200% |
| Native scrollbars, wheel (animated) + trackpad (direct) scrolling, Shift+wheel horizontal | done |
| Frozen rows/cols (4 panes), row/column headers (1..1048576 / A..XFD) | done |
| Text clipping, Excel overflow into empty neighbors (incl. from off-screen), alignment (general: numbers right, bools centered), bold/italic/underline/strike, font color, fill, borders (thin/medium/thick/dashed/dotted/double), wrap, merged cells, `####` for numbers | done |
| Text measurement cache (+ wrap cache, metrics cache) | done |
| Async `CellDataProvider` in a real Web Worker with 2–5 ms latency, sync block cache, placeholders / last-known data, prefetch | done |
| Synthetic data 1,000,000 rows x 20 cols (+ merges every 1000 rows, a 5x5 merge, styles, gaps, hidden row/col) | done |
| Click/drag selection, Shift-extend, Ctrl multi-range, row/col header selection (+drag, +shift), select-all corner | done |
| Keyboard: arrows, Ctrl+arrows (async data-edge via provider), Shift variants, PgUp/PgDn (Alt = horizontal), Home, Ctrl+Home/End, Tab/Enter (cycling inside a selection), Ctrl/Shift+Space, Ctrl+A | done |
| Auto-scroll while drag-selecting outside the pane (speed grows with distance) | done |
| Column/row resize by dragging header borders; double-click column border = autofit (engine returns the longest strings, grid measures; 53 ms for 1M rows) | done |
| Incremental rendering: pixel-exact scroll blit + exposed strips + dirty rows for arriving blocks | done + pixel-diff tested |
| Fill handle drawn at the selection corner | drawn only (drag not implemented) |
| Zoom 50–200% (Ctrl+wheel, select) | done |

Verified by `tests/interaction.mjs` (25 checks with real Playwright mouse/keyboard input, all pass)
and `tests/blit.mjs` (18 DPR x zoom x frozen combinations, 0 differing pixels).

## 4. Measurements

**Method.** Playwright 1.64 drives **headed** Chromium (bundled Chromium, ANGLE/D3D11 on an
**NVIDIA RTX 4060 Ti**, 144 Hz 2560x1440 display, 20-core CPU, Windows 11) against the production
build (`vite preview`). Flags: `--ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy
--use-angle=d3d11 --disable-renderer-backgrounding --disable-background-timer-throttling
--disable-backgrounding-occluded-windows`. Viewports are emulated with Playwright
`viewport + deviceScaleFactor`. Headless mode was **not** used for the reported numbers (headed gives
real vsync pacing); headless was only used for the functional tests and screenshots.

* **Frame time** is the interval between consecutive `requestAnimationFrame` callbacks of a driver
  loop running in the page. vsync on this display is 6.9 ms, so "60 fps" means intervals ≤ 16.7 ms.
  **dropped @vsync** = sum over intervals of `round(interval / 6.9) - 1`; this is relative to 144 Hz
  and much stricter than the target. **frames > 16.7 ms** is the number that matters for the 60 fps
  target.
* **Grid work** is main-thread time inside the grid's frame callback (layout, block cache, both
  renderers). Canvas raster runs on the GPU process. It isn't measured directly, but back-pressure
  would show up as longer rAF intervals.
* **Frames w/ placeholders** is the share of drawn frames where some visible block was still in flight.

| Scenario | What it does |
|---|---|
| `vscroll-full` | Top to bottom through all 1,048,576 rows in ~6 s (~35,000 px per frame; scrollbar-thumb-drag style). Programmatic. |
| `vscroll-3000pxs` | Steady 3,000 px/s vertical scroll (fast reading). Programmatic. |
| `wheel-fling` | Real input: bursts of 12 wheel notches 8 ms apart (~20,000 px/s) through Chromium's input pipeline (`page.mouse.wheel`), smooth-scroll animated. |
| `hscroll-full` | Across all 16,384 columns in ~4 s. |
| `hscroll-data` | Horizontal back and forth through the 26 data columns at 1,500 px/s (most text per frame). |
| `drag-autoscroll` | Real mouse: press on a cell, drag below the grid (then below-right) and hold; auto-scroll + selection extension. |
| `drag-select` | Real mouse: circular drag inside the viewport (overlay-only repaints). |
| `jump-latency` | 30 jumps to far rows: ms from scroll to the first frame with all visible data (provider round trip). |

Viewports: 1920x1080 @1; 3840x2160 physical as 2560x1440 CSS @1.5 and as 1920x1080 CSS @2; plus a
stress case of 3840x2160 CSS @1 (4K at 100% Windows scaling: 4x the cells of 1080p). Each runs at
zoom 100% and 50% with frozen panes on (1 row + 1 column); 1080p additionally runs with panes off.

### 4.1 Incremental rendering (default): full results, CPU 1x

| Viewport | Zoom | Frozen | Scenario | fps | frame p50 / p95 / p99 / max (ms) | dropped @vsync | frames >16.7 ms | grid work p50 / p95 / p99 (ms) | frames w/ placeholders |
|---|---|---|---|---|---|---|---|---|---|
| 1080p@1 | 100% | y | vscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 870 | 0.3 / 0.4 / 0.5 | 95% |
| 1080p@1 | 100% | y | vscroll-3000pxs | 143.7 | 6.9 / 7.0 / 7.1 / 13.9 | 1 (0.2%) | 0 / 435 | 0.4 / 0.6 / 0.7 | 0% |
| 1080p@1 | 100% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.5 / 0.7 / 1.0 | 0% |
| 1080p@1 | 100% | y | hscroll-full | 144.1 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 0.3 / 0.4 / 0.5 | 0% |
| 1080p@1 | 100% | y | hscroll-data | 144.2 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 0.3 / 0.5 / 0.6 | 0% |
| 1080p@1 | 100% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.4 / 0.5 / 0.7 | 0% |
| 1080p@1 | 100% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.1 / 0.2 / 0.3 | 0% |
| 1080p@1 | 50% | y | vscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 870 | 0.4 / 0.5 / 0.7 | 95% |
| 1080p@1 | 50% | y | vscroll-3000pxs | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 0.4 / 0.8 / 0.9 | 0% |
| 1080p@1 | 50% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.8 / 1.6 / 2.3 | 0% |
| 1080p@1 | 50% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 0.3 / 0.6 / 0.7 | 0% |
| 1080p@1 | 50% | y | hscroll-data | 143.7 | 6.9 / 7.0 / 7.1 / 14.2 | 1 (0.2%) | 0 / 435 | 0.5 / 0.9 / 1.2 | 0% |
| 1080p@1 | 50% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.0 / 7.1 | 0 (0.0%) | 0 / 432 | 0.4 / 0.6 / 0.8 | 0% |
| 1080p@1 | 50% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 433 | 0.1 / 0.2 / 0.3 | 0% |
| 1080p@1 | 100% | n | vscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.2 | 0 (0.0%) | 0 / 870 | 0.3 / 0.5 / 0.7 | 95% |
| 1080p@1 | 100% | n | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.4 / 0.8 / 0.9 | 0% |
| 1080p@1 | 100% | n | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.4 / 0.7 / 0.9 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | vscroll-full | 143.9 | 6.9 / 7.0 / 7.1 / 12.9 | 1 (0.1%) | 0 / 870 | 0.6 / 0.7 / 0.8 | 95% |
| 4K@1.5 (2560x1440 css) | 100% | y | vscroll-3000pxs | 143.4 | 6.9 / 7.0 / 7.1 / 14.7 | 2 (0.5%) | 0 / 435 | 0.6 / 0.9 / 1.2 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.8 | 0 (0.0%) | 0 / 432 | 0.6 / 1.0 / 1.2 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.7 | 0 (0.0%) | 0 / 580 | 0.4 / 0.7 / 0.9 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | hscroll-data | 144.0 | 6.9 / 7.0 / 7.1 / 7.2 | 0 (0.0%) | 0 / 435 | 0.5 / 0.9 / 1.1 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.2 | 0 (0.0%) | 0 / 432 | 0.6 / 0.9 / 1.3 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | drag-select | 144.0 | 6.9 / 7.1 / 7.1 / 7.4 | 0 (0.0%) | 0 / 432 | 0.2 / 0.3 / 0.3 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | vscroll-full | 144.0 | 6.9 / 7.1 / 7.1 / 7.5 | 0 (0.0%) | 0 / 870 | 0.9 / 1.1 / 1.2 | 95% |
| 4K@1.5 (2560x1440 css) | 50% | y | vscroll-3000pxs | 144.0 | 6.9 / 7.0 / 7.1 / 7.2 | 0 (0.0%) | 0 / 435 | 0.6 / 0.9 / 1.2 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | wheel-fling | 143.7 | 6.9 / 7.0 / 7.1 / 12.5 | 1 (0.2%) | 0 / 431 | 0.8 / 1.4 / 2.2 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | hscroll-full | 144.0 | 6.9 / 7.1 / 7.4 / 8.1 | 0 (0.0%) | 0 / 580 | 0.5 / 0.6 / 0.8 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | hscroll-data | 143.7 | 6.9 / 7.0 / 7.1 / 14.5 | 1 (0.2%) | 0 / 435 | 0.7 / 1.2 / 1.6 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | drag-autoscroll | 143.3 | 6.9 / 7.0 / 7.1 / 13.9 | 2 (0.5%) | 0 / 430 | 0.6 / 1.2 / 1.3 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | drag-select | 144.0 | 6.9 / 7.1 / 7.1 / 7.6 | 0 (0.0%) | 0 / 432 | 0.2 / 0.3 / 0.3 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | vscroll-full | 143.9 | 6.9 / 7.0 / 7.1 / 12.7 | 1 (0.1%) | 0 / 870 | 0.4 / 0.6 / 1.0 | 95% |
| 4K@2 (1920x1080 css) | 100% | y | vscroll-3000pxs | 143.7 | 6.9 / 7.0 / 7.1 / 13.8 | 1 (0.2%) | 0 / 435 | 0.6 / 0.9 / 1.1 | 1% |
| 4K@2 (1920x1080 css) | 100% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.4 | 0 (0.0%) | 0 / 432 | 0.5 / 0.8 / 1.1 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.4 | 0 (0.0%) | 0 / 580 | 0.4 / 0.6 / 0.9 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | hscroll-data | 144.0 | 6.9 / 7.0 / 7.1 / 8.0 | 0 (0.0%) | 0 / 435 | 0.4 / 0.8 / 1.0 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.5 / 0.9 / 1.1 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | drag-select | 143.7 | 6.9 / 7.1 / 7.1 / 13.8 | 1 (0.2%) | 0 / 431 | 0.2 / 0.3 / 0.3 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | vscroll-full | 144.0 | 6.9 / 7.1 / 7.1 / 7.2 | 0 (0.0%) | 0 / 870 | 0.7 / 0.9 / 1.1 | 95% |
| 4K@2 (1920x1080 css) | 50% | y | vscroll-3000pxs | 143.7 | 6.9 / 7.0 / 7.1 / 13.9 | 1 (0.2%) | 0 / 435 | 0.6 / 0.8 / 1.1 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 433 | 0.7 / 1.2 / 1.7 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | hscroll-full | 144.0 | 6.9 / 7.1 / 7.1 / 7.7 | 0 (0.0%) | 0 / 580 | 0.4 / 0.6 / 0.9 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | hscroll-data | 144.0 | 6.9 / 7.1 / 7.1 / 7.5 | 0 (0.0%) | 0 / 435 | 0.5 / 1.0 / 1.4 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.6 / 1.1 / 1.4 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | drag-select | 144.0 | 6.9 / 7.1 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.2 / 0.3 / 0.3 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | vscroll-full | 144.0 | 6.9 / 7.1 / 7.1 / 7.8 | 0 (0.0%) | 0 / 870 | 0.8 / 1.0 / 1.4 | 95% |
| 4K@1 (3840x2160 css) | 100% | y | vscroll-3000pxs | 143.4 | 6.9 / 7.1 / 7.2 / 14.4 | 2 (0.5%) | 0 / 435 | 0.6 / 0.9 / 3.3 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.4 | 0 (0.0%) | 0 / 433 | 0.7 / 1.2 / 2.2 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 0.4 / 0.6 / 1.1 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | hscroll-data | 143.7 | 6.9 / 7.0 / 7.1 / 15.0 | 1 (0.2%) | 0 / 435 | 0.6 / 1.1 / 1.5 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.7 | 0 (0.0%) | 0 / 432 | 0.6 / 1.0 / 1.1 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | drag-select | 143.3 | 6.9 / 7.0 / 7.1 / 13.8 | 2 (0.5%) | 0 / 430 | 0.2 / 0.3 / 0.3 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | vscroll-full | 143.7 | 6.9 / 7.0 / 7.1 / 20.9 | 2 (0.2%) | 1 / 870 | 1.4 / 1.7 / 2.0 | 95% |
| 4K@1 (3840x2160 css) | 50% | y | vscroll-3000pxs | 142.7 | 6.9 / 7.1 / 7.6 / 34.8 | 4 (0.9%) | 1 / 435 | 0.7 / 0.9 / 1.2 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | wheel-fling | 143.7 | 6.9 / 7.0 / 7.1 / 13.9 | 1 (0.2%) | 0 / 431 | 1.1 / 1.6 / 2.6 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.2 | 0 (0.0%) | 0 / 580 | 0.5 / 0.8 / 1.1 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | hscroll-data | 144.0 | 6.9 / 7.0 / 7.1 / 7.2 | 0 (0.0%) | 0 / 435 | 0.9 / 2.0 / 2.5 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.7 / 1.3 / 1.8 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | drag-select | 144.0 | 6.9 / 7.1 / 7.1 / 7.2 | 0 (0.0%) | 0 / 432 | 0.2 / 0.3 / 0.3 | 0% |

| Viewport | first frame (ms) | first data-complete frame (ms) | FCP (ms) | JS heap after 1M-row scroll (MB) | heap at end (MB) | jump-to-data p50 / p95 (ms) @100% | @50% |
|---|---|---|---|---|---|---|---|
| 1080p@1 | 204 | 232 | 208 | 17.9 | 20.8 | 9.7 / 16.7 | 4.8 / 11.6 |
| 4K@1.5 (2560x1440 css) | 105 | 137 | 60 | 17.9 | 22.2 | 27.7 / 32.3 | 14.3 / 21.4 |
| 4K@2 (1920x1080 css) | 92 | 124 | 56 | 17.9 | 21.8 | 22.9 / 29.2 | 10.2 / 23.1 |
| 4K@1 (3840x2160 css) | 101 | 133 | 52 | 17.9 | 21.4 | 29.0 / 36.7 | 22.6 / 31.8 |

### 4.2 Incremental rendering: CPU throttled 4x (low-end proxy)

| Viewport | Zoom | Frozen | Scenario | fps | frame p50 / p95 / p99 / max (ms) | dropped @vsync | frames >16.7 ms | grid work p50 / p95 / p99 (ms) | frames w/ placeholders |
|---|---|---|---|---|---|---|---|---|---|
| 1080p@1 | 100% | y | vscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 870 | 1.4 / 1.8 / 2.2 | 95% |
| 1080p@1 | 100% | y | vscroll-3000pxs | 142.7 | 6.9 / 7.0 / 7.1 / 34.8 | 4 (0.9%) | 1 / 435 | 2.0 / 2.6 / 3.1 | 0% |
| 1080p@1 | 100% | y | wheel-fling | 143.0 | 6.9 / 7.0 / 7.1 / 20.8 | 3 (0.7%) | 1 / 430 | 2.7 / 3.9 / 4.7 | 0% |
| 1080p@1 | 100% | y | hscroll-full | 143.6 | 6.9 / 7.0 / 7.1 / 13.8 | 2 (0.3%) | 0 / 580 | 1.4 / 1.8 / 2.2 | 0% |
| 1080p@1 | 100% | y | hscroll-data | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 1.6 / 2.3 / 2.9 | 0% |
| 1080p@1 | 100% | y | drag-autoscroll | 115.0 | 7.0 / 13.9 / 14.0 / 20.9 | 87 (20.1%) | 2 / 345 | 3.5 / 5.8 / 7.0 | 0% |
| 1080p@1 | 100% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.9 / 1.2 / 1.4 | 0% |
| 1080p@1 | 50% | y | vscroll-full | 119.5 | 7.0 / 13.9 / 20.8 / 41.6 | 178 (17.0%) | 10 / 870 | 3.7 / 5.8 / 7.7 | 95% |
| 1080p@1 | 50% | y | vscroll-3000pxs | 140.5 | 6.9 / 7.0 / 7.1 / 83.4 | 11 (2.5%) | 1 / 435 | 2.4 / 4.0 / 4.9 | 0% |
| 1080p@1 | 50% | y | wheel-fling | 116.8 | 7.0 / 20.8 / 27.8 / 34.8 | 82 (18.9%) | 19 / 352 | 3.1 / 13.2 / 23.8 | 0% |
| 1080p@1 | 50% | y | hscroll-full | 142.9 | 6.9 / 7.0 / 7.1 / 14.0 | 5 (0.9%) | 0 / 580 | 2.3 / 3.4 / 4.5 | 0% |
| 1080p@1 | 50% | y | hscroll-data | 141.1 | 6.9 / 7.0 / 13.9 / 20.9 | 9 (2.0%) | 1 / 435 | 2.7 / 5.3 / 7.6 | 0% |
| 1080p@1 | 50% | y | drag-autoscroll | 126.3 | 7.0 / 13.9 / 14.0 / 34.6 | 53 (12.3%) | 3 / 379 | 2.9 / 6.6 / 10.1 | 0% |
| 1080p@1 | 50% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.9 / 1.3 / 1.8 | 0% |
| 1080p@1 | 100% | n | vscroll-full | 138.6 | 6.9 / 7.1 / 13.9 / 48.6 | 34 (3.8%) | 2 / 870 | 2.2 / 3.5 / 4.6 | 95% |
| 1080p@1 | 100% | n | wheel-fling | 135.0 | 6.9 / 7.1 / 14.0 / 48.6 | 27 (6.3%) | 3 / 405 | 2.9 / 6.2 / 8.9 | 0% |
| 1080p@1 | 100% | n | drag-autoscroll | 134.7 | 7.0 / 13.9 / 13.9 / 14.0 | 28 (6.5%) | 0 / 405 | 2.0 / 4.5 / 5.4 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | vscroll-full | 141.2 | 6.9 / 7.0 / 13.9 / 20.9 | 17 (1.9%) | 1 / 870 | 2.7 / 3.9 / 4.9 | 95% |
| 4K@1.5 (2560x1440 css) | 100% | y | vscroll-3000pxs | 140.5 | 6.9 / 7.0 / 7.1 / 76.3 | 11 (2.5%) | 1 / 435 | 3.0 / 4.8 / 6.1 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | wheel-fling | 142.7 | 6.9 / 7.0 / 7.1 / 14.0 | 4 (0.9%) | 0 / 428 | 3.1 / 5.0 / 6.8 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | hscroll-full | 144.1 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 2.0 / 3.0 / 3.8 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | hscroll-data | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 2.0 / 4.4 / 5.3 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | drag-autoscroll | 137.7 | 6.9 / 7.1 / 13.9 / 20.8 | 19 (4.4%) | 1 / 413 | 2.5 / 4.6 / 5.3 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.6 / 1.2 / 1.7 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | vscroll-full | 100.8 | 7.0 / 14.0 / 20.9 / 34.7 | 373 (30.0%) | 26 / 870 | 4.9 / 7.6 / 9.4 | 95% |
| 4K@1.5 (2560x1440 css) | 50% | y | vscroll-3000pxs | 136.2 | 6.9 / 7.1 / 13.9 / 62.5 | 25 (5.4%) | 3 / 435 | 3.2 / 5.3 / 6.6 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | wheel-fling | 132.7 | 6.9 / 13.9 / 14.0 / 20.9 | 34 (7.9%) | 3 / 398 | 3.7 / 8.3 / 11.3 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | hscroll-full | 142.8 | 6.9 / 7.0 / 7.1 / 13.9 | 5 (0.9%) | 0 / 580 | 2.3 / 3.9 / 4.6 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | hscroll-data | 139.2 | 6.9 / 7.1 / 13.9 / 20.9 | 15 (3.3%) | 1 / 435 | 2.7 / 6.9 / 8.9 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | drag-autoscroll | 139.0 | 6.9 / 7.1 / 13.9 / 14.0 | 15 (3.5%) | 0 / 418 | 2.6 / 5.1 / 6.7 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.9 / 1.4 / 2.0 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | vscroll-full | 142.2 | 6.9 / 7.0 / 13.8 / 14.0 | 11 (1.2%) | 0 / 870 | 2.3 / 3.5 / 4.6 | 95% |
| 4K@2 (1920x1080 css) | 100% | y | vscroll-3000pxs | 141.4 | 6.9 / 7.0 / 7.1 / 55.5 | 8 (1.8%) | 1 / 435 | 3.2 / 4.9 / 6.0 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 2.9 / 4.7 / 5.3 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.5 | 0 (0.0%) | 0 / 580 | 1.9 / 3.1 / 4.6 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | hscroll-data | 144.0 | 6.9 / 7.0 / 7.1 / 7.4 | 0 (0.0%) | 0 / 435 | 2.0 / 3.5 / 4.5 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | drag-autoscroll | 128.4 | 7.0 / 13.9 / 14.0 / 20.9 | 47 (10.9%) | 3 / 386 | 2.8 / 5.6 / 7.3 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | drag-select | 143.0 | 6.9 / 7.0 / 7.1 / 14.0 | 3 (0.7%) | 0 / 430 | 1.2 / 1.8 / 2.1 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | vscroll-full | 117.6 | 7.0 / 13.9 / 20.8 / 48.7 | 195 (18.3%) | 16 / 870 | 3.8 / 5.7 / 7.4 | 95% |
| 4K@2 (1920x1080 css) | 50% | y | vscroll-3000pxs | 141.1 | 6.9 / 7.0 / 7.1 / 48.6 | 9 (2.0%) | 2 / 435 | 2.6 / 4.3 / 5.3 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | wheel-fling | 137.3 | 6.9 / 7.1 / 13.9 / 48.6 | 20 (4.6%) | 2 / 412 | 3.0 / 6.5 / 9.3 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | hscroll-full | 143.5 | 6.9 / 7.0 / 7.1 / 14.0 | 2 (0.3%) | 0 / 580 | 2.2 / 3.3 / 4.5 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | hscroll-data | 140.5 | 6.9 / 7.1 / 13.9 / 20.9 | 11 (2.5%) | 1 / 435 | 2.3 / 5.9 / 9.0 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | drag-autoscroll | 131.0 | 6.9 / 13.9 / 14.0 / 20.8 | 39 (9.0%) | 2 / 394 | 2.9 / 5.7 / 8.1 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.8 / 1.2 / 1.4 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | vscroll-full | 119.9 | 7.0 / 13.9 / 14.0 / 27.7 | 175 (16.7%) | 8 / 870 | 3.8 / 5.7 / 7.1 | 95% |
| 4K@1 (3840x2160 css) | 100% | y | vscroll-3000pxs | 142.7 | 6.9 / 7.0 / 7.1 / 34.7 | 4 (0.9%) | 1 / 435 | 2.6 / 4.3 / 4.9 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | wheel-fling | 134.0 | 6.9 / 13.9 / 14.0 / 20.8 | 30 (6.9%) | 3 / 403 | 3.4 / 7.4 / 11.0 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | hscroll-full | 139.7 | 6.9 / 7.0 / 13.9 / 14.1 | 18 (3.0%) | 0 / 580 | 2.5 / 4.0 / 5.3 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | hscroll-data | 142.7 | 6.9 / 7.0 / 7.2 / 13.9 | 4 (0.9%) | 0 / 435 | 2.3 / 4.9 / 8.4 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | drag-autoscroll | 135.7 | 6.9 / 13.9 / 14.0 / 14.0 | 25 (5.8%) | 0 / 407 | 2.5 / 4.9 / 7.1 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.8 / 1.4 / 1.7 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | vscroll-full | 88.5 | 7.6 / 20.8 / 20.9 / 69.5 | 546 (38.6%) | 94 / 870 | 6.4 / 9.7 / 12.3 | 95% |
| 4K@1 (3840x2160 css) | 50% | y | vscroll-3000pxs | 136.5 | 6.9 / 7.1 / 13.9 / 97.2 | 24 (5.2%) | 2 / 435 | 2.9 / 5.1 / 6.4 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | wheel-fling | 115.1 | 7.0 / 14.0 / 20.8 / 131.9 | 87 (20.1%) | 13 / 346 | 3.0 / 12.2 / 18.6 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | hscroll-full | 142.8 | 6.9 / 7.0 / 7.2 / 13.9 | 5 (0.9%) | 0 / 580 | 2.6 / 3.9 / 5.0 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | hscroll-data | 129.4 | 6.9 / 13.9 / 20.8 / 34.7 | 49 (10.1%) | 5 / 435 | 3.3 / 9.4 / 16.2 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | drag-autoscroll | 135.7 | 6.9 / 7.2 / 13.9 / 48.6 | 25 (5.8%) | 1 / 407 | 2.6 / 5.2 / 6.7 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.7 / 1.3 / 1.6 | 0% |

| Viewport | first frame (ms) | first data-complete frame (ms) | FCP (ms) | JS heap after 1M-row scroll (MB) | heap at end (MB) | jump-to-data p50 / p95 (ms) @100% | @50% |
|---|---|---|---|---|---|---|---|
| 1080p@1 | 317 | 470 | 280 | 17.9 | 22.1 | 47.3 / 58.8 | 47.7 / 107.2 |
| 4K@1.5 (2560x1440 css) | 260 | 422 | 180 | 17.9 | 21.4 | 34.6 / 82.1 | 25.9 / 124.3 |
| 4K@2 (1920x1080 css) | 262 | 430 | 180 | 17.9 | 20.1 | 31.3 / 79.4 | 21.4 / 95.2 |
| 4K@1 (3840x2160 css) | 253 | 423 | 176 | 17.9 | 27.2 | 60.9 / 162.6 | 77.2 / 191.2 |

Notes:
* "dropped @vsync" counts against 144 Hz, which is much stricter than the 60 fps target. Intervals
  quantize to multiples of 6.9 ms, so one late frame shows up as 13.9 ms, which still meets 60 fps.
* `vscroll-full` shows placeholders on 95% of frames by design (each frame jumps ~1,700 rows); the
  work there is mostly gridlines, headers and placeholders. See `jump-latency` for how fast data
  appears once you stop.
* Rare single max outliers (35–130 ms) under throttling coincide with block arrivals in rows
  containing merged cells. Those currently fall back to a full repaint, so this is the first thing
  to optimize (section 7).


## 5. What was hard (and how it was solved)

1. **Pixel-exact incremental rendering.** Blitting only works if a scroll of N device px moves every
   edge by exactly N. Rounding `(offset - scroll) * zoom * dpr` per edge breaks that at DPR 1.5
   (x.5 ties) and with fractional smooth-scroll positions. The fix is to snap scroll to whole device
   pixels and subtract it after rounding (`devX/devY`). The pixel-diff test turned this from
   "probably right" into "provably bit-identical".
2. **Native scrollbars vs canvas.** There were three separate bugs here, all found by the e2e test.
   (a) Chromium clamps `scrollTop` when the spacer shrinks after a zoom change; that scroll event was
   mistaken for user input and teleported the grid to the bottom. The fix is to record the observed
   `scrollTop` after every sync, not just after writes. (b) CSS serializes `30000868px` as
   `3.00009e+07px`, so string comparison rewrote the spacer every frame. (c) A thumb movement landing
   between the scroll event and the frame could be overwritten, so native scroll is now polled at frame
   start.
3. **Excel text overflow** needs neighbor emptiness (including not-yet-loaded blocks, which count as
   occupied), merged cells, text coming from off-screen columns, and gridline erasure under the
   overflowing text. Each piece is small, but they interact.
4. **Canvas state shadowing vs `ctx.restore()`.** Caching font/fill/align to skip redundant sets is a
   real win, but `restore()` silently reverts the real state. This caused misaligned row numbers until
   all restores went through a helper that resets the shadow.
5. **Chromium quirks.** `PointerEvent.detail` is 0 (double-click must use `dblclick`). Wheel events
   don't say whether they come from a mouse or a trackpad, so a heuristic is used: integer |delta| ≥ 50
   is treated as a notch and animated.
6. **Async Ctrl+Arrow.** Data edges can be 1M rows away, so this is a provider query. Requests are
   serialized in a promise queue so key auto-repeat stays ordered.

## 6. Known gaps / not measured (honest list)

* **Hardware.** Everything ran on one fast desktop (RTX 4060 Ti, 144 Hz). The low-end estimate is
  CDP CPU throttling (4x), which slows the main thread but **not the GPU**. A real low-end laptop
  (iGPU, 60 Hz, 1.25–1.5x DPR) has not been measured. Neither has WebView2 inside Tauri; it is the
  same Chromium engine, but its flags/GPU setup can differ. **Re-run the benchmark inside the Tauri
  shell in Phase 2.**
* **Frame timing is rAF-based**, not compositor presentation timestamps (no CDP tracing). GPU raster
  cost is inferred from back-pressure only.
* **Memory** reported is the main-thread JS heap (`performance.memory` after a forced GC). Worker
  heap, GPU memory (two canvases: ~66 MB of backing store at 3840x2160 device px) and process RSS
  were not measured.
* `vscroll-full` (thumb-drag through 1M rows in 6 s) shows placeholders on ~95% of frames by design:
  each frame lands ~1,700 rows from the last one, and data arrives one provider round trip later.
  Content appears 5–37 ms after the thumb stops (`jump-latency`). Smooth scrolling (wheel, keyboard,
  3000 px/s, drag) essentially never showed placeholders thanks to prefetch.
* Not implemented (out of spike scope): in-cell editor/IME, fill-handle drag, context menu,
  touch/pinch gestures, RTL, rotated/vertical text, shrink-to-fit, rich text runs in a cell, auto row
  height for wrapped text, hidden-row/col indicators and unhide-by-drag, Excel's "scroll extent =
  used range + margin" (we always expose the full 1M rows), accessibility (ARIA grid / screen reader
  live region), printing.
* Overflow scan is limited to 12 columns beyond the viewport (a 13+ column-wide title that starts
  off-screen is cut). Merged cells crossing the frozen boundary aren't special-cased. Ctrl+Arrow
  doesn't skip hidden rows the way Excel does. Block-arrival repaints fall back to a full repaint when
  the affected rows contain merges.

## 7. Recommendations for the production grid (Phase 2, WS1)

### Keep as-is (promote the code)
* `geometry/AxisModel` (sparse overrides + prefix sums; randomized test included). If a workbook ever
  has >100k custom row heights *and* frequent single-row edits, swap the internals for a Fenwick tree;
  the API doesn't change.
* `layout.ts` pane model + `devX/devY` exact device-pixel math. **Do not regress to float positions.**
* Two-layer canvases + native scroller + `NativeScrollbars` (with its three bug fixes) + range scaling.
* **Incremental rendering (blit + strips + dirty rows)**, with `tests/blit.mjs` as a CI guard. It is
  the difference between "fine on my desktop" and "fine on a cheap laptop" (Appendix A vs 4.2).
* `BlockCache` (sync LRU in front of an async provider, placeholders, stale-while-refresh, prefetch).
* `SelectionModel`, `keyboard.ts`, `PointerController` semantics; extend rather than rewrite.
* The renderer ordering and text-overflow rules; `TextMeasurer`, `StyleResolver`.
* React integration pattern: imperative controller + `useSyncExternalStore` for chrome.

### Redesign / extend
* **Split `GridController`** (~700 lines) into `Viewport` (scroll/zoom/layout), `RenderScheduler`
  (damage + rAF) and `GridInteractions`, with the commands defined in Phase 1 (`GridModel`,
  `SelectionState`, `Command`). Selection state should live in `model/` (undo, formula-bar sync),
  with the grid as a view of it.
* **Block transport.** Use one joined string + `Uint32Array` offsets per block, plus typed arrays, all
  transferable, instead of a `string[]`. That gives a cheaper structured clone and maps directly onto
  a binary Tauri IPC payload (`tauri::ipc::Response` raw bytes) if the engine runs in Rust. Avoid
  JSON for blocks.
* **Multi-sheet + versions.** Add `sheetId` to every request and event. Return only blocks whose
  `version` changed (the client sends known versions).
* **Structural edits** (insert/delete rows/cols) should shift cached blocks and axis overrides locally
  instead of refetching; this needs a dedicated event (below).
* **Auto row height** for wrapped text / larger fonts needs the UI-thread measurer. Make it a
  `measureRowHeights(rows)` service the model calls, with results persisted as axis overrides.
* **Remaining per-frame cost** under throttling: full overlay repaint, layout, cache bookkeeping, and
  merge-row fallbacks to a full repaint. Fix merges in `blockDamage` first (it's the source of the rare
  30–130 ms outliers). Then consider an incremental overlay. For the thumb-drag "teleport" case (no
  blit possible), consider a per-block cached text bitmap or an OffscreenCanvas worker renderer.
  Only do these if real low-end hardware needs them.
* Scroll extent like Excel (used range + one screen, growing as you scroll) for a more useful thumb.
* Accessibility layer (hidden ARIA grid mirroring the active cell + live region) from day one.

### Proposed grid ↔ engine contract (TypeScript)

The spike's working version is `src/grid/data/model.ts`. Production version:

```ts
export type SheetId = string;
export interface BlockKey { readonly br: number; readonly bc: number }   // 64 x 16 cells

/** One tile. Dense, row-major, transferable. */
export interface CellBlock extends BlockKey {
  readonly sheet: SheetId;
  readonly version: number;              // data version of this block
  readonly text: string;                 // all display strings concatenated
  readonly textOffsets: Uint32Array;     // BLOCK_SIZE + 1 offsets into `text` (equal = empty)
  readonly kinds: Uint8Array;            // Empty | Text | Number | Bool | Error
  readonly styleIds: Uint32Array;        // render style id (number-format colors + cond. formatting applied)
  readonly flags: Uint8Array;            // bit0 formula, bit1 comment, bit2 validation, bit3 spill, bit4 hyperlink
}

export interface BlockRequest {
  readonly sheet: SheetId;
  readonly keys: ReadonlyArray<BlockKey>;
  readonly knownVersions?: ReadonlyArray<number>;  // skip unchanged blocks
  readonly priority: 0 | 1;                         // visible | prefetch
}

export interface AxisOverride { readonly index: number; readonly size?: number; readonly hidden?: boolean }

export interface SheetInfo {
  readonly sheet: SheetId;
  readonly rowCount: number; readonly colCount: number;
  readonly defaultRowHeight: number; readonly defaultColWidth: number;   // CSS px @100%
  readonly usedRange: CellRange | null;
  readonly rowOverrides: ReadonlyArray<AxisOverride>;
  readonly colOverrides: ReadonlyArray<AxisOverride>;
  readonly merges: ReadonlyArray<CellRange>;
  readonly frozenRows: number; readonly frozenCols: number;
  readonly version: number;
}

export interface TextSample { readonly text: string; readonly styleId: number }

export interface CellDataProvider {
  getSheetInfo(sheet: SheetId): Promise<SheetInfo>;
  fetchBlocks(req: BlockRequest): Promise<CellBlock[]>;
  getStyles(ids: ReadonlyArray<number>): Promise<ReadonlyArray<readonly [number, CellStyle]>>;
  findDataEdge(sheet: SheetId, from: CellAddress, dir: Direction): Promise<CellAddress>;
  getColumnTextSamples(sheet: SheetId, col: number, limit: number): Promise<TextSample[]>; // autofit
  subscribe(listener: (e: InvalidationEvent) => void): () => void;
}

export type InvalidationEvent =
  | { type: "cells"; sheet: SheetId; ranges: ReadonlyArray<CellRange>; version: number }        // edit / recalc / load progress
  | { type: "styles"; sheet: SheetId; ids: ReadonlyArray<number> }                              // style table changed
  | { type: "axis"; sheet: SheetId; axis: "row" | "col"; changes: ReadonlyArray<AxisOverride> } // sizes / hidden
  | { type: "structure"; sheet: SheetId; axis: "row" | "col"; op: "insert" | "delete"; index: number; count: number }
  | { type: "merges"; sheet: SheetId; merges: ReadonlyArray<CellRange> }
  | { type: "frozen"; sheet: SheetId; rows: number; cols: number }
  | { type: "usedRange"; sheet: SheetId; range: CellRange | null }
  | { type: "sheet"; sheet: SheetId; version: number };                                         // reload everything

/** Visual style. The engine resolves number-format colors ([Red]) and conditional formats into a
 *  render style id, so the grid never evaluates formats. */
export interface CellStyle {
  fontFamily?: string; fontSize?: number /* pt */; bold?: boolean; italic?: boolean;
  underline?: boolean | "double"; strike?: boolean; color?: string; fill?: string;
  hAlign?: "general" | "left" | "center" | "right" | "fill" | "justify" | "centerContinuous";
  vAlign?: "top" | "middle" | "bottom"; wrap?: boolean; shrinkToFit?: boolean; indent?: number;
  rotation?: number;
  borderTop?: BorderSpec; borderRight?: BorderSpec; borderBottom?: BorderSpec; borderLeft?: BorderSpec;
}
export interface BorderSpec { style: "thin" | "medium" | "thick" | "dashed" | "dotted" | "double" | "hair"; color: string }
```

**Division of responsibility.** The engine owns values, number formatting/locale (display strings),
conditional formatting (turned into render style ids), used range and data-edge queries. The grid
owns presentation (zoom, DPR, panes), text measurement (autofit/auto-height results go back to the
model as axis overrides), selection rendering and input. This keeps the render loop free of any
formatting or formula work. It also means the same contract works whether IronCalc runs as WASM in
a Worker or natively behind Tauri IPC.

## Appendix A: full-redraw baseline (`--full-redraw`, same build)

Same matrix with incremental rendering disabled, kept for the A/B comparison. Raw JSON and console
logs for every run are in `bench/results/`.

### headed-fullredraw.json (cpu throttle 1x, headed, full redraw)

| Viewport | Zoom | Frozen | Scenario | fps | frame p50 / p95 / p99 / max (ms) | dropped @vsync | frames >16.7 ms | grid work p50 / p95 / p99 (ms) | frames w/ placeholders |
|---|---|---|---|---|---|---|---|---|---|
| 1080p@1 | 100% | y | vscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 870 | 0.3 / 0.4 / 0.5 | 95% |
| 1080p@1 | 100% | y | vscroll-3000pxs | 144.2 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 1.0 / 1.2 / 1.3 | 0% |
| 1080p@1 | 100% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 1.1 / 1.2 / 1.8 | 0% |
| 1080p@1 | 100% | y | hscroll-full | 143.8 | 6.9 / 7.0 / 7.1 / 13.9 | 1 (0.2%) | 0 / 580 | 0.3 / 0.6 / 0.7 | 0% |
| 1080p@1 | 100% | y | hscroll-data | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 0.8 / 1.0 / 1.2 | 0% |
| 1080p@1 | 100% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.9 / 1.1 / 1.2 | 0% |
| 1080p@1 | 100% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.1 / 0.2 / 0.3 | 0% |
| 1080p@1 | 50% | y | vscroll-full | 143.7 | 6.9 / 7.0 / 7.1 / 13.9 | 2 (0.2%) | 0 / 870 | 0.5 / 0.6 / 0.7 | 95% |
| 1080p@1 | 50% | y | vscroll-3000pxs | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 2.0 / 2.4 / 2.7 | 0% |
| 1080p@1 | 50% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.2 | 0 (0.0%) | 0 / 432 | 2.0 / 2.4 / 2.8 | 0% |
| 1080p@1 | 50% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 0.4 / 0.5 / 0.6 | 0% |
| 1080p@1 | 50% | y | hscroll-data | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 1.4 / 1.9 / 2.0 | 0% |
| 1080p@1 | 50% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 1.9 / 2.3 / 2.4 | 0% |
| 1080p@1 | 50% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.1 / 0.2 / 0.3 | 0% |
| 1080p@1 | 100% | n | vscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 870 | 0.2 / 0.3 / 0.4 | 95% |
| 1080p@1 | 100% | n | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 1.0 / 1.2 / 1.3 | 0% |
| 1080p@1 | 100% | n | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.3 | 0 (0.0%) | 0 / 432 | 0.9 / 1.1 / 1.2 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | vscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 870 | 0.4 / 0.5 / 0.8 | 95% |
| 4K@1.5 (2560x1440 css) | 100% | y | vscroll-3000pxs | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 1.3 / 1.5 / 1.7 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 1.3 / 1.8 / 2.2 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 0.3 / 0.4 / 0.7 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | hscroll-data | 144.0 | 6.9 / 7.0 / 7.0 / 7.1 | 0 (0.0%) | 0 / 435 | 0.9 / 1.2 / 1.5 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.2 | 0 (0.0%) | 0 / 432 | 1.2 / 1.4 / 1.7 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.1 / 0.2 / 0.3 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | vscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 870 | 0.6 / 0.7 / 0.8 | 95% |
| 4K@1.5 (2560x1440 css) | 50% | y | vscroll-3000pxs | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 2.4 / 2.9 / 3.3 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.2 | 0 (0.0%) | 0 / 432 | 2.5 / 3.2 / 3.9 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | hscroll-full | 143.8 | 6.9 / 7.0 / 7.1 / 13.9 | 1 (0.2%) | 0 / 580 | 0.5 / 0.7 / 0.8 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | hscroll-data | 143.7 | 6.9 / 7.0 / 7.1 / 14.4 | 1 (0.2%) | 0 / 435 | 1.8 / 2.4 / 2.6 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 2.3 / 2.7 / 2.9 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.1 / 0.2 / 0.3 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | vscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 870 | 0.3 / 0.5 / 0.6 | 95% |
| 4K@2 (1920x1080 css) | 100% | y | vscroll-3000pxs | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 1.0 / 1.4 / 1.8 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.2 | 0 (0.0%) | 0 / 432 | 1.0 / 1.2 / 1.3 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 0.3 / 0.4 / 0.5 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | hscroll-data | 144.1 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 0.7 / 1.0 / 1.2 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.9 / 1.1 / 1.2 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.1 / 0.2 / 0.2 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | vscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.9 | 0 (0.0%) | 0 / 870 | 0.4 / 0.6 / 0.8 | 95% |
| 4K@2 (1920x1080 css) | 50% | y | vscroll-3000pxs | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 1.8 / 2.1 / 2.4 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.2 | 0 (0.0%) | 0 / 432 | 1.9 / 2.2 / 2.4 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 0.4 / 0.5 / 0.6 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | hscroll-data | 144.1 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 1.4 / 1.8 / 1.9 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 1.8 / 2.5 / 3.6 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.1 / 0.2 / 0.2 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | vscroll-full | 143.8 | 6.9 / 7.0 / 7.1 / 14.5 | 1 (0.1%) | 0 / 870 | 0.5 / 0.6 / 0.9 | 95% |
| 4K@1 (3840x2160 css) | 100% | y | vscroll-3000pxs | 144.0 | 6.9 / 7.0 / 7.1 / 7.2 | 0 (0.0%) | 0 / 435 | 1.8 / 2.2 / 2.6 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | wheel-fling | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 1.8 / 2.1 / 2.3 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 0.4 / 0.5 / 0.8 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | hscroll-data | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 1.4 / 1.8 / 2.0 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | drag-autoscroll | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 1.7 / 2.1 / 2.3 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.2 | 0 (0.0%) | 0 / 432 | 0.2 / 0.3 / 0.3 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | vscroll-full | 143.9 | 6.9 / 7.0 / 7.1 / 9.9 | 0 (0.0%) | 0 / 870 | 0.8 / 1.0 / 1.2 | 95% |
| 4K@1 (3840x2160 css) | 50% | y | vscroll-3000pxs | 141.7 | 6.9 / 7.0 / 13.9 / 14.0 | 7 (1.6%) | 0 / 435 | 3.7 / 4.4 / 5.5 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | wheel-fling | 142.7 | 6.9 / 7.0 / 7.1 / 20.8 | 4 (0.9%) | 1 / 428 | 3.7 / 4.3 / 5.1 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 0.7 / 0.8 / 1.0 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | hscroll-data | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 435 | 2.6 / 3.4 / 3.9 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | drag-autoscroll | 142.0 | 6.9 / 7.0 / 13.8 / 14.0 | 6 (1.4%) | 0 / 426 | 3.6 / 4.2 / 4.9 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.1 / 0.2 / 0.3 | 0% |

| Viewport | first frame (ms) | first data-complete frame (ms) | FCP (ms) | JS heap after 1M-row scroll (MB) | heap at end (MB) | jump-to-data p50 / p95 (ms) @100% | @50% |
|---|---|---|---|---|---|---|---|
| 1080p@1 | 224 | 253 | 212 | 17.9 | 20.8 | 10.5 / 11.5 | 4.6 / 11.6 |
| 4K@1.5 (2560x1440 css) | 87 | 124 | 96 | 17.9 | 22.9 | 11.3 / 13.6 | 6.2 / 12.7 |
| 4K@2 (1920x1080 css) | 93 | 125 | 56 | 17.9 | 22.1 | 10.8 / 13.3 | 4.7 / 16.1 |
| 4K@1 (3840x2160 css) | 98 | 131 | 60 | 17.9 | 22.5 | 11.7 / 15.3 | 13.4 / 21.4 |

### headed-cpu4x-fullredraw.json (cpu throttle 4x, headed, full redraw)

| Viewport | Zoom | Frozen | Scenario | fps | frame p50 / p95 / p99 / max (ms) | dropped @vsync | frames >16.7 ms | grid work p50 / p95 / p99 (ms) | frames w/ placeholders |
|---|---|---|---|---|---|---|---|---|---|
| 1080p@1 | 100% | y | vscroll-full | 143.7 | 6.9 / 7.0 / 7.1 / 13.9 | 2 (0.2%) | 0 / 870 | 1.6 / 2.2 / 3.0 | 95% |
| 1080p@1 | 100% | y | vscroll-3000pxs | 100.4 | 7.0 / 13.9 / 14.0 / 20.8 | 189 (30.3%) | 3 / 435 | 5.5 / 7.3 / 8.9 | 0% |
| 1080p@1 | 100% | y | wheel-fling | 93.7 | 13.8 / 14.0 / 20.9 / 20.9 | 151 (35.0%) | 4 / 281 | 5.7 / 8.4 / 10.9 | 0% |
| 1080p@1 | 100% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.3 | 0 (0.0%) | 0 / 580 | 1.5 / 1.8 / 2.2 | 0% |
| 1080p@1 | 100% | y | hscroll-data | 125.5 | 7.0 / 13.9 / 14.0 / 14.0 | 64 (12.8%) | 0 / 435 | 4.0 / 5.9 / 6.6 | 0% |
| 1080p@1 | 100% | y | drag-autoscroll | 98.0 | 7.0 / 14.0 / 14.0 / 20.9 | 138 (31.9%) | 2 / 294 | 5.1 / 6.3 / 7.1 | 0% |
| 1080p@1 | 100% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.6 / 0.8 / 0.9 | 0% |
| 1080p@1 | 50% | y | vscroll-full | 142.9 | 6.9 / 7.0 / 7.1 / 20.8 | 7 (0.8%) | 1 / 870 | 2.2 / 2.9 / 3.5 | 95% |
| 1080p@1 | 50% | y | vscroll-3000pxs | 54.4 | 20.8 / 20.9 / 27.9 / 34.8 | 716 (62.2%) | 268 / 435 | 10.7 / 13.4 / 21.6 | 0% |
| 1080p@1 | 50% | y | wheel-fling | 46.3 | 20.8 / 27.9 / 34.7 / 41.7 | 293 (67.8%) | 119 / 139 | 13.0 / 18.2 / 19.8 | 0% |
| 1080p@1 | 50% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 2.0 / 2.4 / 2.8 | 0% |
| 1080p@1 | 50% | y | hscroll-data | 72.9 | 13.9 / 20.9 / 21.0 / 41.7 | 424 (49.4%) | 84 / 435 | 8.0 / 11.5 / 16.4 | 0% |
| 1080p@1 | 50% | y | drag-autoscroll | 73.3 | 13.9 / 20.9 / 27.8 / 27.9 | 212 (49.1%) | 84 / 220 | 6.7 / 12.1 / 13.2 | 0% |
| 1080p@1 | 50% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.6 / 0.8 / 0.9 | 0% |
| 1080p@1 | 100% | n | vscroll-full | 143.4 | 6.9 / 7.0 / 7.1 / 20.9 | 4 (0.5%) | 1 / 870 | 1.2 / 1.5 / 1.9 | 95% |
| 1080p@1 | 100% | n | wheel-fling | 94.1 | 13.8 / 14.0 / 14.0 / 27.8 | 150 (34.6%) | 2 / 283 | 5.8 / 7.6 / 9.3 | 0% |
| 1080p@1 | 100% | n | drag-autoscroll | 104.7 | 7.0 / 13.9 / 14.0 / 20.8 | 118 (27.3%) | 1 / 314 | 4.9 / 5.8 / 6.7 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | vscroll-full | 143.8 | 6.9 / 7.0 / 7.1 / 13.8 | 1 (0.1%) | 0 / 870 | 1.9 / 2.5 / 3.2 | 95% |
| 4K@1.5 (2560x1440 css) | 100% | y | vscroll-3000pxs | 80.9 | 13.9 / 14.0 / 20.8 / 27.8 | 339 (43.8%) | 6 / 435 | 7.1 / 8.6 / 9.5 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | wheel-fling | 74.2 | 13.9 / 20.8 / 20.9 / 20.9 | 210 (48.5%) | 18 / 223 | 7.8 / 10.0 / 12.1 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 1.6 / 2.0 / 2.3 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | hscroll-data | 107.8 | 7.0 / 14.0 / 14.0 / 21.0 | 146 (25.1%) | 3 / 435 | 5.1 / 7.1 / 7.9 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | drag-autoscroll | 78.0 | 13.9 / 20.8 / 20.9 / 20.9 | 198 (45.8%) | 24 / 234 | 6.7 / 8.8 / 9.9 | 0% |
| 4K@1.5 (2560x1440 css) | 100% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.6 / 0.8 / 1.0 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | vscroll-full | 137.7 | 6.9 / 7.1 / 14.0 / 27.9 | 40 (4.4%) | 3 / 870 | 2.8 / 4.0 / 5.2 | 95% |
| 4K@1.5 (2560x1440 css) | 50% | y | vscroll-3000pxs | 42.0 | 20.9 / 27.9 / 41.6 / 55.7 | 1057 (70.8%) | 432 / 435 | 13.9 / 18.5 / 29.5 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | wheel-fling | 40.4 | 27.7 / 27.9 / 34.7 / 48.6 | 313 (72.0%) | 120 / 122 | 14.9 / 17.8 / 26.3 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | hscroll-full | 143.8 | 6.9 / 7.0 / 7.1 / 13.9 | 1 (0.2%) | 0 / 580 | 2.4 / 3.2 / 3.6 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | hscroll-data | 57.9 | 14.0 / 27.8 / 27.9 / 34.8 | 647 (59.8%) | 209 / 435 | 10.3 / 15.3 / 16.9 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | drag-autoscroll | 55.0 | 20.8 / 27.8 / 34.7 / 34.8 | 267 (61.8%) | 93 / 165 | 12.0 / 16.9 / 17.7 | 0% |
| 4K@1.5 (2560x1440 css) | 50% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.6 / 0.9 / 1.0 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | vscroll-full | 143.8 | 6.9 / 7.0 / 7.1 / 15.1 | 1 (0.1%) | 0 / 870 | 1.6 / 2.1 / 2.5 | 95% |
| 4K@2 (1920x1080 css) | 100% | y | vscroll-3000pxs | 103.9 | 7.0 / 13.9 / 14.0 / 20.9 | 168 (27.9%) | 2 / 435 | 5.4 / 6.8 / 8.8 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | wheel-fling | 106.4 | 7.0 / 13.9 / 14.0 / 14.0 | 113 (26.1%) | 0 / 320 | 5.3 / 6.5 / 7.7 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | hscroll-full | 144.1 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 1.4 / 2.0 / 2.9 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | hscroll-data | 128.4 | 7.0 / 13.9 / 14.0 / 14.0 | 53 (10.9%) | 0 / 435 | 4.1 / 5.7 / 6.2 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | drag-autoscroll | 99.7 | 7.0 / 14.0 / 20.8 / 20.8 | 133 (30.8%) | 4 / 299 | 5.0 / 6.3 / 7.4 | 0% |
| 4K@2 (1920x1080 css) | 100% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.6 / 0.8 / 0.9 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | vscroll-full | 143.3 | 6.9 / 7.0 / 7.1 / 13.9 | 4 (0.5%) | 0 / 870 | 2.3 / 3.0 / 3.8 | 95% |
| 4K@2 (1920x1080 css) | 50% | y | vscroll-3000pxs | 56.9 | 20.7 / 20.9 / 27.8 / 34.7 | 665 (60.5%) | 222 / 435 | 10.3 / 13.0 / 17.3 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | wheel-fling | 52.9 | 20.8 / 20.9 / 27.9 / 34.7 | 274 (63.3%) | 111 / 159 | 11.2 / 13.6 / 17.9 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | hscroll-full | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 580 | 2.0 / 2.5 / 2.8 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | hscroll-data | 76.1 | 13.9 / 20.8 / 20.9 / 34.7 | 388 (47.1%) | 59 / 435 | 8.1 / 10.9 / 11.9 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | drag-autoscroll | 75.0 | 13.8 / 20.9 / 27.8 / 34.6 | 207 (47.9%) | 80 / 225 | 6.3 / 11.2 / 13.6 | 0% |
| 4K@2 (1920x1080 css) | 50% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.7 / 1.0 / 1.2 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | vscroll-full | 143.5 | 6.9 / 7.0 / 7.1 / 13.9 | 3 (0.3%) | 0 / 870 | 2.3 / 3.1 / 3.7 | 95% |
| 4K@1 (3840x2160 css) | 100% | y | vscroll-3000pxs | 55.3 | 20.8 / 20.9 / 27.8 / 27.9 | 697 (61.6%) | 257 / 435 | 10.5 / 12.9 / 17.4 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | wheel-fling | 53.1 | 20.8 / 21.0 / 27.9 / 34.7 | 274 (63.1%) | 108 / 160 | 10.7 / 14.7 / 17.0 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | hscroll-full | 142.1 | 6.9 / 7.1 / 13.9 / 14.0 | 8 (1.4%) | 0 / 580 | 2.0 / 2.9 / 4.6 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | hscroll-data | 73.4 | 13.9 / 20.9 / 20.9 / 27.9 | 419 (49.1%) | 81 / 435 | 7.8 / 11.4 / 15.2 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | drag-autoscroll | 55.5 | 20.8 / 21.0 / 27.8 / 27.9 | 266 (61.4%) | 101 / 167 | 10.0 / 11.7 / 16.5 | 0% |
| 4K@1 (3840x2160 css) | 100% | y | drag-select | 143.0 | 6.9 / 7.0 / 7.1 / 20.7 | 3 (0.7%) | 1 / 429 | 0.6 / 0.8 / 1.0 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | vscroll-full | 117.4 | 7.0 / 13.9 / 20.8 / 34.7 | 197 (18.5%) | 9 / 870 | 3.9 / 5.0 / 7.6 | 95% |
| 4K@1 (3840x2160 css) | 50% | y | vscroll-3000pxs | 27.7 | 34.7 / 41.8 / 62.4 / 62.7 | 1825 (80.8%) | 434 / 435 | 21.7 / 27.2 / 43.5 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | wheel-fling | 27.3 | 34.7 / 48.6 / 69.4 / 69.4 | 350 (81.0%) | 80 / 82 | 22.5 / 29.4 / 52.4 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | hscroll-full | 138.5 | 6.9 / 7.1 / 13.9 / 27.6 | 23 (3.8%) | 2 / 580 | 3.3 / 4.2 / 5.0 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | hscroll-data | 40.5 | 21.0 / 34.8 / 41.7 / 55.5 | 1112 (71.9%) | 381 / 435 | 15.0 / 20.9 / 27.7 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | drag-autoscroll | 39.7 | 27.9 / 41.7 / 48.7 / 55.5 | 313 (72.5%) | 77 / 119 | 16.7 / 24.9 / 27.2 | 0% |
| 4K@1 (3840x2160 css) | 50% | y | drag-select | 144.0 | 6.9 / 7.0 / 7.1 / 7.1 | 0 (0.0%) | 0 / 432 | 0.6 / 0.8 / 1.0 | 0% |

| Viewport | first frame (ms) | first data-complete frame (ms) | FCP (ms) | JS heap after 1M-row scroll (MB) | heap at end (MB) | jump-to-data p50 / p95 (ms) @100% | @50% |
|---|---|---|---|---|---|---|---|
| 1080p@1 | 355 | 516 | 316 | 17.9 | 21.3 | 20.8 / 28.9 | 25.7 / 51.5 |
| 4K@1.5 (2560x1440 css) | 294 | 464 | 204 | 17.9 | 21.0 | 25.8 / 30.9 | 37.2 / 68.9 |
| 4K@2 (1920x1080 css) | 281 | 446 | 192 | 17.9 | 20.1 | 21.1 / 24.9 | 29.1 / 55.9 |
| 4K@1 (3840x2160 css) | 281 | 460 | 196 | 17.9 | 26.4 | 30.9 / 42.9 | 80.3 / 92.4 |

## Appendix B: screenshots

`node bench/shot.mjs` (with `npm run dev` running) writes screenshots of the initial view, a
section/merge row, zoom 50% and 200%, the bottom-right corner (XFD1048576), the 5x5 merge, and a
multi-range selection to `bench/shots/`.

