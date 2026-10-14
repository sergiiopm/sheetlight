/// <reference types="node" />
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLOCK_STATE_EMPTY,
  BLOCK_STATE_UNCHANGED,
  blockCellText,
  buildBlock,
  decodeBlocks,
  encodeBlocks,
} from "@/engine/block-codec";
import { BLOCK_COLS, BLOCK_SIZE, CellFlag, CellKind } from "@/engine/contract";

const GOLDEN = resolve(__dirname, "../fixtures/blocks-golden.bin");

/** Same content as `golden()` in `src-tauri/src/engine/blocks.rs`. */
function goldenBlocks(): ArrayBuffer {
  const cells: ({ text: string; kind: number; styleId: number; flags: number } | null)[] = new Array(BLOCK_SIZE).fill(null);
  cells[0] = { text: "Año", kind: CellKind.Text, styleId: 0, flags: 0 };
  cells[1] = { text: "1.234,5", kind: CellKind.Number, styleId: 2, flags: CellFlag.Formula };
  cells[BLOCK_COLS] = { text: "😀 ok", kind: CellKind.Text, styleId: 1, flags: 0 };
  cells[BLOCK_SIZE - 1] = { text: "#DIV/0!", kind: CellKind.Error, styleId: 0, flags: CellFlag.Formula };
  return encodeBlocks(3, [
    buildBlock(3, 0, 1, 7, cells),
    { br: 1, bc: 1, version: 9, state: BLOCK_STATE_UNCHANGED },
    { br: 2, bc: 1, version: 11, state: BLOCK_STATE_EMPTY },
  ]);
}

describe("block codec", () => {
  it("round-trips text (including astral chars), kinds, styles and flags", () => {
    const decoded = decodeBlocks(goldenBlocks());
    expect(decoded.sheet).toBe(3);
    expect(decoded.blocks).toHaveLength(2);
    expect(decoded.unchanged).toEqual([{ br: 1, bc: 1, version: 9 }]);

    const [full, empty] = decoded.blocks;
    expect(full).toMatchObject({ br: 0, bc: 1, version: 7 });
    expect(blockCellText(full, 0)).toBe("Año");
    expect(blockCellText(full, 1)).toBe("1.234,5");
    expect(blockCellText(full, BLOCK_COLS)).toBe("😀 ok");
    expect(blockCellText(full, BLOCK_SIZE - 1)).toBe("#DIV/0!");
    expect(blockCellText(full, 2)).toBe("");
    expect(full.kinds[1]).toBe(CellKind.Number);
    expect(full.styleIds[1]).toBe(2);
    expect(full.flags[BLOCK_SIZE - 1]).toBe(CellFlag.Formula);

    expect(empty).toMatchObject({ br: 2, bc: 1, version: 11, text: "" });
    expect(empty.kinds[0]).toBe(CellKind.Empty);
  });

  it("matches the golden fixture shared with the Rust encoder", () => {
    const bytes = new Uint8Array(goldenBlocks());
    if (!existsSync(GOLDEN) || process.env.UPDATE_GOLDEN === "1") {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, bytes);
    }
    expect(Buffer.from(bytes).equals(readFileSync(GOLDEN))).toBe(true);
  });

  it("rejects payloads without the magic number", () => {
    expect(() => decodeBlocks(new ArrayBuffer(16))).toThrow();
  });
});
