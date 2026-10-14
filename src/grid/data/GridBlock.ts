import { BLOCK_COLS, BLOCK_ROWS, BLOCK_SIZE, type CellBlock } from "@/engine/contract";

/**
 * A cached block in render-ready form. The wire block (`CellBlock`: one joined
 * string + offsets) is split once on arrival into per-cell strings, so the
 * render loop never slices/allocates per cell and per frame.
 */
export interface GridBlock {
  readonly br: number;
  readonly bc: number;
  /** Engine version, or -1 when the content was produced locally (structural shift). */
  readonly version: number;
  /** Display text per cell; null = no text. */
  readonly texts: ReadonlyArray<string | null>;
  readonly kinds: Uint8Array;
  readonly styleIds: Uint32Array;
  readonly flags: Uint8Array;
}

const EMPTY_TEXTS: ReadonlyArray<string | null> = Object.freeze(new Array<string | null>(BLOCK_SIZE).fill(null));

export function toGridBlock(block: CellBlock): GridBlock {
  let texts: ReadonlyArray<string | null> = EMPTY_TEXTS;
  if (block.text.length > 0) {
    const out = new Array<string | null>(BLOCK_SIZE);
    const off = block.textOffsets;
    const text = block.text;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      const a = off[i];
      const b = off[i + 1];
      out[i] = a === b ? null : text.slice(a, b);
    }
    texts = out;
  }
  return {
    br: block.br,
    bc: block.bc,
    version: block.version,
    texts,
    kinds: block.kinds,
    styleIds: block.styleIds,
    flags: block.flags,
  };
}

const BC_STRIDE = 2048; // > MAX_COLS / BLOCK_COLS (1024)

export function blockKeyOf(br: number, bc: number): number {
  return br * BC_STRIDE + bc;
}

export function blockKeyParts(key: number): { br: number; bc: number } {
  return { br: Math.floor(key / BC_STRIDE), bc: key % BC_STRIDE };
}

/** Index of (row, col) inside its block. */
export function cellIndex(row: number, col: number): number {
  return (row % BLOCK_ROWS) * BLOCK_COLS + (col % BLOCK_COLS);
}

/**
 * Rebuilds the cached blocks after rows/cols were inserted or deleted, by
 * moving cell data between blocks locally (the engine's fresh blocks follow;
 * shifted blocks are only an instant preview). Blocks whose source rows/cols
 * are not all cached are dropped.
 */
export function shiftBlocks(
  blocks: ReadonlyMap<number, GridBlock>,
  axis: "row" | "col",
  index: number,
  count: number,
  insert: boolean,
  axisCount: number,
  isKnownEmpty: (br: number, bc: number) => boolean = () => false,
): Map<number, GridBlock> {
  const per = axis === "row" ? BLOCK_ROWS : BLOCK_COLS;
  const firstBand = Math.floor(index / per);
  const out = new Map<number, GridBlock>();
  const candidates = new Set<number>();
  for (const [key, b] of blocks) {
    const band = axis === "row" ? b.br : b.bc;
    if (band < firstBand) {
      out.set(key, b);
      continue;
    }
    const lo = band * per;
    const hi = lo + per - 1;
    const d = insert ? count : -count;
    const a = Math.max(firstBand, Math.floor(Math.max(0, lo + d) / per));
    const z = Math.floor(Math.max(0, Math.min(axisCount - 1, hi + d)) / per);
    for (let nb = band === firstBand ? firstBand : a; nb <= z; nb++) {
      candidates.add(axis === "row" ? blockKeyOf(nb, b.bc) : blockKeyOf(b.br, nb));
    }
  }
  // Source position for a new position p along the axis (-1 = new empty cell).
  const source = (p: number): number => {
    if (p < index) return p;
    if (insert) return p < index + count ? -1 : p - count;
    const s = p + count;
    return s < axisCount ? s : -1;
  };
  for (const key of candidates) {
    const { br, bc } = blockKeyParts(key);
    const srcOf = (k: number): GridBlock | null | undefined => {
      const s = source((axis === "row" ? br : bc) * per + k);
      if (s < 0) return null;
      const sbr = axis === "row" ? Math.floor(s / per) : br;
      const sbc = axis === "row" ? bc : Math.floor(s / per);
      return blocks.get(blockKeyOf(sbr, sbc)) ?? (isKnownEmpty(sbr, sbc) ? null : undefined);
    };
    let complete = true;
    for (let k = 0; k < per && complete; k++) if (srcOf(k) === undefined) complete = false;
    if (!complete) continue;
    const texts = new Array<string | null>(BLOCK_SIZE).fill(null);
    const kinds = new Uint8Array(BLOCK_SIZE);
    const styleIds = new Uint32Array(BLOCK_SIZE);
    const flags = new Uint8Array(BLOCK_SIZE);
    for (let k = 0; k < per; k++) {
      const src = srcOf(k);
      if (!src) continue;
      const sk = source((axis === "row" ? br : bc) * per + k) % per;
      if (axis === "row") {
        for (let c = 0; c < BLOCK_COLS; c++) {
          const from = sk * BLOCK_COLS + c;
          const to = k * BLOCK_COLS + c;
          texts[to] = src.texts[from];
          kinds[to] = src.kinds[from];
          styleIds[to] = src.styleIds[from];
          flags[to] = src.flags[from];
        }
      } else {
        for (let r = 0; r < BLOCK_ROWS; r++) {
          const from = r * BLOCK_COLS + sk;
          const to = r * BLOCK_COLS + k;
          texts[to] = src.texts[from];
          kinds[to] = src.kinds[from];
          styleIds[to] = src.styleIds[from];
          flags[to] = src.flags[from];
        }
      }
    }
    out.set(key, { br, bc, version: -1, texts, kinds, styleIds, flags });
  }
  return out;
}
