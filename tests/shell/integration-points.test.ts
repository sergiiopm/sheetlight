import { describe, expect, it } from "vitest";
import type { ChartInsertContext } from "@/hooks/chart-integration";
import { rangeSelection } from "@/hooks/selection-ops";
import type { ShellEditor } from "@/hooks/workbook-session";
import { controllerSetup } from "./helpers";

function fakeEditor(editing: boolean, accept = true) {
  const calls: string[] = [];
  const editor: ShellEditor & { calls: string[]; editing: boolean } = {
    calls,
    editing,
    isEditing: () => editor.editing,
    commit: () => {
      calls.push("commit");
      if (accept) editor.editing = false;
      return accept;
    },
    cancel: () => {
      calls.push("cancel");
      editor.editing = false;
    },
  };
  return editor;
}

describe("chart integration seam", () => {
  it("keeps Insertar > Gráfico disabled until a handler is injected", async () => {
    const { controller, session } = await controllerSetup();
    const command = controller.registry.get("insert.chart");
    expect(command?.label).toBe("Gráfico");
    expect(command?.isEnabled?.()).toBe(false);

    const received: ChartInsertContext[] = [];
    controller.charts.setInsertHandler((context) => {
      received.push(context);
    });
    expect(command?.isEnabled?.()).toBe(true);

    const range = { r0: 0, c0: 0, r1: 4, c1: 1 };
    session.selection.set(rangeSelection(session.activeSheet, range));
    expect(await controller.runCommand("insert.chart", "menu")).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].doc).toBe(session.doc);
    expect(received[0].sheet).toBe(session.activeSheet);
    expect(received[0].selection.ranges).toEqual([range]);
  });

  it("routes chart ops through the shell apply (dirty state, undo)", async () => {
    const { controller, session, engine } = await controllerSetup();
    controller.charts.setInsertHandler(async (context) => {
      await context.apply([{ type: "setFrozen", sheet: context.sheet, rows: 1, cols: 0 }]);
    });
    await controller.runCommand("insert.chart");
    expect(engine.lastOps()[0]).toMatchObject({ type: "setFrozen" });
    expect(session.info.canUndo).toBe(true);
  });

  it("stores the overlay layer component", async () => {
    const { controller } = await controllerSetup();
    const Layer = () => null;
    controller.charts.setLayer(Layer);
    expect(controller.charts.layer.get()).toBe(Layer);
    controller.charts.setLayer(null);
    expect(controller.charts.layer.get()).toBeNull();
  });
});

describe("pending cell edits", () => {
  it("commits the entry before a toolbar command runs", async () => {
    const { controller, session, engine } = await controllerSetup();
    const editor = fakeEditor(true);
    session.editor = editor;
    await controller.runCommand("format.bold", "toolbar");
    expect(editor.calls).toEqual(["commit"]);
    expect(engine.lastOps()[0]).toMatchObject({ type: "setStyle" });
  });

  it("does not run the command when the entry is invalid", async () => {
    const { controller, session, engine } = await controllerSetup();
    session.editor = fakeEditor(true, false);
    const before = engine.batches.length;
    expect(await controller.runCommand("format.bold", "toolbar")).toBe(false);
    expect(engine.batches.length).toBe(before);
  });

  it("Deshacer while editing cancels the entry instead", async () => {
    const { controller, session } = await controllerSetup();
    const editor = fakeEditor(true);
    session.editor = editor;
    await controller.runCommand("edit.undo", "toolbar");
    expect(editor.calls).toEqual(["cancel"]);
  });

  it("leaves the editor alone when idle", async () => {
    const { controller, session } = await controllerSetup();
    const editor = fakeEditor(false);
    session.editor = editor;
    await controller.runCommand("format.italic", "toolbar");
    expect(editor.calls).toEqual([]);
  });
});
