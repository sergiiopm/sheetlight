import { beforeEach, describe, expect, it } from "vitest";
import type { EngineOp } from "@/engine/contract";
import { MemoryEngine } from "@/engine/memory-engine";
import type { CellAddress, CellRange, SheetId } from "@/engine/types";
import { createSelectionStore, singleCellSelection, type SelectionState, type SelectionStore } from "@/model/selection";
import type { EditRequest, GridContextMenuEvent, ReferencePicker } from "@/grid/api";
import type { Viewport } from "@/grid/core/Viewport";
import { EngineDataSource } from "@/grid/data/DataSource";
import { computeLayout, scrollExtent } from "@/grid/geometry/layout";
import { SheetGeometry } from "@/grid/geometry/SheetGeometry";
import { GridInteractions, type InteractionHost } from "@/grid/input/GridInteractions";
import { handleKeyDown, isTypingKey, type KeyboardContext } from "@/grid/input/keyboard";

/** Minimal stand-in for `Viewport` (only what interactions use). */
class FakeViewport {
  x = 0;
  y = 0;
  revealed: CellAddress[] = [];
  constructor(private readonly geom: SheetGeometry) {}
  layout() {
    return computeLayout(this.geom, 800, 600, 1, 1, this.x, this.y, 40, 20);
  }
  extent() {
    return scrollExtent(this.geom, 800, 600, 1, 40, 20);
  }
  getScroll() {
    return { x: this.x, y: this.y };
  }
  setScroll(x: number, y: number) {
    this.x = Math.max(0, x);
    this.y = Math.max(0, y);
    return { x: this.x, y: this.y };
  }
  ensureVisible(cell: CellAddress) {
    this.revealed.push(cell);
  }
}

class Host implements InteractionHost {
  readonly geom = new SheetGeometry();
  readonly fake = new FakeViewport(this.geom);
  readonly viewport = this.fake as unknown as Viewport;
  readonly sheet: SheetId = 1;
  readOnly = false;
  ops: EngineOp[][] = [];
  edits: EditRequest[] = [];
  menus: GridContextMenuEvent[] = [];
  autofitWidths = new Map<number, number>();
  dataSource: EngineDataSource | null = null;
  constructor(readonly store: SelectionStore) {}
  data() {
    return this.dataSource;
  }
  selection(): SelectionState {
    return this.store.get();
  }
  setSelection(next: SelectionState) {
    this.store.set(next);
  }
  picker(): ReferencePicker | null {
    return null;
  }
  apply(ops: EngineOp[]) {
    this.ops.push(ops);
  }
  editRequest(req: EditRequest) {
    this.edits.push(req);
  }
  unhandledKey() {}
  contextMenu(e: GridContextMenuEvent) {
    this.menus.push(e);
  }
  filterButton() {}
  resizeAxis(axis: "row" | "col", index: number, size: number) {
    (axis === "col" ? this.geom.cols : this.geom.rows).setSize(index, size);
  }
  setResizeGuide() {}
  setFillPreview() {}
  setPick() {}
  async measureAutofit(cols: ReadonlyArray<number>) {
    return cols.map((c) => this.autofitWidths.get(c) ?? 64);
  }
  isDisposed() {
    return false;
  }
}

function key(k: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): KeyboardEvent {
  // Only the fields the handler reads.
  return { key: k, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: false, isComposing: false } as KeyboardEvent;
}

let host: Host;
let g: GridInteractions;
let kb: KeyboardContext;

beforeEach(() => {
  host = new Host(createSelectionStore(singleCellSelection(1)));
  g = new GridInteractions(host);
  kb = { geom: host.geom, actions: g, selection: () => host.selection(), revealActive: () => undefined, contextMenuAtActive: () => undefined };
});

const sel = () => host.selection();

describe("fill handle", () => {
  const src: CellRange = { r0: 2, c0: 1, r1: 3, c1: 2 };

  it("extends along the axis with the larger distance and shrinks back inside", () => {
    expect(g.fillTarget(src, { row: 9, col: 3 })).toEqual({ r0: 2, c0: 1, r1: 9, c1: 2 });
    expect(g.fillTarget(src, { row: 4, col: 8 })).toEqual({ r0: 2, c0: 1, r1: 3, c1: 8 });
    expect(g.fillTarget(src, { row: 0, col: 1 })).toEqual({ r0: 0, c0: 1, r1: 3, c1: 2 });
    expect(g.fillTarget(src, { row: 2, col: 0 })).toEqual({ r0: 2, c0: 0, r1: 3, c1: 2 });
    expect(g.fillTarget(src, { row: 2, col: 2 })).toEqual({ r0: 2, c0: 1, r1: 2, c1: 2 });
    expect(g.fillTarget(src, { row: 3, col: 2 })).toEqual(src);
  });

  it("commits a fill op, or clears what was dragged back over", () => {
    g.commitFill(src, { r0: 2, c0: 1, r1: 9, c1: 2 });
    expect(host.ops.at(-1)).toEqual([{ type: "fill", sheet: 1, source: src, target: { r0: 2, c0: 1, r1: 9, c1: 2 } }]);
    expect(sel().ranges).toEqual([{ r0: 2, c0: 1, r1: 9, c1: 2 }]);
    g.commitFill(src, { r0: 2, c0: 1, r1: 2, c1: 2 });
    expect(host.ops.at(-1)).toEqual([{ type: "clear", sheet: 1, ranges: [{ r0: 3, c0: 1, r1: 3, c1: 2 }], what: "contents" }]);
    const n = host.ops.length;
    g.commitFill(src, src);
    expect(host.ops.length).toBe(n);
  });

  it("does nothing when read-only", () => {
    host.readOnly = true;
    g.commitFill(src, { r0: 2, c0: 1, r1: 9, c1: 2 });
    g.commitResize("col", 1, 100, false);
    g.requestEdit("f2");
    expect(host.ops).toHaveLength(0);
    expect(host.edits).toHaveLength(0);
  });

  it("double click fills down as far as the neighbouring column has data", async () => {
    const engine = new MemoryEngine();
    const info = await engine.newDocument();
    const cells = [];
    for (let r = 0; r < 12; r++) cells.push({ row: r, col: 0, input: String(r) });
    cells.push({ row: 0, col: 1, input: "=A1*2" });
    await engine.apply(info.doc, [{ type: "setCells", sheet: info.activeSheet, cells }]);
    const ds = new EngineDataSource(engine, info.doc, info.activeSheet, {
      onBlocksLoaded: () => undefined,
      onDataInvalidated: () => undefined,
      onSheetInfo: () => undefined,
      onStructure: () => undefined,
      onStylesChanged: () => undefined,
    });
    await ds.load();
    host.dataSource = ds;
    await g.fillDownToAdjacent({ r0: 0, c0: 1, r1: 0, c1: 1 });
    expect(host.ops.at(-1)).toEqual([{ type: "fill", sheet: 1, source: { r0: 0, c0: 1, r1: 0, c1: 1 }, target: { r0: 0, c0: 1, r1: 11, c1: 1 } }]);
    ds.dispose();
  });
});

describe("resize and autofit", () => {
  it("resizing one of several selected columns resizes them all in one op", () => {
    g.clickColHeader(2, "replace", 0);
    g.clickColHeader(4, "extend", 0);
    g.commitResize("col", 3, 99.6, false);
    expect(host.ops.at(-1)).toEqual([{ type: "setColWidths", sheet: 1, cols: [2, 3, 4], size: 100 }]);
    expect(host.geom.cols.sizeOf(2)).toBe(100);
    expect(host.geom.cols.sizeOf(4)).toBe(100);
  });

  it("a column outside the header selection resizes alone; dragging a hidden one open unhides it", () => {
    g.clickColHeader(2, "replace", 0);
    g.commitResize("col", 7, 50, true);
    expect(host.ops.at(-1)).toEqual([
      { type: "setHidden", sheet: 1, axis: "col", indices: [7], hidden: false },
      { type: "setColWidths", sheet: 1, cols: [7], size: 50 },
    ]);
  });

  it("autofit groups columns by measured width into one batch", async () => {
    host.autofitWidths.set(1, 80).set(2, 120).set(3, 80);
    g.clickColHeader(1, "replace", 0);
    g.clickColHeader(3, "extend", 0);
    await g.autofitColumns(2);
    expect(host.ops.at(-1)).toEqual([
      { type: "setColWidths", sheet: 1, cols: [1, 3], size: 80 },
      { type: "setColWidths", sheet: 1, cols: [2], size: 120 },
    ]);
  });

  it("double click on a row border resets the height", () => {
    host.geom.rows.setSize(5, 50);
    g.autofitRows(5);
    expect(host.ops.at(-1)).toEqual([{ type: "setRowHeights", sheet: 1, rows: [5], size: null }]);
    expect(host.geom.rows.sizeOf(5)).toBe(host.geom.rows.defaultSize);
  });

  it("whole-sheet row selections are capped to the data / visible area", () => {
    g.selectAll();
    g.commitResize("row", 2, 30, false);
    const op = host.ops.at(-1)?.[0];
    expect(op?.type).toBe("setRowHeights");
    if (op?.type === "setRowHeights") {
      // 1,048,576 rows would be absurd: only up to the visible / used end.
      expect(op.rows.length).toBeLessThan(100);
      expect(op.rows).toContain(2);
    }
    // Columns are few enough (16,384) to resize them all, like Excel.
    g.commitResize("col", 2, 70, false);
    const cop = host.ops.at(-1)?.[0];
    expect(cop?.type === "setColWidths" && cop.cols.length).toBe(16_384);
  });
});

describe("keyboard", () => {
  it("routes keys to navigation, edit requests and the shell", () => {
    expect(handleKeyDown(kb, key("ArrowDown"))).toBe("handled");
    expect(sel().active).toEqual({ row: 1, col: 0 });
    expect(handleKeyDown(kb, key("ArrowRight", { shift: true }))).toBe("handled");
    expect(sel().ranges[0]).toEqual({ r0: 1, c0: 0, r1: 1, c1: 1 });
    expect(handleKeyDown(kb, key("z"))).toBe("handled");
    expect(host.edits.at(-1)).toEqual({ cell: { row: 1, col: 0 }, source: "type", initialText: "z" });
    expect(handleKeyDown(kb, key("F2"))).toBe("handled");
    expect(handleKeyDown(kb, key("Backspace"))).toBe("handled");
    expect(host.edits.map((e) => e.source)).toEqual(["type", "f2", "backspace"]);
    expect(handleKeyDown(kb, key("Delete"))).toBe("handled");
    expect(host.ops.at(-1)?.[0]).toMatchObject({ type: "clear", what: "contents" });
    expect(handleKeyDown(kb, key("b", { ctrl: true }))).toBe("unhandled");
    expect(handleKeyDown(kb, key("PageDown", { ctrl: true }))).toBe("unhandled");
    expect(handleKeyDown(kb, key("Enter", { alt: true }))).toBe("unhandled");
  });

  it("selection shortcuts: Ctrl+A, Ctrl+Space, Shift+Space, Space types", () => {
    handleKeyDown(kb, key("a", { ctrl: true }));
    expect(sel().kind).toBe("all");
    handleKeyDown(kb, key("ArrowDown"));
    handleKeyDown(kb, key(" ", { ctrl: true }));
    expect(sel().kind).toBe("cols");
    handleKeyDown(kb, key("ArrowDown"));
    handleKeyDown(kb, key(" ", { shift: true }));
    expect(sel().kind).toBe("rows");
    handleKeyDown(kb, key(" "));
    expect(host.edits.at(-1)).toMatchObject({ source: "type", initialText: " " });
  });

  it("Home / Ctrl+Home respect frozen panes; Page Down scrolls a screen", () => {
    host.geom.setFrozen(2, 1);
    g.goTo({ row: 40, col: 9 });
    handleKeyDown(kb, key("Home"));
    expect(sel().active).toEqual({ row: 40, col: 1 });
    handleKeyDown(kb, key("Home", { ctrl: true }));
    expect(sel().active).toEqual({ row: 2, col: 1 });
    handleKeyDown(kb, key("PageDown"));
    expect(sel().active.row).toBeGreaterThan(20);
    expect(host.fake.y).toBeGreaterThan(400);
  });

  it("End mode: End then an arrow jumps like Ctrl+arrow; End, Home goes to the last used cell", async () => {
    const engine = new MemoryEngine();
    const info = await engine.newDocument();
    const cells = [];
    for (let r = 0; r < 8; r++) cells.push({ row: r, col: 0, input: String(r) });
    cells.push({ row: 20, col: 4, input: "x" });
    await engine.apply(info.doc, [{ type: "setCells", sheet: info.activeSheet, cells }]);
    const ds = new EngineDataSource(engine, info.doc, info.activeSheet, {
      onBlocksLoaded: () => undefined,
      onDataInvalidated: () => undefined,
      onSheetInfo: () => undefined,
      onStructure: () => undefined,
      onStylesChanged: () => undefined,
    });
    await ds.load();
    host.dataSource = ds;
    expect(handleKeyDown(kb, key("End"))).toBe("handled");
    expect(g.endMode).toBe(true);
    handleKeyDown(kb, key("Shift"));
    expect(g.endMode).toBe(true);
    handleKeyDown(kb, key("ArrowDown"));
    expect(g.endMode).toBe(false);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(sel().active).toEqual({ row: 7, col: 0 });
    handleKeyDown(kb, key("End"));
    handleKeyDown(kb, key("Home"));
    expect(sel().active).toEqual({ row: 20, col: 4 });
    handleKeyDown(kb, key("End"));
    handleKeyDown(kb, key("x"));
    expect(g.endMode).toBe(false);
    ds.dispose();
  });

  it("typing keys: printable characters and AltGr, not shortcuts", () => {
    expect(isTypingKey(key("a"))).toBe(true);
    expect(isTypingKey(key("€", { ctrl: true, alt: true }))).toBe(true);
    expect(isTypingKey(key("a", { ctrl: true }))).toBe(false);
    expect(isTypingKey(key("Shift"))).toBe(false);
    expect(isTypingKey(key("😀"))).toBe(true);
  });

  it("IME composition opens the editor without consuming the key", () => {
    const e = { ...key("Process"), isComposing: true } as KeyboardEvent;
    expect(handleKeyDown(kb, e)).toBe("ime");
    expect(host.edits.at(-1)).toEqual({ cell: { row: 0, col: 0 }, source: "type" });
  });
});

describe("context menu", () => {
  it("keeps a selection that contains the clicked cell, otherwise selects it first", () => {
    g.goTo({ row: 2, col: 2 });
    g.goTo({ row: 5, col: 5 }, true);
    g.contextMenuAt("cell", { row: 3, col: 3 }, 10, 10);
    expect(sel().ranges[0]).toEqual({ r0: 2, c0: 2, r1: 5, c1: 5 });
    g.contextMenuAt("cell", { row: 9, col: 9 }, 10, 10);
    expect(sel().ranges[0]).toEqual({ r0: 9, c0: 9, r1: 9, c1: 9 });
    g.contextMenuAt("rowHeader", { row: 4, col: 0 }, 10, 10);
    expect(sel().kind).toBe("rows");
    expect(host.menus.map((m) => m.region)).toEqual(["cell", "cell", "rowHeader"]);
  });
});
