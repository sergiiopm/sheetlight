import type { Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromiumPath, openHarness, startBrowserEnv, type BrowserEnv } from "./browser-env";
import type { MountOptions } from "./harness";

/**
 * Real-input checks of the grid (Playwright mouse / keyboard in headless
 * Chromium) against the synthetic sheet: selection, navigation, edit
 * requests, resize/autofit, fill handle, context menu, autofilter buttons,
 * zoom, reference picking, accessibility, overlay coordinates.
 */
describe.skipIf(!chromiumPath)("grid interaction (headless Chromium)", () => {
  let env: BrowserEnv;
  let page: Page;

  beforeAll(async () => {
    env = await startBrowserEnv(chromiumPath as string);
    page = await openHarness(env, 1, { width: 1000, height: 700 });
  }, 60_000);

  afterAll(async () => {
    await env?.close();
  });

  async function mount(o: MountOptions = {}): Promise<void> {
    await page.evaluate((opts) => window.SL.mount({ width: 900, height: 600, latencyMs: 1, ...opts }), o);
  }

  async function center(row: number, col: number): Promise<{ x: number; y: number }> {
    const c = await page.evaluate(([r, c]) => window.SL.cellCenter(r, c), [row, col] as const);
    if (!c) throw new Error(`cell ${row},${col} not visible`);
    return c;
  }

  async function rect(row: number, col: number): Promise<{ left: number; top: number; right: number; bottom: number }> {
    const r = await page.evaluate(([r, c]) => window.SL.cellRect(r, c), [row, col] as const);
    if (!r) throw new Error(`cell ${row},${col} not visible`);
    return r;
  }

  async function click(row: number, col: number, modifiers: Array<"Shift" | "Control"> = []): Promise<void> {
    const c = await center(row, col);
    for (const m of modifiers) await page.keyboard.down(m);
    await page.mouse.click(c.x, c.y);
    for (const m of modifiers) await page.keyboard.up(m);
    await settle();
  }

  async function press(key: string): Promise<void> {
    await page.keyboard.press(key);
    await settle();
  }

  const settle = () => page.evaluate(() => window.SL.settle());
  const sel = () => page.evaluate(() => window.SL.sel());
  const log = () => page.evaluate(() => window.SL.log);

  beforeEach(async () => {
    await mount();
  });

  it("click, Shift+click and Ctrl+click build Excel selections", async () => {
    await click(2, 1);
    expect(await sel()).toMatchObject({ active: { row: 2, col: 1 }, ranges: [{ r0: 2, c0: 1, r1: 2, c1: 1 }], kind: "cells" });
    await click(7, 3, ["Shift"]);
    // B3:D8 touches the merge C4:E6, so the range grows to include it.
    expect(await sel()).toMatchObject({ active: { row: 2, col: 1 }, ranges: [{ r0: 2, c0: 1, r1: 7, c1: 4 }] });
    await click(12, 7, ["Control"]);
    const s = await sel();
    expect(s.ranges).toHaveLength(2);
    expect(s.activeRange).toBe(1);
    expect(s.active).toEqual({ row: 12, col: 7 });
  });

  it("drag-selects a range", async () => {
    const a = await center(1, 0);
    const b = await center(4, 1);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
    await settle();
    expect((await sel()).ranges[0]).toEqual({ r0: 1, c0: 0, r1: 4, c1: 1 });
  });

  it("clicking a merged cell selects the whole merge with the active cell at its top-left", async () => {
    await click(4, 3);
    expect(await sel()).toMatchObject({ active: { row: 3, col: 2 }, ranges: [{ r0: 3, c0: 2, r1: 5, c1: 4 }] });
  });

  it("header and corner clicks select rows, columns and the sheet", async () => {
    const r = await rect(1, 3);
    const L = await page.evaluate(() => window.SL.layout());
    await page.mouse.click((r.left + r.right) / 2, L.headerH / 2);
    await settle();
    expect(await sel()).toMatchObject({ kind: "cols", ranges: [{ c0: 3, c1: 3, r0: 0 }] });
    await page.mouse.click(L.headerW / 2, (r.top + r.bottom) / 2);
    await settle();
    expect(await sel()).toMatchObject({ kind: "rows", ranges: [{ r0: 1, r1: 1, c0: 0 }] });
    await page.mouse.click(L.headerW / 2, L.headerH / 2);
    await settle();
    expect((await sel()).kind).toBe("all");
  });

  it("keyboard navigation: arrows skip hidden rows/cols, Shift extends, Home / Ctrl+Home / Tab / Enter", async () => {
    await click(8, 5);
    await press("ArrowDown"); // row 9 is hidden
    expect((await sel()).active).toEqual({ row: 10, col: 5 });
    await press("ArrowRight"); // col 6 is hidden
    expect((await sel()).active).toEqual({ row: 10, col: 7 });
    await press("Shift+ArrowDown");
    await press("Shift+ArrowDown");
    expect((await sel()).ranges[0]).toEqual({ r0: 10, c0: 7, r1: 12, c1: 7 });
    await press("Enter"); // cycles inside the selection
    expect((await sel()).active).toEqual({ row: 11, col: 7 });
    await press("Home");
    expect((await sel()).active).toEqual({ row: 11, col: 0 });
    await press("Tab");
    expect((await sel()).active).toEqual({ row: 11, col: 1 });
    await press("Control+Home");
    expect((await sel()).active).toEqual({ row: 0, col: 0 });
  });

  it("Ctrl+arrows jump to the data edge like Excel (hidden rows skipped)", async () => {
    await click(1, 0);
    await press("Control+ArrowDown");
    await page.evaluate(() => window.SL.grid?.actions.jumpToEdge("down", false).then(() => undefined));
    const expected = await page.evaluate(() => {
      // Brute force over visible rows (from the state before the second jump).
      const SL = window.SL;
      const g = SL.grid;
      const e = SL.engine;
      if (!g || !e) return null;
      const rows = g.geom.rows;
      const filled = (r: number) => e.cell(r, 0) !== null;
      const step = (r: number) => rows.nextVisible(r + 1, 1);
      const edge = (from: number) => {
        let r = from;
        let n = step(r);
        if (filled(r) && filled(n)) {
          while (filled(n)) {
            r = n;
            n = step(r);
          }
          return r;
        }
        while (n >= 0 && !filled(n) && n < e.rows + 5) n = step(n);
        return n;
      };
      return edge(edge(1));
    });
    expect((await sel()).active).toEqual({ row: expected, col: 0 });
    await press("Control+End");
    expect((await sel()).active).toEqual({ row: 4999, col: 39 });
  });

  it("Page Down moves a screen and scrolls with it", async () => {
    await click(1, 1);
    const before = await page.evaluate(() => window.SL.view().topLeft.row);
    await press("PageDown");
    const s = await sel();
    const after = await page.evaluate(() => window.SL.view().topLeft.row);
    expect(s.active.row).toBeGreaterThan(15);
    expect(after).toBeGreaterThan(before + 10);
    await press("PageUp");
    expect((await sel()).active.row).toBeLessThan(5);
  });

  it("edit requests: typing, F2, Backspace, double click; Delete clears contents", async () => {
    await click(2, 2);
    await press("x");
    await press("F2");
    await press("Backspace");
    const c = await center(4, 0);
    await page.mouse.dblclick(c.x, c.y);
    await settle();
    await click(2, 2);
    await press("Delete");
    const l = await log();
    expect(l.edits.map((e) => e.source)).toEqual(["type", "f2", "backspace", "dblclick"]);
    expect(l.edits[0]).toMatchObject({ cell: { row: 2, col: 2 }, initialText: "x" });
    expect(l.edits[3].cell).toEqual({ row: 4, col: 0 });
    expect(l.ops.at(-1)).toEqual([{ type: "clear", sheet: 1, ranges: [{ r0: 2, c0: 2, r1: 2, c1: 2 }], what: "contents" }]);
  });

  it("unhandled shortcuts bubble to onUnhandledKey", async () => {
    await click(2, 2);
    await press("Control+b");
    await press("Control+PageDown");
    // Bare modifier keydowns are forwarded too; the shell ignores them.
    expect((await log()).keys.filter((k) => !k.endsWith("Control"))).toEqual(["Ctrl+b", "Ctrl+PageDown"]);
  });

  it("read-only grids do not request edits or resize", async () => {
    await mount({ readOnly: true });
    await click(2, 2);
    await press("x");
    await press("Delete");
    const l = await log();
    expect(l.edits).toHaveLength(0);
    expect(l.ops).toHaveLength(0);
  });

  it("dragging a column border resizes; double click autofits", async () => {
    const L = await page.evaluate(() => window.SL.layout());
    const r = await rect(1, 3);
    const y = L.headerH / 2;
    await page.mouse.move(r.right - 1, y);
    await page.mouse.down();
    await page.mouse.move(r.right + 40, y, { steps: 4 });
    await page.mouse.up();
    await settle();
    let l = await log();
    expect(l.ops.at(-1)).toEqual([{ type: "setColWidths", sheet: 1, cols: [3], size: 64 + 41 }]);
    expect(await page.evaluate(() => window.SL.colWidth(3))).toBe(105);

    const r0 = await rect(1, 0);
    await page.mouse.dblclick(r0.right - 1, y);
    await settle();
    await page.waitForFunction(() => window.SL.log.ops.length >= 2);
    l = await log();
    const op = l.ops.at(-1)?.[0];
    expect(op?.type).toBe("setColWidths");
    if (op?.type === "setColWidths") {
      expect(op.cols).toEqual([0]);
      // Column A holds "Encabezado de columna 0" plus a filter button: wider than the default.
      expect(op.size).toBeGreaterThan(100);
    }
  });

  it("dragging a row border resizes the row", async () => {
    const L = await page.evaluate(() => window.SL.layout());
    const r = await rect(2, 0);
    await page.mouse.move(L.headerW / 2, r.bottom - 1);
    await page.mouse.down();
    await page.mouse.move(L.headerW / 2, r.bottom + 15, { steps: 3 });
    await page.mouse.up();
    await settle();
    expect((await log()).ops.at(-1)).toEqual([{ type: "setRowHeights", sheet: 1, rows: [2], size: 36 }]);
  });

  it("fill handle drag emits a fill op and selects the target", async () => {
    await click(10, 1);
    await click(11, 2, ["Shift"]);
    const r = await rect(11, 2);
    const target = await center(15, 2);
    await page.mouse.move(r.right - 1, r.bottom - 1);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 6 });
    await page.mouse.up();
    await settle();
    expect((await log()).ops.at(-1)).toEqual([
      { type: "fill", sheet: 1, source: { r0: 10, c0: 1, r1: 11, c1: 2 }, target: { r0: 10, c0: 1, r1: 15, c1: 2 } },
    ]);
    expect((await sel()).ranges[0]).toEqual({ r0: 10, c0: 1, r1: 15, c1: 2 });
  });

  it("right click reports the region and keeps a selection that contains the cell", async () => {
    await click(10, 1);
    await click(12, 3, ["Shift"]);
    const c = await center(11, 2);
    await page.mouse.click(c.x, c.y, { button: "right" });
    await settle();
    const l = await log();
    expect(l.menus.at(-1)).toMatchObject({ region: "cell", cell: { row: 11, col: 2 } });
    expect((await sel()).ranges[0]).toEqual({ r0: 10, c0: 1, r1: 12, c1: 3 });
    const L = await page.evaluate(() => window.SL.layout());
    await page.mouse.click(c.x, L.headerH / 2, { button: "right" });
    await settle();
    expect((await log()).menus.at(-1)?.region).toBe("colHeader");
    expect((await sel()).kind).toBe("cols");
  });

  it("autofilter buttons report their column", async () => {
    const r = await rect(0, 3);
    await page.mouse.click(r.right - 6, r.bottom - 6);
    await settle();
    expect((await log()).filters).toEqual([3]);
    // The selection did not move to the header cell.
    expect((await sel()).active).toEqual({ row: 0, col: 0 });
  });

  it("wheel scrolls, Ctrl+wheel zooms within 50%..200%", async () => {
    const c = await center(5, 5);
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => window.SL.view().topLeft.row > 5);
    await settle();
    await page.keyboard.down("Control");
    for (let i = 0; i < 15; i++) await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await settle();
    expect((await page.evaluate(() => window.SL.view())).zoom).toBe(2);
    await page.evaluate(() => window.SL.setZoom(0.1));
    expect((await page.evaluate(() => window.SL.view())).zoom).toBe(0.5);
    const views = (await log()).views;
    expect(views.at(-1)?.zoom).toBe(0.5);
  });

  it("reference picker: clicks and drags produce ranges without moving the selection", async () => {
    await click(1, 1);
    await page.evaluate(() => window.SL.setPicker(true));
    const a = await center(3, 6 + 1);
    const b = await center(5, 8);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 3 });
    await page.mouse.up();
    await settle();
    const picks = (await log()).picks;
    expect(picks.at(-1)).toEqual({ range: { r0: 3, c0: 7, r1: 5, c1: 8 }, final: true });
    expect(picks.slice(0, -1).every((p) => !p.final)).toBe(true);
    expect((await sel()).active).toEqual({ row: 1, col: 1 });
  });

  it("copy marquee and ref highlights draw on the overlay layer only", async () => {
    const r = await rect(2, 1);
    expect((await page.evaluate(([x, y]) => window.SL.pixelAt("overlay", x, y), [r.left, r.top + 5] as const))[3]).toBe(0);
    await page.evaluate(() => window.SL.setMarquee({ r0: 2, c0: 1, r1: 4, c1: 1 }));
    await settle();
    expect((await page.evaluate(([x, y]) => window.SL.pixelAt("overlay", x, y), [r.left - 1, r.top + 5] as const))[3]).toBeGreaterThan(0);
    await page.evaluate(() => window.SL.setMarquee(null));
    await page.evaluate(() => window.SL.setHighlights(true));
    await settle();
    const px = await page.evaluate(([x, y]) => window.SL.pixelAt("overlay", x, y), [r.left + 10, r.top + 6] as const);
    expect(px[3]).toBeGreaterThan(0);
  });

  it("accessibility: ARIA grid with the active cell mirrored and announced", async () => {
    await click(2, 3);
    await page.waitForTimeout(200);
    const a = await page.evaluate(() => window.SL.a11y());
    expect(a.role).toBe("grid");
    expect(a.label?.startsWith("D3")).toBe(true);
    expect(a.announcement.startsWith("D3")).toBe(true);
  });

  it("overlay host and getRangeRect share coordinates; getCellRect follows scroll", async () => {
    const host = await page.evaluate(() => window.SL.overlayHostRect());
    const L = await page.evaluate(() => window.SL.layout());
    expect(host.left).toBeCloseTo(L.headerW, 5);
    expect(host.top).toBeCloseTo(L.headerH, 5);
    const rr = await page.evaluate(() => window.SL.rangeRect({ r0: 1, c0: 1, r1: 2, c1: 2 }));
    const cr = await rect(1, 1);
    expect(host.left + rr.x).toBeCloseTo(cr.left, 5);
    expect(host.top + rr.y).toBeCloseTo(cr.top, 5);
    expect(rr.width).toBe(64 + 120);
    await page.evaluate(() => window.SL.scrollBy(0, 2000));
    expect(await page.evaluate(() => window.SL.cellRect(1, 1))).toBeNull();
    const far = await page.evaluate(() => window.SL.rangeRect({ r0: 1, c0: 1, r1: 1, c1: 1 }));
    expect(far.y).toBeLessThan(0);
  });

  it("frozen panes: cells in the frozen area stay put while scrolling", async () => {
    await mount({ frozenRows: 2, frozenCols: 1 });
    const before = await rect(0, 0);
    await page.evaluate(() => window.SL.scrollBy(300, 600));
    const after = await rect(0, 0);
    expect(after).toEqual(before);
    const L = await page.evaluate(() => window.SL.layout());
    expect(L.frozenH).toBe(40);
    expect(L.frozenW).toBe(64);
    await click(0, 0);
    expect((await sel()).active).toEqual({ row: 0, col: 0 });
  });

  it("autofit measures text in CSS px at 100% zoom", async () => {
    const widths = await page.evaluate(() => window.SL.autofit([0, 1, 30]));
    expect(widths[0]).toBeGreaterThan(widths[1]);
    await page.evaluate(() => window.SL.setZoom(2));
    const zoomed = await page.evaluate(() => window.SL.autofit([0, 1, 30]));
    expect(zoomed).toEqual(widths);
  });
});
