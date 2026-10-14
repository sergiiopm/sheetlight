import { describe, expect, it } from "vitest";
import { blockCellText } from "@/engine/block-codec";
import { CellKind, EngineError, type EngineEvent } from "@/engine/contract";
import { MemoryEngine } from "@/engine/memory-engine";

describe("MemoryEngine (contract fake)", () => {
  it("sets cells, serves blocks and undoes as one step per batch", async () => {
    const engine = new MemoryEngine();
    const info = await engine.newDocument();
    const sheet = info.activeSheet;
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    const result = await engine.apply(info.doc, [
      { type: "setCells", sheet, cells: [{ row: 0, col: 0, input: "1234.5" }, { row: 1, col: 0, input: "hola" }] },
      { type: "setStyle", sheet, ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], patch: { bold: true } },
    ]);
    expect(result).toMatchObject({ dirty: true, canUndo: true, canRedo: false });
    expect(events.some((e) => e.type === "sheetData")).toBe(true);

    const [block] = await engine.fetchBlocks(info.doc, { sheet, keys: [{ br: 0, bc: 0 }], priority: 0 });
    expect(blockCellText(block, 0)).toBe("1234,5");
    expect(block.kinds[0]).toBe(CellKind.Number);
    const [[, style]] = await engine.getStyles(info.doc, [block.styleIds[0]]);
    expect(style.bold).toBe(true);

    const stats = await engine.getSelectionStats(info.doc, sheet, [{ r0: 0, c0: 0, r1: 5, c1: 0 }]);
    expect(stats).toMatchObject({ count: 2, numericCount: 1, sum: 1234.5 });

    await engine.undo(info.doc);
    expect((await engine.getCell(info.doc, sheet, { row: 0, col: 0 })).input).toBe("");
    await engine.redo(info.doc);
    expect((await engine.getCell(info.doc, sheet, { row: 0, col: 0 })).input).toBe("1234.5");
  });

  it("validates sheet names and rolls back failed batches", async () => {
    const engine = new MemoryEngine();
    const info = await engine.newDocument();
    const sheet = info.activeSheet;
    await expect(
      engine.apply(info.doc, [
        { type: "setCells", sheet, cells: [{ row: 0, col: 0, input: "x" }] },
        { type: "renameSheet", sheet, name: "a/b" },
      ]),
    ).rejects.toBeInstanceOf(EngineError);
    expect((await engine.getCell(info.doc, sheet, { row: 0, col: 0 })).input).toBe("");
  });

  it("finds Ctrl+Arrow data edges like Excel", async () => {
    const engine = new MemoryEngine();
    const info = await engine.newDocument();
    const sheet = info.activeSheet;
    await engine.apply(info.doc, [
      { type: "setCells", sheet, cells: [0, 1, 2, 10].map((row) => ({ row, col: 0, input: String(row) })) },
    ]);
    expect(await engine.findDataEdge(info.doc, sheet, { row: 0, col: 0 }, "down")).toEqual({ row: 2, col: 0 });
    expect(await engine.findDataEdge(info.doc, sheet, { row: 2, col: 0 }, "down")).toEqual({ row: 10, col: 0 });
  });
});
