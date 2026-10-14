import { FUNCTIONS, genericFunctionInfo, getFunctionInfo, type FunctionInfo } from "@/editor/functions";
import { isInString, prevSignificant, type Token } from "@/editor/tokenizer";

/**
 * Formula autocomplete (function names), signature help (current argument)
 * and Excel-style value completion from the same column.
 */

/** Functions offered by autocomplete: catalog ∩ engine, plus engine-only names without docs. */
export function buildFunctionList(engineNames: ReadonlyArray<string> | null): FunctionInfo[] {
  if (!engineNames) return [...FUNCTIONS].sort(byName);
  const out: FunctionInfo[] = [];
  const seen = new Set<string>();
  for (const raw of engineNames) {
    const name = raw.toUpperCase();
    if (seen.has(name) || name.startsWith("_")) continue;
    seen.add(name);
    out.push(getFunctionInfo(name) ?? genericFunctionInfo(name));
  }
  return out.sort(byName);
}

function byName(a: FunctionInfo, b: FunctionInfo): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export interface CompletionContext {
  /** What the user typed so far (`SUMI`). */
  readonly prefix: string;
  /** Text range replaced when a completion is accepted (`[start, end)`). */
  readonly start: number;
  readonly end: number;
}

const OPERAND_START = new Set(["eq", "open", "comma", "semicolon", "arrayOpen"]);

/**
 * The identifier being typed at the caret in a formula, if a function name
 * may go there (`=SU|`, `=A1+VLO|`, `=IF(su|`).
 */
export function completionContext(text: string, caret: number, tokens: ReadonlyArray<Token>): CompletionContext | null {
  if (!text.startsWith("=") || caret < 2) return null;
  if (isInString(tokens, caret)) return null;
  const tok = tokens.find((t) => t.end === caret && t.start < caret);
  if (!tok || (tok.type !== "name" && tok.type !== "ref" && tok.type !== "bool")) return null;
  const prefix = tok.text;
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(prefix)) return null;
  const next = text[caret];
  if (next !== undefined && /[A-Za-z0-9_.(]/.test(next)) return null;
  const prev = prevSignificant(tokens, tok.start);
  if (prev < 0) return null;
  const p = tokens[prev];
  if (!OPERAND_START.has(p.type) && !(p.type === "operator" && p.text !== "%")) return null;
  return { prefix, start: tok.start, end: caret };
}

/**
 * Functions matching a prefix: en-US name starts with it (alphabetical), then
 * Spanish Excel name starts with it (`BUSCARV` → VLOOKUP), then (3+ chars)
 * en-US names containing it.
 */
export function filterFunctions(prefix: string, list: ReadonlyArray<FunctionInfo>): FunctionInfo[] {
  const p = prefix.toUpperCase();
  if (p === "") return [...list];
  const starts: FunctionInfo[] = [];
  const spanish: FunctionInfo[] = [];
  const contains: FunctionInfo[] = [];
  for (const fn of list) {
    if (fn.name.startsWith(p)) starts.push(fn);
    else if (fn.es !== "" && fn.es.startsWith(p)) spanish.push(fn);
    else if (p.length >= 3 && fn.name.includes(p)) contains.push(fn);
  }
  return [...starts, ...spanish, ...contains];
}

export interface SignatureContext {
  /** Upper-case function name as typed (without `_xlfn.`). */
  readonly name: string;
  /** 0-based argument index at the caret. */
  readonly argIndex: number;
  /** Offset of the function name token. */
  readonly start: number;
}

/** Innermost function call around the caret and the argument being typed. */
export function signatureContext(tokens: ReadonlyArray<Token>, caret: number): SignatureContext | null {
  const frames: Array<{ name: string | null; argIndex: number; start: number }> = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.end > caret) break;
    switch (t.type) {
      case "open": {
        const prev = tokens[k - 1];
        const name = prev && prev.type === "function" && prev.end === t.start ? prev.text.toUpperCase().replace(/^_XLFN\./, "") : null;
        frames.push({ name, argIndex: 0, start: prev?.start ?? t.start });
        break;
      }
      case "arrayOpen":
        frames.push({ name: null, argIndex: 0, start: t.start });
        break;
      case "close":
      case "arrayClose":
        frames.pop();
        break;
      case "comma":
        if (frames.length > 0) frames[frames.length - 1].argIndex += 1;
        break;
      default:
        break;
    }
  }
  for (let k = frames.length - 1; k >= 0; k -= 1) {
    const f = frames[k];
    if (f.name !== null) return { name: f.name, argIndex: f.argIndex, start: f.start };
    // A plain parenthesis or array constant inside an argument: keep looking outward.
  }
  return null;
}

/**
 * Excel AutoComplete for values: when the typed text is the start of exactly
 * one distinct text in the column, returns the missing suffix (shown
 * selected after the caret). Case-insensitive; the completion keeps the
 * existing entry's casing for the suffix only, like Excel.
 */
export function valueCompletion(typed: string, samples: ReadonlyArray<string>): string | null {
  if (typed === "" || typed.startsWith("=") || /^[\d\s.,+\-()%€$/:]+$/.test(typed)) return null;
  const lower = typed.toLowerCase();
  let match: string | null = null;
  const seen = new Set<string>();
  for (const s of samples) {
    const key = s.toLowerCase();
    if (seen.has(key) || !key.startsWith(lower)) continue;
    seen.add(key);
    if (key === lower) return null;
    if (match !== null) return null; // ambiguous
    match = s;
  }
  return match === null ? null : match.slice(typed.length);
}
