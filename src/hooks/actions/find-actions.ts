import type { FindMatch, FindQuery, SheetMeta } from "@/engine/contract";
import { cellRange, type CellAddress } from "@/engine/types";
import type { AppController } from "@/hooks/app-controller";
import { isSingleCell, parseReference } from "@/hooks/selection-ops";

/** "Buscar y reemplazar" (Ctrl+F / Ctrl+H) and "Ir a" (Ctrl+G). */

export interface FindOptions {
  readonly text: string;
  readonly matchCase: boolean;
  readonly wholeCell: boolean;
  readonly lookIn: "formulas" | "values";
  readonly scope: "sheet" | "workbook";
  readonly byColumns: boolean;
}

export const DEFAULT_FIND_OPTIONS: FindOptions = {
  text: "",
  matchCase: false,
  wholeCell: false,
  lookIn: "formulas",
  scope: "sheet",
  byColumns: false,
};

export const FIND_LIMIT = 10_000;

/** Engine query for the options; a multi-cell selection restricts the search like Excel. */
export function buildQuery(c: AppController, options: FindOptions, limit = FIND_LIMIT): FindQuery | null {
  const session = c.session;
  const s = c.selection;
  if (!session || !s || options.text === "") return null;
  const multi = s.ranges.length > 1 || !isSingleCell(s.ranges[0]);
  return {
    text: options.text,
    matchCase: options.matchCase,
    wholeCell: options.wholeCell,
    lookIn: options.lookIn,
    sheet: options.scope === "sheet" ? s.sheet : null,
    within: options.scope === "sheet" && multi ? s.ranges : undefined,
    byColumns: options.byColumns,
    limit,
  };
}

/** Sort key: sheet order, then rows (or columns) like Excel's search order. */
export function matchOrder(sheets: ReadonlyArray<SheetMeta>, byColumns: boolean) {
  const sheetIndex = new Map(sheets.map((s, i) => [s.id, i]));
  return (a: { sheet: number } & CellAddress, b: { sheet: number } & CellAddress): number => {
    const sa = sheetIndex.get(a.sheet) ?? 0;
    const sb = sheetIndex.get(b.sheet) ?? 0;
    if (sa !== sb) return sa - sb;
    return byColumns ? a.col - b.col || a.row - b.row : a.row - b.row || a.col - b.col;
  };
}

/** Next match after `from` (wrapping), or before it when `backwards`. */
export function pickNext(
  matches: ReadonlyArray<FindMatch>,
  from: { sheet: number } & CellAddress,
  sheets: ReadonlyArray<SheetMeta>,
  byColumns: boolean,
  backwards = false,
): FindMatch | null {
  if (matches.length === 0) return null;
  const compare = matchOrder(sheets, byColumns);
  const sorted = [...matches].sort(compare);
  if (backwards) {
    for (let i = sorted.length - 1; i >= 0; i -= 1) if (compare(sorted[i], from) < 0) return sorted[i];
    return sorted[sorted.length - 1];
  }
  return sorted.find((m) => compare(m, from) > 0) ?? sorted[0];
}

export async function findAll(c: AppController, options: FindOptions, limit = 1000): Promise<FindMatch[]> {
  const session = c.session;
  const query = buildQuery(c, options, limit);
  if (!session || !query) return [];
  const matches = await c.engine.find(session.doc, query);
  return matches.sort(matchOrder(session.info.sheets, options.byColumns));
}

/** Moves the active cell to a match; keeps a multi-cell selection when searching inside it. */
export async function revealMatch(c: AppController, match: FindMatch, keepSelection = false): Promise<void> {
  const session = c.session;
  if (!session) return;
  const s = session.selection.get();
  if (keepSelection && match.sheet === s.sheet) {
    const index = s.ranges.findIndex((r) => r.r0 <= match.row && match.row <= r.r1 && r.c0 <= match.col && match.col <= r.c1);
    if (index !== -1) {
      session.selection.set({ ...s, activeRange: index, active: { row: match.row, col: match.col } });
      session.grid?.scrollIntoView({ row: match.row, col: match.col });
      return;
    }
  }
  await c.select(match.sheet, cellRange(match), { row: match.row, col: match.col });
}

export async function findNext(c: AppController, options: FindOptions, backwards = false): Promise<FindMatch | null> {
  const session = c.session;
  const query = buildQuery(c, options);
  if (!session || !query) return null;
  try {
    const matches = await c.engine.find(session.doc, query);
    const s = session.selection.get();
    const next = pickNext(matches, { sheet: s.sheet, ...s.active }, session.info.sheets, options.byColumns, backwards);
    if (!next) {
      c.notify(`No se encuentra «${options.text}».`, "info");
      return null;
    }
    await revealMatch(c, next, query.within !== undefined);
    return next;
  } catch (error) {
    c.notify(error instanceof Error ? error.message : "No se pudo buscar.", "error");
    return null;
  }
}

/** Replaces the active cell if it matches, then moves to the next match. */
export async function replaceOne(c: AppController, options: FindOptions, replacement: string): Promise<FindMatch | null> {
  const session = c.session;
  const query = buildQuery(c, options);
  if (!session || !query) return null;
  const s = session.selection.get();
  const here = await c.engine
    .find(session.doc, { ...query, sheet: s.sheet, within: [cellRange(s.active)], limit: 1 })
    .catch(() => []);
  if (here.length > 0) {
    await c.apply([{ type: "replace", query, replacement, all: false, at: { sheet: s.sheet, row: s.active.row, col: s.active.col } }]);
  }
  return findNext(c, options);
}

export async function replaceAll(c: AppController, options: FindOptions, replacement: string): Promise<number> {
  const query = buildQuery(c, options);
  if (!query) return 0;
  const result = await c.apply([{ type: "replace", query, replacement, all: true }]);
  if (!result) return 0;
  c.notify(result.affected === 0 ? `No se encuentra «${options.text}».` : `Se han realizado ${result.affected.toLocaleString("es-ES")} reemplazos.`, "info");
  return result.affected;
}

/** "Ir a": returns a Spanish error, or null when it navigated. */
export async function goTo(c: AppController, text: string): Promise<string | null> {
  const session = c.session;
  if (!session) return "No hay ningún libro abierto.";
  const ref = parseReference(text, session.info.sheets);
  if (!ref) return "La referencia no es válida. Ejemplos: B7, A1:C10, Hoja2!A1.";
  const sheet = ref.sheet ?? session.activeSheet;
  const meta = session.info.sheets.find((s) => s.id === sheet);
  if (meta?.hidden) return `La hoja «${meta.name}» está oculta.`;
  await c.select(sheet, ref.range);
  return null;
}
