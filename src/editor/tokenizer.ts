import { MAX_ROWS, colIndex } from "@/engine/types";

/**
 * Lexer for en-US Excel formulas, used for reference coloring, reference
 * picking, F4 cycling, ref shifting, autocomplete and signature help.
 *
 * It never throws and always covers the whole input: every character belongs
 * to exactly one token (`text` slices concatenate back to the input), so the
 * editor can render tokens as colored spans over the textarea.
 */

export type TokenType =
  | "eq" // leading "="
  | "number"
  | "string"
  | "bool"
  | "error"
  | "ref"
  | "function" // identifier immediately followed by "("
  | "name" // defined name, table, unknown identifier
  | "operator"
  | "open"
  | "close"
  | "comma"
  | "semicolon"
  | "arrayOpen"
  | "arrayClose"
  | "whitespace"
  | "unknown";

/** One end of a reference. `row`/`col` are 0-based; -1 when absent (`A:A` has no row). */
export interface RefPart {
  readonly row: number;
  readonly col: number;
  readonly rowAbs: boolean;
  readonly colAbs: boolean;
}

export interface ParsedRef {
  /** Unquoted sheet name, or null for a ref on the formula's own sheet. */
  readonly sheet: string | null;
  readonly kind: "cell" | "range" | "cols" | "rows";
  readonly start: RefPart;
  /** Equal to `start` for `cell`. Not normalized (`B2:A1` keeps its order). */
  readonly end: RefPart;
  /** Spill reference `A1#`. */
  readonly spill: boolean;
}

export interface Token {
  readonly type: TokenType;
  readonly text: string;
  /** Offsets into the formula, `end` exclusive. */
  readonly start: number;
  readonly end: number;
  readonly ref?: ParsedRef;
  /** For strings: missing closing quote. */
  readonly unterminated?: boolean;
}

const ERRORS = ["#GETTING_DATA", "#DIV/0!", "#VALUE!", "#SPILL!", "#NAME?", "#NULL!", "#CALC!", "#REF!", "#NUM!", "#N/A"];

const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/;
const COL_RE = /^(\$?)([A-Za-z]{1,3})/;
const ROW_RE = /^(\$?)(\d{1,7})/;
const IDENT_START = /[A-Za-z_\\À-￿]/;
const IDENT_CHAR = /[A-Za-z0-9_.\\À-￿]/;
const UNQUOTED_SHEET_RE = /^[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*/;

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_CHAR.test(ch);
}

function cellPart(m: RegExpExecArray): RefPart | null {
  const col = colIndex(m[2]);
  const row = Number(m[4]) - 1;
  if (col < 0 || row < 0 || row >= MAX_ROWS) return null;
  return { row, col, rowAbs: m[3] === "$", colAbs: m[1] === "$" };
}

interface RefMatch {
  readonly length: number;
  readonly ref: Omit<ParsedRef, "sheet">;
}

/**
 * Matches a sheet-less reference at the start of `s`: `A1`, `$A$1`, `A1:B2`,
 * `A:C`, `1:3`, `A1#`. The match must not continue into an identifier or a
 * function call (`LOG10(` is a function, `A1B` a name).
 */
export function matchRef(s: string): RefMatch | null {
  const cell = CELL_RE.exec(s);
  if (cell) {
    const start = cellPart(cell);
    if (!start) return null;
    let length = cell[0].length;
    const rest = s.slice(length);
    if (rest.startsWith(":")) {
      const cell2 = CELL_RE.exec(rest.slice(1));
      if (cell2) {
        const end = cellPart(cell2);
        const after = rest[1 + cell2[0].length];
        if (end && !isIdentChar(after) && after !== "(") {
          return { length: length + 1 + cell2[0].length, ref: { kind: "range", start, end, spill: false } };
        }
      }
    }
    const after = s[length];
    if (isIdentChar(after) || after === "(") return null;
    let spill = false;
    if (after === "#") {
      spill = true;
      length += 1;
    }
    return { length, ref: { kind: "cell", start, end: start, spill } };
  }
  const col = COL_RE.exec(s);
  if (col && s[col[0].length] === ":") {
    const col2 = COL_RE.exec(s.slice(col[0].length + 1));
    if (col2) {
      const total = col[0].length + 1 + col2[0].length;
      const c0 = colIndex(col[2]);
      const c1 = colIndex(col2[2]);
      if (c0 >= 0 && c1 >= 0 && !isIdentChar(s[total]) && s[total] !== "(") {
        return {
          length: total,
          ref: {
            kind: "cols",
            start: { row: -1, col: c0, rowAbs: false, colAbs: col[1] === "$" },
            end: { row: -1, col: c1, rowAbs: false, colAbs: col2[1] === "$" },
            spill: false,
          },
        };
      }
    }
  }
  const row = ROW_RE.exec(s);
  if (row && s[row[0].length] === ":") {
    const row2 = ROW_RE.exec(s.slice(row[0].length + 1));
    if (row2) {
      const total = row[0].length + 1 + row2[0].length;
      const r0 = Number(row[2]) - 1;
      const r1 = Number(row2[2]) - 1;
      if (r0 >= 0 && r1 >= 0 && r0 < MAX_ROWS && r1 < MAX_ROWS && !isIdentChar(s[total]) && s[total] !== "(" && s[total] !== ".") {
        return {
          length: total,
          ref: {
            kind: "rows",
            start: { row: r0, col: -1, rowAbs: row[1] === "$", colAbs: false },
            end: { row: r1, col: -1, rowAbs: row2[1] === "$", colAbs: false },
            spill: false,
          },
        };
      }
    }
  }
  return null;
}

/** Reads a quoted sheet name `'My sheet'` at `i`; returns [name, length] or null. */
function readQuotedSheet(s: string, i: number): [string, number] | null {
  let j = i + 1;
  let name = "";
  while (j < s.length) {
    if (s[j] === "'") {
      if (s[j + 1] === "'") {
        name += "'";
        j += 2;
        continue;
      }
      return [name, j + 1 - i];
    }
    name += s[j];
    j += 1;
  }
  return null;
}

/** Tokenizes a formula (with or without the leading `=`). */
export function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  const n = formula.length;
  let i = 0;
  const push = (type: TokenType, end: number, extra?: Partial<Pick<Token, "ref" | "unterminated">>) => {
    tokens.push({ type, text: formula.slice(i, end), start: i, end, ...extra });
    i = end;
  };

  if (formula.startsWith("=")) push("eq", 1);

  while (i < n) {
    const ch = formula[i];
    const rest = formula.slice(i);

    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      let j = i + 1;
      while (j < n && /[ \n\r\t]/.test(formula[j])) j += 1;
      push("whitespace", j);
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (formula[j] === '"') {
          if (formula[j + 1] === '"') {
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      push("string", j, closed ? undefined : { unterminated: true });
      continue;
    }
    if (ch === "#") {
      const upper = rest.toUpperCase();
      const err = ERRORS.find((e) => upper.startsWith(e));
      push(err ? "error" : "unknown", i + (err ? err.length : 1));
      continue;
    }
    if (ch === "'") {
      const quoted = readQuotedSheet(formula, i);
      if (quoted && formula[i + quoted[1]] === "!") {
        const m = matchRef(formula.slice(i + quoted[1] + 1));
        if (m) {
          push("ref", i + quoted[1] + 1 + m.length, { ref: { sheet: quoted[0], ...m.ref } });
          continue;
        }
      }
      push("unknown", quoted ? i + quoted[1] : n);
      continue;
    }
    if (ch === "(") {
      push("open", i + 1);
      continue;
    }
    if (ch === ")") {
      push("close", i + 1);
      continue;
    }
    if (ch === ",") {
      push("comma", i + 1);
      continue;
    }
    if (ch === ";") {
      push("semicolon", i + 1);
      continue;
    }
    if (ch === "{") {
      push("arrayOpen", i + 1);
      continue;
    }
    if (ch === "}") {
      push("arrayClose", i + 1);
      continue;
    }
    if (rest.startsWith("<>") || rest.startsWith("<=") || rest.startsWith(">=")) {
      push("operator", i + 2);
      continue;
    }
    if ("+-*/^&=<>%@:".includes(ch)) {
      push("operator", i + 1);
      continue;
    }
    if (/[0-9$.]/.test(ch) || IDENT_START.test(ch)) {
      // A digit preceded by an identifier char would have been consumed already.
      if (/[0-9]/.test(ch) || ch === "$") {
        const rowRef = /^\$?\d/.test(rest) ? matchRef(rest) : null;
        if (rowRef && rowRef.ref.kind === "rows") {
          push("ref", i + rowRef.length, { ref: { sheet: null, ...rowRef.ref } });
          continue;
        }
      }
      if (/[0-9.]/.test(ch)) {
        const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest);
        if (num) {
          push("number", i + num[0].length);
          continue;
        }
      }
      // sheet-qualified ref with an unquoted sheet name
      const sheet = UNQUOTED_SHEET_RE.exec(rest);
      if (sheet && rest[sheet[0].length] === "!") {
        const m = matchRef(rest.slice(sheet[0].length + 1));
        if (m) {
          push("ref", i + sheet[0].length + 1 + m.length, { ref: { sheet: sheet[0], ...m.ref } });
          continue;
        }
      }
      const ref = matchRef(rest);
      if (ref) {
        push("ref", i + ref.length, { ref: { sheet: null, ...ref.ref } });
        continue;
      }
      if (IDENT_START.test(ch)) {
        let j = i + 1;
        while (j < n && isIdentChar(formula[j])) j += 1;
        if (formula[j] === "[") {
          // structured reference Table1[Column] / Table1[[#Headers],[A]]
          let depth = 0;
          while (j < n) {
            if (formula[j] === "[") depth += 1;
            else if (formula[j] === "]") {
              depth -= 1;
              if (depth === 0) {
                j += 1;
                break;
              }
            }
            j += 1;
          }
          push("name", j);
          continue;
        }
        const word = formula.slice(i, j).toUpperCase();
        if (formula[j] === "(") push("function", j);
        else if (word === "TRUE" || word === "FALSE") push("bool", j);
        else push("name", j);
        continue;
      }
    }
    push("unknown", i + 1);
  }
  return tokens;
}

/** Index of the token containing offset `pos` (a token "contains" its end too when nothing else starts there). */
export function tokenAt(tokens: ReadonlyArray<Token>, pos: number): number {
  for (let k = 0; k < tokens.length; k += 1) {
    if (pos >= tokens[k].start && pos < tokens[k].end) return k;
  }
  return -1;
}

/** Last token ending at or before `pos` that is not whitespace; -1 if none. */
export function prevSignificant(tokens: ReadonlyArray<Token>, pos: number): number {
  for (let k = tokens.length - 1; k >= 0; k -= 1) {
    if (tokens[k].end <= pos && tokens[k].type !== "whitespace") return k;
  }
  return -1;
}

/** Whether the position is inside a string literal (between its quotes). */
export function isInString(tokens: ReadonlyArray<Token>, pos: number): boolean {
  for (const t of tokens) {
    if (t.type !== "string") continue;
    if (pos > t.start && (pos < t.end || (t.unterminated && pos === t.end))) return true;
  }
  return false;
}
