import type { CellRange } from "@/engine/types";
import type { RefHighlight } from "@/grid/api";
import { refToRange } from "@/editor/references";
import type { Token } from "@/editor/tokenizer";

/**
 * Excel-like reference colors: each distinct reference in a formula gets the
 * next palette color, in order of first appearance; the same reference typed
 * twice keeps its color. Used for the editor text and the grid highlights.
 */
export const REF_COLORS: ReadonlyArray<string> = [
  "#2f6fdb", // blue
  "#d9322a", // red
  "#7e3fbf", // purple
  "#1e9c4b", // green
  "#c2459a", // magenta
  "#0e8a8a", // teal
  "#b8650f", // orange
  "#4f5bd5", // indigo
];

export interface ColoredRef {
  /** Token offsets in the formula text. */
  readonly start: number;
  readonly end: number;
  readonly color: string;
  readonly range: CellRange;
  /** Unquoted sheet name, null = the formula's own sheet. */
  readonly sheet: string | null;
}

function refKey(sheet: string | null, range: CellRange): string {
  return `${sheet === null ? "" : sheet.toLowerCase()}!${range.r0},${range.c0},${range.r1},${range.c1}`;
}

export function colorRefs(tokens: ReadonlyArray<Token>): ColoredRef[] {
  const colors = new Map<string, string>();
  const out: ColoredRef[] = [];
  for (const t of tokens) {
    if (t.type !== "ref" || !t.ref) continue;
    const range = refToRange(t.ref);
    const key = refKey(t.ref.sheet, range);
    let color = colors.get(key);
    if (color === undefined) {
      color = REF_COLORS[colors.size % REF_COLORS.length];
      colors.set(key, color);
    }
    out.push({ start: t.start, end: t.end, color, range, sheet: t.ref.sheet });
  }
  return out;
}

/**
 * Grid highlights for the refs that point at the sheet being shown (refs to
 * other sheets are only colored in the text). Duplicates are dropped.
 */
export function refHighlights(refs: ReadonlyArray<ColoredRef>, currentSheetName: string | null): RefHighlight[] {
  const seen = new Set<string>();
  const out: RefHighlight[] = [];
  const current = currentSheetName?.toLowerCase() ?? null;
  for (const r of refs) {
    if (r.sheet !== null && r.sheet.toLowerCase() !== current) continue;
    const key = refKey(null, r.range);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ range: r.range, color: r.color });
  }
  return out;
}
