import { describe, expect, it } from "vitest";
import { windowTitle } from "@/hooks/workbook-session";
import { setup } from "./helpers";

describe("SessionManager: documents", () => {
  it("starts with one untitled workbook", async () => {
    const { manager } = await setup();
    expect(manager.sessions).toHaveLength(1);
    const session = manager.active!;
    expect(session.fileName).toBe("Libro1.xlsx");
    expect(session.isPristine()).toBe(true);
    expect(windowTitle(session.meta.get())).toBe("Libro1.xlsx — Sheetlight");
  });

  it("numbers new workbooks like Excel and reuses free numbers", async () => {
    const { manager } = await setup();
    await manager.newWorkbook();
    await manager.newWorkbook();
    expect(manager.sessions.map((s) => s.fileName)).toEqual(["Libro1.xlsx", "Libro2.xlsx", "Libro3.xlsx"]);
    await manager.close(manager.sessions[1].id);
    await manager.newWorkbook();
    expect(manager.sessions.map((s) => s.fileName)).toEqual(["Libro1.xlsx", "Libro3.xlsx", "Libro2.xlsx"]);
  });

  it("opening a file replaces a pristine workbook and re-activates already open files", async () => {
    const { manager, engine, hooks } = await setup();
    engine.files.set("C:\\datos\\ventas.csv", "a;b\n1;2");
    const first = await manager.openPath("C:\\datos\\ventas.csv");
    expect(manager.sessions).toHaveLength(1);
    expect(manager.active).toBe(first);
    expect(first?.fileName).toBe("ventas.csv");
    expect(hooks.used).toEqual(["C:\\datos\\ventas.csv"]);
    await manager.newWorkbook();
    const again = await manager.openPath("c:/DATOS/ventas.csv");
    expect(again).toBe(first);
    expect(manager.active).toBe(first);
    expect(engine.opened).toHaveLength(1);
  });

  it("rejects unsupported files with a Spanish message", async () => {
    const { manager, hooks } = await setup();
    expect(await manager.openPath("C:\\notas.docx")).toBeNull();
    expect(hooks.errors[0]).toContain("«notas.docx»");
  });

  it("opens queued paths in order", async () => {
    const { manager, engine } = await setup();
    engine.files.set("C:\\a.csv", "1");
    engine.files.set("C:\\b.csv", "2");
    await manager.openPaths(["C:\\a.csv", "C:\\b.csv"]);
    expect(manager.sessions.map((s) => s.fileName)).toEqual(["a.csv", "b.csv"]);
    expect(manager.active?.fileName).toBe("b.csv");
  });

  it("passes CSV defaults when opening CSV files", async () => {
    const { engine, manager, hooks } = await setup();
    hooks.csvDefaults = () => ({ delimiter: ";" });
    engine.files.set("C:\\x.csv", "1");
    await manager.openPath("C:\\x.csv");
    expect(engine.opened[0].options).toEqual({ csv: { delimiter: ";" } });
  });

  it("opens browser files through openBytes", async () => {
    const { manager, files } = await setup(false);
    files.browserFiles = [{ name: "datos.csv", bytes: new TextEncoder().encode("x,y\n1,2") }];
    await manager.open();
    expect(manager.active?.fileName).toBe("datos.csv");
    expect(manager.active?.source.kind).toBe("bytes");
  });

  it("cycles and moves tabs", async () => {
    const { manager } = await setup();
    await manager.newWorkbook();
    await manager.newWorkbook();
    const [a, b, c] = manager.sessions;
    manager.cycle(1);
    expect(manager.active).toBe(a);
    manager.cycle(-1);
    expect(manager.active).toBe(c);
    manager.move(a.id, c.id);
    expect(manager.sessions).toEqual([b, c, a]);
  });
});

describe("SessionManager: dirty state, save and close", () => {
  it("tracks dirty/undo state from engine events and apply results", async () => {
    const { manager } = await setup();
    const session = manager.active!;
    await manager.apply(session, [{ type: "setCells", sheet: session.activeSheet, cells: [{ row: 0, col: 0, input: "5" }] }]);
    expect(session.info.dirty).toBe(true);
    expect(session.info.canUndo).toBe(true);
    expect(windowTitle(session.meta.get())).toBe("• Libro1.xlsx — Sheetlight");
    await manager.undo(session);
    expect(session.info.canRedo).toBe(true);
  });

  it("saves new workbooks through Guardar como and remembers the path", async () => {
    const { manager, files, engine, hooks } = await setup();
    const session = manager.active!;
    await manager.apply(session, [{ type: "setCells", sheet: session.activeSheet, cells: [{ row: 0, col: 0, input: "1" }] }]);
    files.savePath = null;
    expect(await manager.save(session)).toBe(false);
    files.savePath = "C:\\Docs\\Presupuesto.xlsx";
    expect(await manager.save(session)).toBe(true);
    expect(engine.saved).toEqual([{ path: "C:\\Docs\\Presupuesto.xlsx", format: "xlsx" }]);
    expect(session.info.dirty).toBe(false);
    expect(session.fileName).toBe("Presupuesto.xlsx");
    expect(hooks.used).toContain("C:\\Docs\\Presupuesto.xlsx");
    // Ctrl+S again writes in place.
    await manager.save(session);
    expect(engine.saved).toHaveLength(2);
  });

  it("saves legacy .xls through Guardar como with an .xlsx suggestion", async () => {
    const { manager, files, engine } = await setup();
    engine.files.set("C:\\viejo.xls", "1");
    const session = (await manager.openPath("C:\\viejo.xls"))!;
    let suggested = "";
    files.pickSavePath = async (name) => {
      suggested = name;
      return null;
    };
    await manager.save(session);
    expect(suggested).toBe("C:\\viejo.xlsx");
  });

  it("warns when a multi-sheet workbook is saved as CSV", async () => {
    const { manager, files, hooks } = await setup();
    const session = manager.active!;
    await manager.apply(session, [{ type: "addSheet" }]);
    files.savePath = "C:\\out.csv";
    await manager.saveAs(session);
    expect(hooks.infos[0]).toContain("CSV solo guarda una hoja");
  });

  it("asks before closing a dirty tab and honours the answer", async () => {
    const { manager, files } = await setup();
    const session = manager.active!;
    await manager.apply(session, [{ type: "setCells", sheet: session.activeSheet, cells: [{ row: 0, col: 0, input: "1" }] }]);
    manager.requestClose(session.id);
    expect(manager.pending.get()).toEqual({ sessionId: session.id, closeWindow: false });
    await manager.confirmPending("cancel");
    expect(manager.sessions).toContain(session);
    manager.requestClose(session.id);
    files.savePath = "C:\\x.xlsx";
    await manager.confirmPending("save");
    expect(manager.sessions).not.toContain(session);
    // Always one workbook open.
    expect(manager.sessions).toHaveLength(1);
  });

  it("walks every unsaved workbook before closing the window", async () => {
    const { manager, hooks } = await setup();
    const a = manager.active!;
    const b = (await manager.newWorkbook())!;
    for (const s of [a, b]) await manager.apply(s, [{ type: "setCells", sheet: s.activeSheet, cells: [{ row: 0, col: 0, input: "1" }] }]);
    expect(await manager.requestCloseWindow()).toBe(false);
    expect(manager.pending.get()?.sessionId).toBe(a.id);
    await manager.confirmPending("discard");
    expect(manager.pending.get()?.sessionId).toBe(b.id);
    expect(hooks.destroyed).toBe(0);
    await manager.confirmPending("discard");
    expect(hooks.destroyed).toBe(1);
  });

  it("closes the window directly when nothing is dirty", async () => {
    const { manager, hooks } = await setup();
    expect(await manager.requestCloseWindow()).toBe(true);
    expect(hooks.destroyed).toBe(1);
  });
});

describe("WorkbookSession: sheets and selection", () => {
  it("keeps the last selection of each sheet", async () => {
    const { manager } = await setup();
    const session = manager.active!;
    const first = session.activeSheet;
    const result = await manager.apply(session, [{ type: "addSheet", name: "Datos" }]);
    const second = result!.created[0];
    session.selection.set({ ...session.selection.get(), active: { row: 4, col: 2 }, anchor: { row: 4, col: 2 }, ranges: [{ r0: 4, c0: 2, r1: 4, c1: 2 }] });
    await manager.setActiveSheet(session, second);
    expect(session.activeSheet).toBe(second);
    expect(session.selection.get().sheet).toBe(second);
    expect(session.selection.get().active).toEqual({ row: 0, col: 0 });
    await manager.setActiveSheet(session, first);
    expect(session.selection.get().active).toEqual({ row: 4, col: 2 });
  });

  it("keeps the zoom per sheet", async () => {
    const { manager } = await setup();
    const session = manager.active!;
    const first = session.activeSheet;
    const second = (await manager.apply(session, [{ type: "addSheet" }]))!.created[0];
    session.setViewport({ topLeft: { row: 10, col: 0 }, zoom: 1.5 });
    expect(session.zoom.get()).toBe(1.5);
    await manager.setActiveSheet(session, second);
    expect(session.zoom.get()).toBe(1);
    await manager.setActiveSheet(session, first);
    expect(session.zoom.get()).toBe(1.5);
    expect(session.viewFor(first).topLeft).toEqual({ row: 10, col: 0 });
  });

  it("follows sheet list changes and falls back when the active sheet is deleted", async () => {
    const { manager } = await setup();
    const session = manager.active!;
    const first = session.activeSheet;
    const second = (await manager.apply(session, [{ type: "addSheet", name: "B" }]))!.created[0];
    expect(session.info.sheets.map((s) => s.name)).toEqual(["Hoja1", "B"]);
    await manager.setActiveSheet(session, second);
    await manager.apply(session, [{ type: "deleteSheet", sheet: second }]);
    expect(session.activeSheet).toBe(first);
    expect(session.selection.get().sheet).toBe(first);
  });

  it("applies selection hints from apply results", async () => {
    const { manager } = await setup();
    const session = manager.active!;
    const engine = manager.engine;
    const original = engine.apply.bind(engine);
    engine.apply = async (doc, ops) => ({
      ...(await original(doc, ops)),
      selection: { sheet: session.activeSheet, ranges: [{ r0: 2, c0: 1, r1: 5, c1: 3 }], active: { row: 2, col: 1 } },
    });
    await manager.apply(session, [{ type: "setCells", sheet: session.activeSheet, cells: [{ row: 2, col: 1, input: "x" }] }]);
    expect(session.selection.get().ranges).toEqual([{ r0: 2, c0: 1, r1: 5, c1: 3 }]);
    expect(session.selection.get().active).toEqual({ row: 2, col: 1 });
  });

  it("reports engine errors in Spanish and leaves state intact", async () => {
    const { manager, hooks } = await setup();
    const session = manager.active!;
    expect(await manager.apply(session, [{ type: "renameSheet", sheet: session.activeSheet, name: "a/b" }])).toBeNull();
    expect(hooks.errors).toEqual(["El nombre de la hoja no es válido."]);
  });

  it("tracks CSV loading progress", async () => {
    const { manager } = await setup();
    const session = manager.active!;
    session.handleEvent({ type: "loadProgress", doc: session.doc, rowsLoaded: 500, bytesRead: 50, bytesTotal: 100, done: false, error: null });
    expect(session.load.get()).toMatchObject({ rowsLoaded: 500, bytesRead: 50 });
    session.handleEvent({ type: "loadProgress", doc: session.doc, rowsLoaded: 1000, bytesRead: 100, bytesTotal: 100, done: true, error: null });
    expect(session.load.get()).toBeNull();
    session.handleEvent({ type: "backendChanged", doc: session.doc, backend: "csv" });
    expect(session.info.backend).toBe("csv");
  });
});
