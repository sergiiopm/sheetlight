import { BLOCK_SIZE, type CellBlock } from "@/engine/contract";
import type { SheetId } from "@/engine/types";

/**
 * Binary wire format for `fetchBlocks` (Rust -> webview via `tauri::ipc::Response`).
 * The Rust encoder in `src-tauri/src/engine/blocks.rs` must produce exactly
 * these bytes; `tests/unit/block-codec.test.ts` and the Rust tests share the
 * golden fixture `tests/fixtures/blocks-golden.bin`.
 *
 * All integers are little-endian u32 unless noted. Every section starts at a
 * 4-byte aligned offset.
 *
 * Response:
 *   magic        u32 = 0x31424C53 ("SLB1")
 *   blockCount   u32
 *   sheet        u32
 *   reserved     u32 = 0
 *   block * blockCount
 *
 * Block:
 *   br           u32
 *   bc           u32
 *   version      u32
 *   state        u32   0 = full payload follows, 1 = unchanged (client's
 *                      known version is current; nothing follows),
 *                      2 = empty block (all cells empty, default style; nothing follows)
 *   textBytes    u32   length of the UTF-8 text section
 *   reserved     u32 = 0
 *   textOffsets  u32 * (BLOCK_SIZE + 1)   UTF-16 code-unit offsets into the decoded text
 *   styleIds     u32 * BLOCK_SIZE
 *   kinds        u8  * BLOCK_SIZE
 *   flags        u8  * BLOCK_SIZE
 *   text         u8  * textBytes (UTF-8), then zero padding to a multiple of 4
 */

export const BLOCKS_MAGIC = 0x31424c53;
export const BLOCK_STATE_FULL = 0;
export const BLOCK_STATE_UNCHANGED = 1;
export const BLOCK_STATE_EMPTY = 2;

const HEADER_BYTES = 16;
const BLOCK_HEADER_BYTES = 24;
const OFFSETS_BYTES = (BLOCK_SIZE + 1) * 4;
const STYLES_BYTES = BLOCK_SIZE * 4;

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/** Shared all-empty arrays for `state = empty` blocks (never mutate). */
const EMPTY_OFFSETS = new Uint32Array(BLOCK_SIZE + 1);
const EMPTY_STYLES = new Uint32Array(BLOCK_SIZE);
const EMPTY_BYTES = new Uint8Array(BLOCK_SIZE);

export interface DecodedBlocks {
  readonly sheet: SheetId;
  readonly blocks: CellBlock[];
  /** Blocks the engine reported as unchanged (client already has this version). */
  readonly unchanged: ReadonlyArray<{ readonly br: number; readonly bc: number; readonly version: number }>;
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

export function decodeBlocks(buffer: ArrayBuffer): DecodedBlocks {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER_BYTES || view.getUint32(0, true) !== BLOCKS_MAGIC) {
    throw new Error("Invalid block payload");
  }
  const count = view.getUint32(4, true);
  const sheet = view.getUint32(8, true);
  const blocks: CellBlock[] = [];
  const unchanged: { br: number; bc: number; version: number }[] = [];
  let pos = HEADER_BYTES;

  for (let i = 0; i < count; i += 1) {
    const br = view.getUint32(pos, true);
    const bc = view.getUint32(pos + 4, true);
    const version = view.getUint32(pos + 8, true);
    const state = view.getUint32(pos + 12, true);
    const textBytes = view.getUint32(pos + 16, true);
    pos += BLOCK_HEADER_BYTES;

    if (state === BLOCK_STATE_UNCHANGED) {
      unchanged.push({ br, bc, version });
      continue;
    }
    if (state === BLOCK_STATE_EMPTY) {
      blocks.push({
        sheet, br, bc, version,
        text: "",
        textOffsets: EMPTY_OFFSETS,
        styleIds: EMPTY_STYLES,
        kinds: EMPTY_BYTES,
        flags: EMPTY_BYTES,
      });
      continue;
    }

    // Views into the response buffer (no copies). Offsets are 4-byte aligned.
    const textOffsets = new Uint32Array(buffer, pos, BLOCK_SIZE + 1);
    pos += OFFSETS_BYTES;
    const styleIds = new Uint32Array(buffer, pos, BLOCK_SIZE);
    pos += STYLES_BYTES;
    const kinds = new Uint8Array(buffer, pos, BLOCK_SIZE);
    pos += BLOCK_SIZE;
    const flags = new Uint8Array(buffer, pos, BLOCK_SIZE);
    pos += BLOCK_SIZE;
    const text = textBytes === 0 ? "" : decoder.decode(new Uint8Array(buffer, pos, textBytes));
    pos += align4(textBytes);

    blocks.push({ sheet, br, bc, version, text, textOffsets, styleIds, kinds, flags });
  }

  return { sheet, blocks, unchanged };
}

export type EncodableBlock =
  | (CellBlock & { readonly state?: typeof BLOCK_STATE_FULL })
  | { readonly br: number; readonly bc: number; readonly version: number; readonly state: typeof BLOCK_STATE_UNCHANGED | typeof BLOCK_STATE_EMPTY };

/** Reference encoder (used by `MemoryEngine` and tests; Rust has its own). */
export function encodeBlocks(sheet: SheetId, blocks: ReadonlyArray<EncodableBlock>): ArrayBuffer {
  const texts: Uint8Array[] = [];
  let size = HEADER_BYTES;
  for (const block of blocks) {
    size += BLOCK_HEADER_BYTES;
    if (block.state === BLOCK_STATE_UNCHANGED || block.state === BLOCK_STATE_EMPTY) {
      texts.push(EMPTY_BYTES.subarray(0, 0));
      continue;
    }
    const bytes = encoder.encode((block as CellBlock).text);
    texts.push(bytes);
    size += OFFSETS_BYTES + STYLES_BYTES + BLOCK_SIZE * 2 + align4(bytes.length);
  }

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint32(0, BLOCKS_MAGIC, true);
  view.setUint32(4, blocks.length, true);
  view.setUint32(8, sheet, true);
  let pos = HEADER_BYTES;

  blocks.forEach((block, index) => {
    const state = block.state ?? BLOCK_STATE_FULL;
    const text = texts[index];
    view.setUint32(pos, block.br, true);
    view.setUint32(pos + 4, block.bc, true);
    view.setUint32(pos + 8, block.version >>> 0, true);
    view.setUint32(pos + 12, state, true);
    view.setUint32(pos + 16, text.length, true);
    pos += BLOCK_HEADER_BYTES;
    if (state !== BLOCK_STATE_FULL) return;

    const full = block as CellBlock;
    new Uint32Array(buffer, pos, BLOCK_SIZE + 1).set(full.textOffsets);
    pos += OFFSETS_BYTES;
    new Uint32Array(buffer, pos, BLOCK_SIZE).set(full.styleIds);
    pos += STYLES_BYTES;
    bytes.set(full.kinds, pos);
    pos += BLOCK_SIZE;
    bytes.set(full.flags, pos);
    pos += BLOCK_SIZE;
    bytes.set(text, pos);
    pos += align4(text.length);
  });

  return buffer;
}

/** Text of cell `index` in a block. */
export function blockCellText(block: CellBlock, index: number): string {
  const start = block.textOffsets[index];
  const end = block.textOffsets[index + 1];
  return start === end ? "" : block.text.slice(start, end);
}

/** Helper to build a block from per-cell arrays (fakes, tests). */
export function buildBlock(
  sheet: SheetId,
  br: number,
  bc: number,
  version: number,
  cells: ReadonlyArray<{ text: string; kind: number; styleId: number; flags: number } | null>,
): CellBlock {
  const textOffsets = new Uint32Array(BLOCK_SIZE + 1);
  const styleIds = new Uint32Array(BLOCK_SIZE);
  const kinds = new Uint8Array(BLOCK_SIZE);
  const flags = new Uint8Array(BLOCK_SIZE);
  let text = "";
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    textOffsets[i] = text.length;
    const cell = cells[i];
    if (!cell) continue;
    text += cell.text;
    kinds[i] = cell.kind;
    styleIds[i] = cell.styleId;
    flags[i] = cell.flags;
  }
  textOffsets[BLOCK_SIZE] = text.length;
  return { sheet, br, bc, version, text, textOffsets, styleIds, kinds, flags };
}
