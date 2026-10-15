import { describe, expect, it } from "vitest";
import { MAX_COLS } from "@/engine/types";
import type { GridHandle } from "@/grid/api";
import { rangeSelection } from "@/hooks/selection-ops";
import { pickNext } from "@/hooks/actions/find-actions";
import * as find from "@/hooks/actions/find-actions";
import { controllerSetup } from "./helpers";

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function key(k: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; code?: string; target?: EventTarget | null } = {}) {
  let prevented = false;
  return {
    key: k,
    code: mods.code,
    ctrlKey: Boolean(mods.ctrl),
    metaKey: false,
    shiftKey: Boolean(mods.shift),
    altKey: Boolean(mods.alt),
    target: mods.target ?? null,
    defaultPrevented: false,
    preventDefault: () => {
      prevented = true;
    },
    get prevented() {
      return prevented;
    },
  };
}

function fakeGrid(): GridHandle & { marquee: unknown; cursor: string } {
  const grid = {
    marquee: null as unknown,
    cursor: "default",
    focus: () => undefined,
    getCellRect: () => null,
    scrollIntoView: () => undefined,
    getViewport: () => ({ topLeft: { row: 0, col: 0 }, zoom: 1 }),
    setZoom: () => undefined,
    setRefHighlights: () => undefined,
    setReferencePicker: () => undefined,
    setCopyMarquee: (range: unknown) => {
      grid.marquee = range;
    },
    setCursorMode: (mode: string) => {
      grid.cursor = mode;
    },
    measureAutofit: async (cols: ReadonlyArray<number>) => cols.map(() => 100),
    getRangeRect: () => new DOMRectReadOnly(),
    getOverlayHost: () => ({}) as HTMLElement,
    subscribeViewport: () => () => undefined,
  };
  return grid as unknown as GridHandle & { marquee: unknown; cursor: string };
}

describe("format commands", () => {
  it("toggles bold from the active cell state", async () => {
    const { controller, engine, session } = await controllerSetup();
    expect(controller.registry.get("format.bold")?.isActive?.()).toBe(false);
    await controller.runCommand("format.bold");
    expect(engine.lastOps()).toEqual([{ type: "setStyle", sheet: session.activeSheet, ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], patch: { bold: true } }]);
    await controller.refresh();
    expect(controller.registry.get("format.bold")?.isActive?.()).toBe(true);
    await controller.runCommand("format.bold");
    expect(engine.lastOps()[0]).toMatchObject({ patch: { bold: false } });
  });

  it("applies number format presets and decimal steps", async () => {
    const { controller, engine, session } = await controllerSetup();
    await controller.apply([{ type: "setCells", sheet: session.activeSheet, cells: [{ row: 0, col: 0, input: "1.5" }] }]);
    await controller.refresh();
    await controller.runCommand("format.decimals.increase");
    expect(engine.lastOps()[0]).toMatchObject({ type: "setStyle", patch: { numFmt: "0.00" } });
    await controller.runCommand("format.numFmt.currency");
    expect(engine.lastOps()[0]).toMatchObject({ patch: { numFmt: '#,##0.00\\ "€"' } });
    await controller.refresh();
    expect(controller.registry.get("format.numFmt.currency")?.isActive?.()).toBe(true);
  });

  it("steps font size and remembers border choices", async () => {
    const { controller, engine } = await controllerSetup();
    await controller.runCommand("format.fontGrow");
    expect(engine.lastOps()[0]).toMatchObject({ patch: { fontSize: 12 } });
    await controller.runCommand("format.borders.thickOuter");
    expect(engine.lastOps()[0]).toMatchObject({ type: "setBorders", preset: "thickOuter", style: "thick" });
    await controller.runCommand("format.borders");
    expect(engine.lastOps()[0]).toMatchObject({ type: "setBorders", preset: "thickOuter", style: "thin" });
  });

  it("merge & center toggles", async () => {
    const { controller, engine, session } = await controllerSetup();
    session.selection.set(rangeSelection(session.activeSheet, { r0: 0, c0: 0, r1: 0, c1: 2 }));
    await controller.runCommand("format.mergeCenter");
    expect(engine.lastOps()[0]).toMatchObject({ type: "merge", mode: "mergeCenter" });
    await controller.refresh();
    await controller.runCommand("format.mergeCenter");
    expect(engine.lastOps()[0]).toMatchObject({ type: "unmerge" });
  });
});

describe("structure and data commands", () => {
  it("Ctrl++ inserts whole rows directly and opens the dialog for cells", async () => {
    const { controller, engine, session } = await controllerSetup();
    session.selection.set(rangeSelection(session.activeSheet, { r0: 2, c0: 0, r1: 3, c1: MAX_COLS - 1 }));
    expect(controller.handleKey(key("+", { ctrl: true, code: "BracketRight" }), "grid")).toBe(true);
    await flush();
    expect(engine.lastOps()).toEqual([{ type: "insertRows", sheet: session.activeSheet, index: 2, count: 2 }]);
    session.selection.set(rangeSelection(session.activeSheet, { r0: 2, c0: 1, r1: 3, c1: 2 }));
    controller.handleKey(key("-", { ctrl: true }), "grid");
    await flush();
    expect(controller.dialog.get()).toEqual({ kind: "deleteCells" });
  });

  it("sorts the used range by the active column with a header guess", async () => {
    const { controller, engine, session } = await controllerSetup();
    const sheet = session.activeSheet;
    await controller.apply([
      {
        type: "setCells",
        sheet,
        cells: [
          { row: 0, col: 0, input: "Nombre" },
          { row: 0, col: 1, input: "Importe" },
          { row: 1, col: 0, input: "Ana" },
          { row: 1, col: 1, input: "5" },
          { row: 2, col: 0, input: "Luis" },
          { row: 2, col: 1, input: "3" },
        ],
      },
    ]);
    session.selection.set(rangeSelection(sheet, { r0: 1, c0: 1, r1: 1, c1: 1 }));
    await controller.runCommand("data.sortDesc");
    expect(engine.lastOps()).toEqual([{ type: "sort", sheet, range: { r0: 0, c0: 0, r1: 2, c1: 1 }, keys: [{ col: 1, ascending: false }], hasHeader: true }]);
  });

  it("toggles the autofilter on the used range", async () => {
    const { controller, engine, session } = await controllerSetup();
    const sheet = session.activeSheet;
    await controller.apply([{ type: "setCells", sheet, cells: [{ row: 0, col: 0, input: "a" }, { row: 4, col: 2, input: "b" }] }]);
    controller.handleKey(key("L", { ctrl: true, shift: true }), "grid");
    await flush();
    expect(engine.lastOps()).toEqual([{ type: "setAutoFilter", sheet, range: { r0: 0, c0: 0, r1: 4, c1: 2 } }]);
  });

  it("freezes panes at the active cell", async () => {
    const { controller, engine, session } = await controllerSetup();
    session.selection.set(rangeSelection(session.activeSheet, { r0: 1, c0: 1, r1: 1, c1: 1 }));
    await controller.runCommand("view.freezePanes");
    expect(engine.lastOps()).toEqual([{ type: "setFrozen", sheet: session.activeSheet, rows: 1, cols: 1 }]);
    await controller.refresh();
    expect(controller.registry.get("view.freezePanes")?.isActive?.()).toBe(true);
    await controller.runCommand("view.freezePanes");
    expect(engine.lastOps()).toEqual([{ type: "setFrozen", sheet: session.activeSheet, rows: 0, cols: 0 }]);
  });

  it("enables undo/redo from the document state", async () => {
    const { controller, session } = await controllerSetup();
    expect(controller.registry.get("edit.undo")?.isEnabled?.()).toBe(false);
    await controller.apply([{ type: "setCells", sheet: session.activeSheet, cells: [{ row: 0, col: 0, input: "1" }] }]);
    expect(controller.registry.get("edit.undo")?.isEnabled?.()).toBe(true);
    await controller.runCommand("edit.undo");
    expect(controller.registry.get("edit.redo")?.isEnabled?.()).toBe(true);
  });
});

describe("sheet commands", () => {
  it("adds a sheet after the active one and shows it", async () => {
    const { controller, session } = await controllerSetup();
    controller.handleKey(key("F11", { shift: true }), "window");
    await flush();
    expect(session.info.sheets.map((s) => s.name)).toEqual(["Hoja1", "Hoja2"]);
    expect(session.activeSheet).toBe(session.info.sheets[1].id);
    controller.handleKey(key("PageUp", { ctrl: true }), "grid");
    await flush();
    expect(session.activeSheet).toBe(session.info.sheets[0].id);
  });

  it("refuses to delete the last visible sheet", async () => {
    const { controller } = await controllerSetup();
    await controller.runCommand("sheet.delete");
    expect(controller.dialog.get()).toBeNull();
    expect(controller.notices.get().at(-1)?.message).toContain("al menos una hoja visible");
  });
});

describe("keyboard routing", () => {
  it("ignores shortcuts typed in text fields except file commands", async () => {
    const { controller } = await controllerSetup();
    const input = { tagName: "INPUT", type: "text", isContentEditable: false } as unknown as EventTarget;
    expect(controller.handleKey(key("b", { ctrl: true, target: input }), "window")).toBe(false);
    const saveAs = key("F12", { target: input });
    expect(controller.handleKey(saveAs, "window")).toBe(true);
    expect(saveAs.prevented).toBe(true);
  });

  it("does not run grid commands while a dialog is open", async () => {
    const { controller } = await controllerSetup();
    controller.openDialog({ kind: "about" });
    expect(controller.handleKey(key("b", { ctrl: true }), "grid")).toBe(false);
  });

  it("lets Escape through when there is nothing to cancel", async () => {
    const { controller } = await controllerSetup();
    const esc = key("Escape");
    expect(controller.handleKey(esc, "grid")).toBe(false);
    expect(esc.prevented).toBe(false);
  });
});

describe("clipboard", () => {
  it("copies to the system clipboard, shows the marquee and pastes the internal clip", async () => {
    const { controller, engine, clipboard, session } = await controllerSetup();
    const grid = fakeGrid();
    controller.attachGrid(session, grid);
    const sheet = session.activeSheet;
    await controller.apply([{ type: "setCells", sheet, cells: [{ row: 0, col: 0, input: "7" }] }]);
    await controller.runCommand("edit.copy");
    expect(clipboard.written[0].text).toBe("7");
    expect(grid.marquee).toEqual({ r0: 0, c0: 0, r1: 0, c1: 0 });
    session.selection.set(rangeSelection(sheet, { r0: 3, c0: 3, r1: 3, c1: 3 }));
    await controller.runCommand("edit.paste");
    expect(engine.lastOps()).toEqual([
      { type: "paste", sheet, target: { r0: 3, c0: 3, r1: 3, c1: 3 }, source: { kind: "internal", clipId: 1, cut: false }, mode: "all" },
    ]);
    // Esc clears the marquee.
    controller.handleKey(key("Escape"), "grid");
    await flush();
    expect(grid.marquee).toBeNull();
  });

  it("pastes external HTML or text when the clipboard changed", async () => {
    const { controller, engine, clipboard } = await controllerSetup();
    await controller.runCommand("edit.copy");
    clipboard.contents = { text: "a\tb", html: "<table><tr><td>a</td><td>b</td></tr></table>" };
    await controller.runCommand("edit.paste");
    expect(engine.lastOps()[0]).toMatchObject({ type: "paste", source: { kind: "html" } });
    controller.handlePasteEvent({ text: "x\r\ny", html: null });
    await flush();
    expect(engine.lastOps()[0]).toMatchObject({ type: "paste", source: { kind: "text", text: "x\r\ny" } });
  });

  it("consumes a cut on its first paste", async () => {
    const { controller, engine } = await controllerSetup();
    await controller.runCommand("edit.cut");
    await controller.runCommand("edit.paste");
    expect(engine.lastOps()[0]).toMatchObject({ source: { kind: "internal", cut: true } });
    expect(controller.clipboard.clip.get()).toBeNull();
  });

  it("Ctrl+V waits for the DOM paste event and falls back to the Clipboard API", async () => {
    const { controller, engine, clipboard } = await controllerSetup();
    clipboard.contents = { text: "fallback", html: null };
    const event = key("v", { ctrl: true });
    expect(controller.handleKey(event, "grid")).toBe(true);
    expect(event.prevented).toBe(false);
    await flush();
    expect(engine.lastOps()[0]).toMatchObject({ type: "paste", source: { kind: "text", text: "fallback" } });
  });

  it("paints formats onto the next selection", async () => {
    const { controller, engine, session } = await controllerSetup();
    const grid = fakeGrid();
    controller.attachGrid(session, grid);
    await controller.runCommand("edit.formatPainter");
    expect(grid.cursor).toBe("formatPainter");
    session.selection.set(rangeSelection(session.activeSheet, { r0: 2, c0: 2, r1: 4, c1: 2 }));
    await controller.finishFormatPainter();
    expect(engine.lastOps()).toEqual([
      { type: "copyFormat", sheet: session.activeSheet, source: { r0: 0, c0: 0, r1: 0, c1: 0 }, targets: [{ r0: 2, c0: 2, r1: 4, c1: 2 }] },
    ]);
    expect(grid.cursor).toBe("default");
  });
});

describe("find and go to", () => {
  const sheets = [
    { id: 1, name: "A", hidden: false },
    { id: 2, name: "B", hidden: false },
  ];

  it("picks the next match in Excel order and wraps", () => {
    const matches = [
      { sheet: 2, row: 0, col: 0, display: "" },
      { sheet: 1, row: 5, col: 0, display: "" },
      { sheet: 1, row: 1, col: 3, display: "" },
    ];
    expect(pickNext(matches, { sheet: 1, row: 1, col: 3 }, sheets, false)).toMatchObject({ sheet: 1, row: 5 });
    expect(pickNext(matches, { sheet: 2, row: 0, col: 0 }, sheets, false)).toMatchObject({ sheet: 1, row: 1, col: 3 });
    expect(pickNext(matches, { sheet: 1, row: 1, col: 3 }, sheets, false, true)).toMatchObject({ sheet: 2 });
    expect(pickNext([], { sheet: 1, row: 0, col: 0 }, sheets, false)).toBeNull();
  });

  it("finds the next cell and selects it", async () => {
    const { controller, session } = await controllerSetup();
    const sheet = session.activeSheet;
    await controller.apply([{ type: "setCells", sheet, cells: [{ row: 2, col: 1, input: "Total" }, { row: 6, col: 0, input: "total" }] }]);
    const options = { ...find.DEFAULT_FIND_OPTIONS, text: "total" };
    await find.findNext(controller, options);
    expect(session.selection.get().active).toEqual({ row: 2, col: 1 });
    await find.findNext(controller, options);
    expect(session.selection.get().active).toEqual({ row: 6, col: 0 });
    expect(await find.findAll(controller, options)).toHaveLength(2);
    expect(await find.findAll(controller, { ...options, matchCase: true })).toHaveLength(1);
  });

  it("replaces the active match then moves on", async () => {
    const { controller, engine, session } = await controllerSetup();
    const sheet = session.activeSheet;
    await controller.apply([{ type: "setCells", sheet, cells: [{ row: 0, col: 0, input: "uno" }, { row: 3, col: 0, input: "uno" }] }]);
    const options = { ...find.DEFAULT_FIND_OPTIONS, text: "uno" };
    await find.replaceOne(controller, options, "dos");
    expect(engine.batches.at(-1)?.[0]).toMatchObject({ type: "replace", replacement: "dos", all: false, at: { sheet, row: 0, col: 0 } });
    expect(session.selection.get().active).toEqual({ row: 3, col: 0 });
    expect(await find.replaceAll(controller, options, "dos")).toBe(3);
  });

  it("goes to references on other sheets", async () => {
    const { controller, session } = await controllerSetup();
    await controller.runCommand("sheet.new");
    await flush();
    const [first] = session.info.sheets;
    expect(await find.goTo(controller, "Hoja1!C3:D4")).toBeNull();
    expect(session.activeSheet).toBe(first.id);
    expect(session.selection.get().ranges).toEqual([{ r0: 2, c0: 2, r1: 3, c1: 3 }]);
    expect(await find.goTo(controller, "zz!A1")).toContain("no es válida");
  });
});
