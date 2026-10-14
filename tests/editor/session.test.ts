import { beforeEach, describe, expect, it } from "vitest";
import { EngineError, type EngineOp } from "@/engine/contract";
import { MemoryEngine } from "@/engine/memory-engine";
import type { CellAddress, CellRange, DocumentId, SheetId } from "@/engine/types";
import { createSelectionStore, singleCellSelection, type SelectionStore } from "@/model/selection";
import { EditSession, type CommitMove, type EditKeyEvent } from "@/editor/session";
import { FakeGrid } from "./fake-grid";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function key(k: string, mods: Partial<EditKeyEvent> = {}): EditKeyEvent {
  return { key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods };
}

const A1: CellAddress = { row: 0, col: 0 };

interface Harness {
  engine: MemoryEngine;
  doc: DocumentId;
  sheet: SheetId;
  selection: SelectionStore;
  grid: FakeGrid;
  session: EditSession;
  commits: Array<{ ops: EngineOp[]; move: CommitMove }>;
  failNext: EngineError | null;
}

async function setup(options: { valueAutoComplete?: boolean } = {}): Promise<Harness> {
  const engine = new MemoryEngine();
  const info = await engine.newDocument();
  const sheet = info.activeSheet;
  const selection = createSelectionStore(singleCellSelection(sheet));
  const grid = new FakeGrid();
  const h: Harness = { engine, doc: info.doc, sheet, selection, grid, session: null as unknown as EditSession, commits: [], failNext: null };
  h.session = new EditSession({
    engine,
    doc: info.doc,
    selection,
    getGrid: () => grid,
    getSheets: () => [
      { id: sheet, name: "Hoja1", hidden: false },
      { id: 99, name: "Mi hoja", hidden: false },
    ],
    onNavigateSheet: (id, range) => navigations.push({ id, range }),
    onCommit: async (ops, move) => {
      h.commits.push({ ops, move });
      if (h.failNext) {
        const e = h.failNext;
        h.failNext = null;
        throw e;
      }
      await engine.apply(info.doc, ops);
    },
    now: () => new Date(2025, 5, 10),
    valueAutoComplete: options.valueAutoComplete,
  });
  return h;
}

let navigations: Array<{ id: SheetId; range: CellRange }> = [];

/** Simulates typing: the first char starts the edit (like the grid), the rest go through setText. */
function type(h: Harness, text: string, cell: CellAddress = h.selection.get().active): void {
  if (!h.session.isEditing()) {
    h.session.start({ cell, source: "type", initialText: text[0] });
    text = text.slice(1);
  }
  for (const ch of text) {
    const s = h.session.getState();
    const value = s.text.slice(0, s.selStart) + ch + (s.text + s.suggestion).slice(s.selEnd);
    h.session.setText(value, s.selStart + 1, s.selStart + 1, "insertText");
  }
}

function cellsOf(h: Harness, index = 0) {
  const op = h.commits[index].ops[0];
  if (op.type !== "setCells") throw new Error("expected setCells");
  return op.cells;
}

describe("EditSession — start and commit", () => {
  let h: Harness;
  beforeEach(async () => {
    navigations = [];
    h = await setup();
  });

  it("types a value in Enter mode and commits with Enter (moves down)", async () => {
    type(h, "12,5");
    const s = h.session.getState();
    expect(s).toMatchObject({ status: "editing", mode: "enter", text: "12,5", cell: A1, surface: "cell" });
    expect(h.session.handleKey(key("Enter"))).toBe(true);
    expect(h.session.getState().status).toBe("idle");
    expect(cellsOf(h)).toEqual([{ row: 0, col: 0, input: "12.5" }]);
    expect(h.commits[0].move).toBe("down");
    expect(h.selection.get().active).toEqual({ row: 1, col: 0 });
    expect(h.grid.focused).toBeGreaterThan(0);
    await flush();
    expect((await h.engine.getCell(h.doc, h.sheet, A1)).input).toBe("12.5");
  });

  it("sends the number format of typed dates, percents and currency", () => {
    type(h, "14/02/2025");
    h.session.handleKey(key("Enter"));
    expect(cellsOf(h)).toEqual([{ row: 0, col: 0, input: "45702", numFmt: "dd/mm/yyyy" }]);
  });

  it("Shift+Enter moves up, Tab right, Shift+Tab left", () => {
    h.selection.set(singleCellSelection(h.sheet, { row: 5, col: 5 }));
    type(h, "a");
    h.session.handleKey(key("Enter", { shiftKey: true }));
    expect(h.selection.get().active).toEqual({ row: 4, col: 5 });
    type(h, "b");
    h.session.handleKey(key("Tab"));
    expect(h.selection.get().active).toEqual({ row: 4, col: 6 });
    type(h, "c");
    h.session.handleKey(key("Tab", { shiftKey: true }));
    expect(h.selection.get().active).toEqual({ row: 4, col: 5 });
  });

  it("Enter after a Tab sequence returns to the starting column", () => {
    h.selection.set(singleCellSelection(h.sheet, { row: 1, col: 1 }));
    type(h, "a");
    h.session.handleKey(key("Tab"));
    type(h, "b");
    h.session.handleKey(key("Tab"));
    type(h, "c");
    h.session.handleKey(key("Enter"));
    expect(h.selection.get().active).toEqual({ row: 2, col: 1 });
    // the chain is reset afterwards
    type(h, "d");
    h.session.handleKey(key("Enter"));
    expect(h.selection.get().active).toEqual({ row: 3, col: 1 });
  });

  it("arrow keys commit and move in Enter mode", () => {
    type(h, "x");
    expect(h.session.handleKey(key("ArrowRight"))).toBe(true);
    expect(h.commits[0].move).toBe("right");
    expect(h.selection.get().active).toEqual({ row: 0, col: 1 });
  });

  it("F2 toggles Edit mode, where arrows move the caret", () => {
    type(h, "x");
    h.session.handleKey(key("F2"));
    expect(h.session.getState().mode).toBe("edit");
    expect(h.session.handleKey(key("ArrowLeft"))).toBe(false);
    h.session.handleKey(key("F2"));
    expect(h.session.getState().mode).toBe("enter");
  });

  it("F2 loads the existing input in the locale", async () => {
    await h.engine.apply(h.doc, [{ type: "setCells", sheet: h.sheet, cells: [{ row: 0, col: 0, input: "1234.5" }] }]);
    h.session.start({ cell: A1, source: "f2" });
    expect(h.session.getState()).toMatchObject({ status: "editing", mode: "edit", loading: true });
    await flush();
    expect(h.session.getState()).toMatchObject({ text: "1234,5", loading: false, selStart: 6 });
    // unchanged F2 + Enter: no op, just moves
    h.session.handleKey(key("Enter"));
    expect(h.commits).toHaveLength(0);
    expect(h.selection.get().active).toEqual({ row: 1, col: 0 });
  });

  it("keeps characters typed while the input was loading", async () => {
    await h.engine.apply(h.doc, [{ type: "setCells", sheet: h.sheet, cells: [{ row: 0, col: 0, input: "ab" }] }]);
    h.session.start({ cell: A1, source: "dblclick" });
    h.session.setText("c", 1, 1, "insertText");
    await flush();
    expect(h.session.getState().text).toBe("abc");
  });

  it("Backspace starts with an empty editor", async () => {
    await h.engine.apply(h.doc, [{ type: "setCells", sheet: h.sheet, cells: [{ row: 0, col: 0, input: "ab" }] }]);
    h.session.start({ cell: A1, source: "backspace" });
    await flush();
    expect(h.session.getState()).toMatchObject({ text: "", mode: "enter" });
    h.session.handleKey(key("Enter"));
    expect(cellsOf(h)).toEqual([{ row: 0, col: 0, input: "" }]);
  });

  it("Esc cancels without committing", () => {
    type(h, "hola");
    h.session.handleKey(key("Escape"));
    expect(h.session.getState().status).toBe("idle");
    expect(h.commits).toHaveLength(0);
    expect(h.selection.get().active).toEqual(A1);
  });

  it("Alt+Enter inserts a newline and commits with wrap", () => {
    type(h, "a");
    h.session.handleKey(key("Enter", { altKey: true }));
    expect(h.session.getState().text).toBe("a\n");
    type(h, "b");
    h.session.handleKey(key("Enter"));
    expect(h.commits[0].ops).toEqual([
      { type: "setCells", sheet: h.sheet, cells: [{ row: 0, col: 0, input: "a\nb" }] },
      { type: "setStyle", sheet: h.sheet, ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], patch: { wrap: true } },
    ]);
  });

  it("Ctrl+Enter fills the selection with shifted formulas and keeps the selection", () => {
    const range = { r0: 0, c0: 0, r1: 1, c1: 1 };
    h.selection.set({ sheet: h.sheet, ranges: [range], activeRange: 0, active: A1, anchor: A1, kind: "cells" });
    type(h, "=C1*$A$9");
    h.session.handleKey(key("Enter", { ctrlKey: true }));
    expect(cellsOf(h)).toEqual([
      { row: 0, col: 0, input: "=C1*$A$9" },
      { row: 0, col: 1, input: "=D1*$A$9" },
      { row: 1, col: 0, input: "=C2*$A$9" },
      { row: 1, col: 1, input: "=D2*$A$9" },
    ]);
    expect(h.commits[0].move).toBe("none");
    expect(h.selection.get().ranges).toEqual([range]);
    expect(h.selection.get().active).toEqual(A1);
  });

  it("Ctrl+Enter fills values with their number format", () => {
    const range = { r0: 0, c0: 0, r1: 2, c1: 0 };
    h.selection.set({ sheet: h.sheet, ranges: [range], activeRange: 0, active: A1, anchor: A1, kind: "cells" });
    type(h, "5%");
    h.session.handleKey(key("Enter", { ctrlKey: true }));
    expect(cellsOf(h)).toHaveLength(3);
    expect(cellsOf(h)[2]).toEqual({ row: 2, col: 0, input: "0.05", numFmt: "0%" });
  });

  it("Enter and Tab walk a multi-cell selection", () => {
    const range = { r0: 0, c0: 0, r1: 1, c1: 1 };
    h.selection.set({ sheet: h.sheet, ranges: [range], activeRange: 0, active: A1, anchor: A1, kind: "cells" });
    type(h, "1");
    h.session.handleKey(key("Enter"));
    expect(h.selection.get()).toMatchObject({ active: { row: 1, col: 0 }, ranges: [range] });
    type(h, "2");
    h.session.handleKey(key("Enter"));
    expect(h.selection.get().active).toEqual({ row: 0, col: 1 });
    type(h, "3");
    h.session.handleKey(key("Tab"));
    expect(h.selection.get().active).toEqual({ row: 1, col: 0 });
  });

  it("clicking another cell commits in place", () => {
    type(h, "x");
    h.selection.set(singleCellSelection(h.sheet, { row: 4, col: 4 }));
    expect(h.session.getState().status).toBe("idle");
    expect(h.commits[0]).toMatchObject({ move: "none" });
    expect(cellsOf(h)[0]).toMatchObject({ row: 0, col: 0, input: "x" });
    expect(h.selection.get().active).toEqual({ row: 4, col: 4 });
  });

  it("ignores keys while an IME composition is in progress", () => {
    type(h, "k");
    expect(h.session.handleKey(key("Enter", { isComposing: true }))).toBe(false);
    expect(h.session.handleKey(key("Enter", { keyCode: 229 }))).toBe(false);
    expect(h.session.getState().status).toBe("editing");
  });

  it("supports undo/redo inside the editor", () => {
    type(h, "abc");
    h.session.handleKey(key("z", { ctrlKey: true }));
    expect(h.session.getState().text).toBe("ab");
    h.session.handleKey(key("y", { ctrlKey: true }));
    expect(h.session.getState().text).toBe("abc");
  });
});

describe("EditSession — formulas", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it("auto-closes parentheses on commit", () => {
    type(h, "=SUM(B1:B3");
    expect(h.session.getState().completion).toBeNull();
    h.session.handleKey(key("Tab"));
    expect(cellsOf(h)).toEqual([{ row: 0, col: 0, input: "=SUM(B1:B3)" }]);
  });

  it("keeps the editor open with a Spanish message on an invalid formula", () => {
    type(h, "=A1+");
    h.session.handleKey(key("Enter"));
    const s = h.session.getState();
    expect(s.status).toBe("editing");
    expect(s.error).toMatch(/Hay un problema con esta fórmula/);
    expect(h.commits).toHaveLength(0);
    h.session.handleKey(key("Enter"));
    expect(h.session.getState().error).toBeNull();
    expect(h.session.getState().status).toBe("editing");
  });

  it("reopens the editor when the engine rejects the formula", async () => {
    h.failNext = new EngineError("invalidFormula", "La fórmula contiene un error.");
    type(h, "=FOO(");
    expect(h.session.getState().completion).toBeNull();
    h.session.handleKey(key("Enter"));
    expect(h.selection.get().active).toEqual({ row: 1, col: 0 });
    await flush();
    const s = h.session.getState();
    expect(s).toMatchObject({ status: "editing", cell: A1, text: "=FOO()", error: "La fórmula contiene un error." });
    expect(h.selection.get().active).toEqual(A1);
  });

  it("picks references with arrow keys in Enter mode", () => {
    h.selection.set(singleCellSelection(h.sheet, { row: 2, col: 2 })); // C3
    type(h, "=");
    expect(h.session.getState().canPick).toBe(true);
    h.session.handleKey(key("ArrowRight"));
    expect(h.session.getState()).toMatchObject({ text: "=D3", mode: "point" });
    h.session.handleKey(key("ArrowDown"));
    expect(h.session.getState().text).toBe("=D4");
    h.session.handleKey(key("ArrowDown", { shiftKey: true }));
    h.session.handleKey(key("ArrowRight", { shiftKey: true }));
    expect(h.session.getState().text).toBe("=D4:E5");
    expect(h.grid.scrolledTo.at(-1)).toEqual({ row: 4, col: 4 });
    type(h, "+");
    expect(h.session.getState().mode).toBe("enter");
    h.session.handleKey(key("ArrowUp"));
    expect(h.session.getState().text).toBe("=D4:E5+C2");
    // a non-pickable position: arrows commit
    type(h, "*2");
    h.session.handleKey(key("ArrowDown"));
    expect(cellsOf(h)[0].input).toBe("=D4:E5+C2*2");
  });

  it("installs the grid reference picker where a ref may go", () => {
    type(h, "=SUM(");
    expect(h.grid.picker).not.toBeNull();
    h.grid.picker!.onPick({ r0: 1, c0: 1, r1: 3, c1: 2 }, false);
    expect(h.session.getState().text).toBe("=SUM(B2:C4");
    const focus = h.session.getState().focusRequest;
    h.grid.picker!.onPick({ r0: 1, c0: 1, r1: 4, c1: 3 }, true);
    expect(h.session.getState().text).toBe("=SUM(B2:D5");
    expect(h.session.getState().focusRequest).toBe(focus + 1);
    type(h, ")");
    expect(h.grid.picker).toBeNull();
    h.session.handleKey(key("Enter"));
    expect(h.grid.picker).toBeNull();
    expect(h.grid.highlights).toEqual([]);
  });

  it("pushes colored ref highlights to the grid", () => {
    type(h, "=A1+B2:C3+'Mi hoja'!A1+A1");
    expect(h.grid.highlights.map((x) => x.range)).toEqual([
      { r0: 0, c0: 0, r1: 0, c1: 0 },
      { r0: 1, c0: 1, r1: 2, c1: 2 },
    ]);
    expect(h.session.getState().refs).toHaveLength(4);
    h.session.handleKey(key("Escape"));
    expect(h.grid.highlights).toEqual([]);
  });

  it("F4 cycles the reference at the caret", () => {
    type(h, "=A1");
    h.session.handleKey(key("F4"));
    expect(h.session.getState()).toMatchObject({ text: "=$A$1", selStart: 5 });
    h.session.handleKey(key("F4"));
    expect(h.session.getState().text).toBe("=A$1");
  });

  it("autocompletes function names with keyboard navigation", () => {
    type(h, "=SUMI");
    let s = h.session.getState();
    expect(s.completion?.items.slice(0, 2).map((f) => f.name)).toEqual(["SUMIF", "SUMIFS"]);
    h.session.handleKey(key("ArrowDown"));
    expect(h.session.getState().completion?.index).toBe(1);
    h.session.handleKey(key("Tab"));
    s = h.session.getState();
    expect(s).toMatchObject({ text: "=SUMIFS(", selStart: 8, completion: null, status: "editing" });
    expect(s.signature).toMatchObject({ fn: { name: "SUMIFS" }, argIndex: 0 });
    type(h, "A1:A3,");
    expect(h.session.getState().signature?.argIndex).toBe(1);
  });

  it("Esc closes the completion list first, then cancels", () => {
    type(h, "=SU");
    h.session.handleKey(key("Escape"));
    expect(h.session.getState()).toMatchObject({ status: "editing", completion: null });
    h.session.handleKey(key("Escape"));
    expect(h.session.getState().status).toBe("idle");
  });

  it("finds functions by their Spanish name", () => {
    type(h, "=BUSCARV");
    expect(h.session.getState().completion?.items[0].name).toBe("VLOOKUP");
    h.session.handleKey(key("Enter"));
    expect(h.session.getState().text).toBe("=VLOOKUP(");
  });

  it("fx opens the function list in the formula bar", () => {
    h.session.openFunctionList();
    const s = h.session.getState();
    expect(s).toMatchObject({ status: "editing", surface: "bar", text: "=" });
    expect(s.completion?.items.length).toBeGreaterThan(10);
  });

  it("+/- formulas are committed as formulas", () => {
    type(h, "-B1");
    h.session.handleKey(key("Enter"));
    expect(cellsOf(h)[0].input).toBe("=-B1");
  });
});

describe("EditSession — formula bar, name box and value autocomplete", () => {
  it("starts editing in the bar in Edit mode", async () => {
    const h = await setup();
    await h.engine.apply(h.doc, [{ type: "setCells", sheet: h.sheet, cells: [{ row: 0, col: 0, input: "=1+2" }] }]);
    h.session.startInBar();
    await flush();
    expect(h.session.getState()).toMatchObject({ status: "editing", surface: "bar", mode: "edit", text: "=1+2" });
    h.session.setSurface("cell");
    expect(h.session.getState().surface).toBe("cell");
  });

  it("navigates from the name box", async () => {
    navigations = [];
    const h = await setup();
    expect(h.session.navigateTo("b7")).toBeNull();
    expect(h.selection.get()).toMatchObject({ active: { row: 6, col: 1 }, kind: "cells" });
    expect(h.session.navigateTo("A1:C10")).toBeNull();
    expect(h.selection.get().ranges).toEqual([{ r0: 0, c0: 0, r1: 9, c1: 2 }]);
    expect(h.session.navigateTo("B:C")).toBeNull();
    expect(h.selection.get().kind).toBe("cols");
    expect(h.session.navigateTo("Hoja1!D4")).toBeNull();
    expect(h.selection.get().active).toEqual({ row: 3, col: 3 });
    expect(h.session.navigateTo("'Mi hoja'!A1:B2")).toBeNull();
    expect(navigations).toEqual([{ id: 99, range: { r0: 0, c0: 0, r1: 1, c1: 1 } }]);
    expect(h.session.navigateTo("Nada!A1")).toBe("Referencia no válida.");
    expect(h.session.navigateTo("hola mundo")).toBe("Referencia no válida.");
    expect(h.grid.scrolledTo.length).toBeGreaterThan(0);
  });

  it("suggests existing text from the same column", async () => {
    const h = await setup({ valueAutoComplete: true });
    await h.engine.apply(h.doc, [
      { type: "setCells", sheet: h.sheet, cells: [{ row: 0, col: 0, input: "Madrid" }, { row: 1, col: 0, input: "Mallorca" }, { row: 2, col: 0, input: "Bilbao" }] },
    ]);
    h.selection.set(singleCellSelection(h.sheet, { row: 3, col: 0 }));
    h.session.start({ cell: { row: 3, col: 0 }, source: "type", initialText: "M" });
    await flush();
    type(h, "a");
    expect(h.session.getState()).toMatchObject({ text: "Ma", suggestion: "" }); // Madrid / Mallorca: ambiguous
    type(h, "d");
    expect(h.session.getState()).toMatchObject({ text: "Mad", suggestion: "rid", selStart: 3, selEnd: 6 });
    h.session.handleKey(key("Enter"));
    expect(cellsOf(h)[0].input).toBe("Madrid");
  });

  it("Backspace drops the suggestion", async () => {
    const h = await setup({ valueAutoComplete: true });
    await h.engine.apply(h.doc, [{ type: "setCells", sheet: h.sheet, cells: [{ row: 0, col: 0, input: "Bilbao" }] }]);
    h.selection.set(singleCellSelection(h.sheet, { row: 1, col: 0 }));
    h.session.start({ cell: { row: 1, col: 0 }, source: "type", initialText: "B" });
    await flush();
    type(h, "i");
    expect(h.session.getState().suggestion).toBe("lbao");
    h.session.setText("Bi", 2, 2, "deleteContentBackward");
    expect(h.session.getState()).toMatchObject({ text: "Bi", suggestion: "" });
  });
});
