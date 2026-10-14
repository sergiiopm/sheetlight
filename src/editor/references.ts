import { MAX_COLS, MAX_ROWS, colName, type CellRange } from "@/engine/types";
import { matchRef, prevSignificant, tokenize, isInString, type ParsedRef, type RefPart, type Token } from "@/editor/tokenizer";

/**
 * Reference utilities on top of the tokenizer: formatting, ranges, relative
 * shifting (Ctrl+Enter fill), F4 `$` cycling, "can a reference go here?"
 * (reference picking) and commit-time auto-correction/validation.
 */

const PLAIN_SHEET_RE = /^[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*$/;

/** `Hoja1` stays bare; `Mi hoja`, `2024`, `A1` get quotes (`'Mi hoja'`). */
export function formatSheetName(name: string): string {
  const needsQuotes = !PLAIN_SHEET_RE.test(name) || matchRef(name) !== null || /^(TRUE|FALSE)$/i.test(name);
  return needsQuotes ? `'${name.replace(/'/g, "''")}'` : name;
}

function formatPart(p: RefPart, kind: ParsedRef["kind"]): string {
  const col = `${p.colAbs ? "$" : ""}${colName(p.col)}`;
  const row = `${p.rowAbs ? "$" : ""}${p.row + 1}`;
  if (kind === "cols") return col;
  if (kind === "rows") return row;
  return col + row;
}

export function formatRef(ref: ParsedRef): string {
  const sheet = ref.sheet !== null ? `${formatSheetName(ref.sheet)}!` : "";
  const body = ref.kind === "cell" ? formatPart(ref.start, "cell") : `${formatPart(ref.start, ref.kind)}:${formatPart(ref.end, ref.kind)}`;
  return sheet + body + (ref.spill ? "#" : "");
}

/** Normalized grid range of a reference (whole rows/cols expanded to the sheet). */
export function refToRange(ref: ParsedRef): CellRange {
  if (ref.kind === "cols") {
    return { r0: 0, r1: MAX_ROWS - 1, c0: Math.min(ref.start.col, ref.end.col), c1: Math.max(ref.start.col, ref.end.col) };
  }
  if (ref.kind === "rows") {
    return { r0: Math.min(ref.start.row, ref.end.row), r1: Math.max(ref.start.row, ref.end.row), c0: 0, c1: MAX_COLS - 1 };
  }
  return {
    r0: Math.min(ref.start.row, ref.end.row),
    r1: Math.max(ref.start.row, ref.end.row),
    c0: Math.min(ref.start.col, ref.end.col),
    c1: Math.max(ref.start.col, ref.end.col),
  };
}

/** Reference text for a picked range: `B3`, `B3:C5`, `B:C` (whole columns), `3:5` (whole rows). */
export function rangeToRefText(range: CellRange): string {
  const wholeCols = range.r0 === 0 && range.r1 === MAX_ROWS - 1;
  const wholeRows = range.c0 === 0 && range.c1 === MAX_COLS - 1;
  if (wholeCols && !wholeRows) return `${colName(range.c0)}:${colName(range.c1)}`;
  if (wholeRows && !wholeCols) return `${range.r0 + 1}:${range.r1 + 1}`;
  const a = `${colName(range.c0)}${range.r0 + 1}`;
  if (range.r0 === range.r1 && range.c0 === range.c1) return a;
  return `${a}:${colName(range.c1)}${range.r1 + 1}`;
}

/** Shifts the relative parts of a reference; null when it leaves the sheet (`#REF!`). */
export function shiftRef(ref: ParsedRef, dRow: number, dCol: number): ParsedRef | null {
  const shiftPart = (p: RefPart): RefPart | null => {
    const row = p.row < 0 || p.rowAbs ? p.row : p.row + dRow;
    const col = p.col < 0 || p.colAbs ? p.col : p.col + dCol;
    if (p.row >= 0 && (row < 0 || row >= MAX_ROWS)) return null;
    if (p.col >= 0 && (col < 0 || col >= MAX_COLS)) return null;
    return { ...p, row, col };
  };
  const start = shiftPart(ref.start);
  const end = ref.kind === "cell" ? start : shiftPart(ref.end);
  if (!start || !end) return null;
  return { ...ref, start, end };
}

/**
 * Adjusts relative references as if the formula were copied `dRow` rows down
 * and `dCol` columns right (Excel fill / Ctrl+Enter semantics).
 */
export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  if (dRow === 0 && dCol === 0) return formula;
  let out = "";
  for (const t of tokenize(formula)) {
    if (t.type === "ref" && t.ref) {
      const shifted = shiftRef(t.ref, dRow, dCol);
      out += shifted ? formatRef(shifted) : t.ref.sheet !== null ? `${formatSheetName(t.ref.sheet)}!#REF!` : "#REF!";
    } else {
      out += t.text;
    }
  }
  return out;
}

/** F4 cycle: A1 → $A$1 → A$1 → $A1 → A1. Whole rows/cols toggle `$`. */
export function cycleAbsolute(ref: ParsedRef): ParsedRef {
  const s = ref.start;
  let rowAbs: boolean;
  let colAbs: boolean;
  if (ref.kind === "cols") {
    colAbs = !s.colAbs;
    rowAbs = false;
  } else if (ref.kind === "rows") {
    rowAbs = !s.rowAbs;
    colAbs = false;
  } else if (!s.rowAbs && !s.colAbs) {
    rowAbs = true;
    colAbs = true;
  } else if (s.rowAbs && s.colAbs) {
    rowAbs = true;
    colAbs = false;
  } else if (s.rowAbs) {
    rowAbs = false;
    colAbs = true;
  } else {
    rowAbs = false;
    colAbs = false;
  }
  const apply = (p: RefPart): RefPart => ({ ...p, rowAbs, colAbs });
  return { ...ref, start: apply(ref.start), end: apply(ref.end) };
}

export interface TextEdit {
  readonly text: string;
  readonly selStart: number;
  readonly selEnd: number;
}

/**
 * F4 on the editor text: cycles the reference under (or just before) the
 * caret, or every reference touched by the selection. Null when there is none.
 */
export function cycleRefsInText(text: string, selStart: number, selEnd: number): TextEdit | null {
  const tokens = tokenize(text);
  const lo = Math.min(selStart, selEnd);
  const hi = Math.max(selStart, selEnd);
  const targets = tokens.filter((t) =>
    t.type === "ref" && (lo === hi ? lo >= t.start && lo <= t.end : t.start < hi && t.end > lo),
  );
  if (targets.length === 0) return null;
  // With a collapsed caret between two touching refs (`A1:B2` can't happen, but `A1+B1|`), prefer the one ending at the caret.
  const chosen = lo === hi && targets.length > 1 ? [targets.find((t) => t.end === lo) ?? targets[0]] : targets;
  let out = "";
  let cursor = 0;
  let delta = 0;
  let firstStart = -1;
  let lastEnd = -1;
  for (const t of chosen) {
    if (!t.ref) continue;
    const replacement = formatRef(cycleAbsolute(t.ref));
    out += text.slice(cursor, t.start) + replacement;
    if (firstStart < 0) firstStart = t.start + delta;
    delta += replacement.length - t.text.length;
    lastEnd = t.end + delta;
    cursor = t.end;
  }
  out += text.slice(cursor);
  if (lo === hi) return { text: out, selStart: lastEnd, selEnd: lastEnd };
  return { text: out, selStart: Math.min(lo, firstStart), selEnd: Math.max(hi + delta, lastEnd) };
}

const INSERT_AFTER = new Set(["eq", "open", "comma", "semicolon", "arrayOpen"]);
const ALLOWED_NEXT = new Set(["whitespace", "close", "comma", "semicolon", "arrayClose", "operator"]);

/**
 * Whether a reference may be inserted at `caret` in a formula: right after
 * `=`, `(`, `,`, `;`, `{` or an operator (not `%`), and not in the middle of
 * a token or inside a string.
 */
export function canInsertRefAt(text: string, caret: number, tokens: ReadonlyArray<Token> = tokenize(text)): boolean {
  if (!text.startsWith("=") || caret < 1 || caret > text.length) return false;
  if (isInString(tokens, caret)) return false;
  for (const t of tokens) {
    if (t.type !== "whitespace" && caret > t.start && caret < t.end) return false;
    if (t.start === caret && !ALLOWED_NEXT.has(t.type)) return false;
  }
  const prev = prevSignificant(tokens, caret);
  if (prev < 0) return false;
  const p = tokens[prev];
  if (INSERT_AFTER.has(p.type)) return true;
  return p.type === "operator" && p.text !== "%";
}

/** Commit-time auto-correction: closes an unterminated string and missing parentheses. */
export function autoCloseFormula(text: string): string {
  if (!text.startsWith("=")) return text;
  const tokens = tokenize(text);
  let out = text;
  const last = tokens[tokens.length - 1];
  if (last && last.type === "string" && last.unterminated) out += '"';
  let depth = 0;
  for (const t of tokens) {
    if (t.type === "open") depth += 1;
    else if (t.type === "close") depth -= 1;
  }
  if (depth > 0) out += ")".repeat(depth);
  return out;
}

export const FORMULA_ERROR_MESSAGE =
  "Hay un problema con esta fórmula.\n\n¿No pretendía escribir una fórmula? Si el primer carácter es un signo igual (=) o menos (-), se interpreta como una fórmula. Para escribir texto, comience con un apóstrofo ( ' ).";

/**
 * Cheap syntax check before sending a formula to the engine (the engine
 * validates too and its `invalidFormula` error is shown the same way).
 * Returns a Spanish message, or null when nothing obvious is wrong.
 */
export function validateFormula(text: string): string | null {
  if (!text.startsWith("=")) return null;
  const tokens = tokenize(text).filter((t) => t.type !== "whitespace");
  if (tokens.length <= 1) return FORMULA_ERROR_MESSAGE;
  let depth = 0;
  let braces = 0;
  for (let k = 1; k < tokens.length; k += 1) {
    const t = tokens[k];
    const prev = tokens[k - 1];
    if (t.type === "unknown") return FORMULA_ERROR_MESSAGE;
    if (t.type === "string" && t.unterminated) return FORMULA_ERROR_MESSAGE;
    if (t.type === "open") {
      depth += 1;
    } else if (t.type === "close") {
      depth -= 1;
      if (depth < 0) return FORMULA_ERROR_MESSAGE;
      if (prev.type === "operator" && prev.text !== "%") return FORMULA_ERROR_MESSAGE;
    } else if (t.type === "arrayOpen") {
      braces += 1;
    } else if (t.type === "arrayClose") {
      braces -= 1;
    } else if (t.type === "comma") {
      if (depth === 0 && braces === 0) return FORMULA_ERROR_MESSAGE;
    } else if (t.type === "operator") {
      const unary = t.text === "+" || t.text === "-" || t.text === "@";
      if (prev.type === "operator" && prev.text !== "%" && !unary) return FORMULA_ERROR_MESSAGE;
      if ((prev.type === "eq" || prev.type === "open" || prev.type === "comma") && !unary) return FORMULA_ERROR_MESSAGE;
    }
    const operand = ["number", "string", "bool", "error", "ref", "name"].includes(t.type);
    const prevOperand = ["number", "string", "bool", "error", "ref", "name", "close"].includes(prev.type);
    // Two operands in a row (`=1 2`); a space between two refs is Excel's intersection operator.
    if (operand && prevOperand && !(t.type === "ref" && prev.type === "ref")) return FORMULA_ERROR_MESSAGE;
  }
  const last = tokens[tokens.length - 1];
  if (last.type === "operator" && last.text !== "%") return FORMULA_ERROR_MESSAGE;
  if (last.type === "function") return FORMULA_ERROR_MESSAGE;
  return null;
}
