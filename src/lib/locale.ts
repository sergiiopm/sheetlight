/**
 * Locale layer for value entry and edit text.
 *
 * The engine stores canonical inputs (en-US numbers `1234.5`, `TRUE`, Excel
 * date serials) and formulas in en-US syntax. Users type values in their
 * locale (es-ES by default): `1.234,56`, `14/02/2025`, `12,5 %`, `VERDADERO`.
 * `parseUserInput` converts what the user typed into a canonical input plus
 * the number format Excel would apply; `toEditText` does the reverse for the
 * editor when an existing cell is edited.
 *
 * Pure and framework-free; heavily unit-tested in `locale.test.ts`.
 *
 * Decisions (mirroring Excel with Spanish regional settings):
 * - `1.234` is 1234 (valid thousands grouping) with format `#,##0`.
 * - `1.5` is NOT a valid grouping, so it is tried as a date with `.` as the
 *   separator: 1 May of the current year (`d-mmm`). `1.2345` is text.
 * - `1234.5` (dot decimal in es) is text, as in Excel es.
 * - Two-digit years: 00–29 → 2000–2029, 30–99 → 1930–1999.
 * - Formulas are always en-US and are passed through untouched: in
 *   `=A1*1,5` the comma is an argument separator.
 * - `+`/`-` followed by a formula-like expression (`-A1`, `+SUM(A1:A3)`,
 *   `-5+3`) becomes a formula (`=-A1`) like Excel; `- comprar pan` stays text.
 */

export type LocaleId = "es-ES" | "en-US";

export interface Locale {
  readonly id: LocaleId;
  readonly decimal: "," | ".";
  readonly group: "." | ",";
  /** Order of numeric date parts (ISO `yyyy-mm-dd` is always accepted). */
  readonly dateOrder: "DMY" | "MDY";
  readonly trueWord: string;
  readonly falseWord: string;
  /** Lower-case month names (index 0 = January). */
  readonly monthNames: ReadonlyArray<string>;
  readonly monthAbbr: ReadonlyArray<string>;
  readonly currencySymbol: string;
  /** Excel number format for a typed full date. */
  readonly dateFormat: string;
}

const ES_MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const ES_ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const EN_MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const EN_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export const ES_ES: Locale = {
  id: "es-ES",
  decimal: ",",
  group: ".",
  dateOrder: "DMY",
  trueWord: "VERDADERO",
  falseWord: "FALSO",
  monthNames: ES_MONTHS,
  monthAbbr: ES_ABBR,
  currencySymbol: "€",
  dateFormat: "dd/mm/yyyy",
};

export const EN_US: Locale = {
  id: "en-US",
  decimal: ".",
  group: ",",
  dateOrder: "MDY",
  trueWord: "TRUE",
  falseWord: "FALSE",
  monthNames: EN_MONTHS,
  monthAbbr: EN_ABBR,
  currencySymbol: "$",
  dateFormat: "m/d/yyyy",
};

export const DEFAULT_LOCALE: Locale = ES_ES;

export function getLocale(id: LocaleId): Locale {
  return id === "en-US" ? EN_US : ES_ES;
}

// ---------------------------------------------------------------------------
// Excel serial dates (1900 date system, including the 1900 leap-year bug)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const EPOCH_1899_12_30 = Date.UTC(1899, 11, 30);
/** Serial of 9999-12-31, the last date Excel accepts. */
export const MAX_DATE_SERIAL = 2_958_465;

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/**
 * Excel serial for a calendar date (month 1-based). Returns null for invalid
 * dates or years outside 1900..9999. 1900-02-29 (which never existed) is
 * serial 60, like Excel (Lotus 1-2-3 compatibility bug).
 */
export function dateToSerial(y: number, m: number, d: number): number | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  if (y === 1900 && m === 2 && d === 29) return 60;
  if (d > daysInMonth(y, m)) return null;
  const days = Math.round((Date.UTC(y, m - 1, d) - EPOCH_1899_12_30) / MS_PER_DAY);
  // Before 1900-03-01 Excel's serials are one lower (no phantom 29-Feb yet).
  return days < 61 ? days - 1 : days;
}

export interface DateParts {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly hh: number;
  readonly mi: number;
  readonly ss: number;
  readonly ms: number;
}

/** Calendar parts of an Excel serial (fraction = time of day). */
export function serialToDate(serial: number): DateParts {
  let day = Math.floor(serial);
  let msOfDay = Math.round((serial - day) * MS_PER_DAY);
  if (msOfDay >= MS_PER_DAY) {
    day += 1;
    msOfDay -= MS_PER_DAY;
  }
  const hh = Math.floor(msOfDay / 3_600_000);
  const mi = Math.floor((msOfDay % 3_600_000) / 60_000);
  const ss = Math.floor((msOfDay % 60_000) / 1000);
  const ms = msOfDay % 1000;
  if (day === 60) return { y: 1900, m: 2, d: 29, hh, mi, ss, ms };
  if (day <= 0) return { y: 1900, m: 1, d: 0, hh, mi, ss, ms };
  const offset = day < 60 ? day + 1 : day;
  const date = new Date(EPOCH_1899_12_30 + offset * MS_PER_DAY);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), hh, mi, ss, ms };
}

/** Fraction of a day for a time of day. */
export function timeToFraction(h: number, m: number, s: number): number {
  return (h * 3600 + m * 60 + s) / 86_400;
}

// ---------------------------------------------------------------------------
// Number helpers
// ---------------------------------------------------------------------------

/** Rounds to 15 significant digits (Excel precision) to hide binary noise. */
export function roundSignificant(n: number): number {
  if (!Number.isFinite(n) || n === 0) return n === 0 ? 0 : n;
  return Number(n.toPrecision(15));
}

/** Canonical (en-US, engine) text of a number: `1234.5`, `-0.125`, `1E+21`. */
export function canonicalNumber(n: number): string {
  const r = roundSignificant(n);
  if (Object.is(r, -0) || r === 0) return "0";
  return String(r).replace("e", "E");
}

/** Number as the editor shows it: locale decimal, no grouping (`1234,5`). */
export function formatEditNumber(n: number, locale: Locale): string {
  const text = canonicalNumber(n);
  return locale.decimal === "." ? text : text.replace(".", locale.decimal);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Number format classification
// ---------------------------------------------------------------------------

export type NumFmtKind = "general" | "number" | "percent" | "currency" | "date" | "time" | "datetime" | "scientific" | "text";

/** Coarse category of an Excel number format code (first section only). */
export function classifyNumFmt(fmt: string | undefined | null): NumFmtKind {
  if (!fmt || fmt.toLowerCase() === "general") return "general";
  const firstSection = splitSections(fmt)[0];
  const hasCurrency = /\[\$[^\]-]+/.test(firstSection) || /[€$£¥]/.test(firstSection);
  const elapsed = /\[(h+|m+|s+)\]/i.test(firstSection);
  const core = firstSection
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/_.|\*./g, "")
    .toLowerCase();
  if (core.trim() === "@") return "text";
  if (core.includes("%")) return "percent";
  const hasDate = /[dy]/.test(core) || /(^|[^hm:])m{3,}/.test(core);
  const hasTime = elapsed || /[hs]/.test(core) || /a\/p|am\/pm/.test(core);
  if (hasDate && hasTime) return "datetime";
  if (hasDate) return "date";
  if (hasTime) return "time";
  if (/[0#?]e[+-]/.test(core)) return "scientific";
  if (hasCurrency) return "currency";
  return "number";
}

function splitSections(fmt: string): string[] {
  const sections: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < fmt.length; i += 1) {
    const ch = fmt[i];
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote && ch === "\\" && i + 1 < fmt.length) {
      current += ch + fmt[i + 1];
      i += 1;
      continue;
    }
    if (!inQuote && ch === ";") {
      sections.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  sections.push(current);
  return sections;
}

// ---------------------------------------------------------------------------
// parseUserInput
// ---------------------------------------------------------------------------

export type ParsedKind = "empty" | "formula" | "number" | "bool" | "date" | "time" | "text";

export interface ParsedInput {
  /** Canonical input for `CellInput.input`. */
  readonly input: string;
  /** Excel number format to apply with the value (typed %, currency, date…). */
  readonly numFmt?: string;
  readonly kind: ParsedKind;
}

export interface ParseOptions {
  /** "Today", for dates typed without a year. Defaults to `new Date()`. */
  readonly today?: Date;
  /**
   * Current number format of the target cell. A typed value whose format has
   * the same category keeps the cell's format (no `numFmt` returned), and a
   * plain number typed into a percent cell is entered as a percentage
   * (Excel's automatic percent entry: `12` → 12 %, `0,5` → 50 %).
   */
  readonly cellNumFmt?: string;
}

/** Converts what the user typed into the canonical cell input. */
export function parseUserInput(text: string, locale: Locale = DEFAULT_LOCALE, options: ParseOptions = {}): ParsedInput {
  if (text === "") return { input: "", kind: "empty" };
  const first = text[0];
  if (first === "'") return { input: text, kind: "text" };
  if (first === "=") return { input: text, kind: "formula" };

  const trimmed = text.trim();
  if (trimmed === "") return { input: text, kind: "text" };

  const upper = trimmed.toUpperCase();
  if (upper === locale.trueWord || upper === "TRUE") return { input: "TRUE", kind: "bool" };
  if (upper === locale.falseWord || upper === "FALSE") return { input: "FALSE", kind: "bool" };

  const number = parseLocaleNumber(trimmed, locale);
  if (number) return applyCellFormat({ input: canonicalNumber(number.value), numFmt: number.numFmt, kind: "number" }, number.value, number.numFmt, options);

  const date = parseDateTime(trimmed, locale, options.today ?? new Date());
  if (date) return applyCellFormat({ input: canonicalNumber(date.value), numFmt: date.numFmt, kind: date.kind }, date.value, date.numFmt, options);

  if ((first === "+" || first === "-") && looksLikeFormulaTail(trimmed.slice(1))) {
    return { input: `=${trimmed}`, kind: "formula" };
  }
  return { input: text, kind: "text" };
}

function applyCellFormat(parsed: ParsedInput, value: number, numFmt: string | undefined, options: ParseOptions): ParsedInput {
  const cellKind = classifyNumFmt(options.cellNumFmt);
  if (numFmt === undefined) {
    if (cellKind === "percent" && parsed.kind === "number" && Math.abs(value) >= 1) {
      return { input: canonicalNumber(value / 100), kind: "number" };
    }
    return { input: parsed.input, kind: parsed.kind };
  }
  const typedKind = classifyNumFmt(numFmt);
  const sameFamily =
    typedKind === cellKind ||
    (isDateKind(typedKind) && isDateKind(cellKind)) ||
    (typedKind === "number" && cellKind === "currency");
  if (cellKind !== "general" && sameFamily) return { input: parsed.input, kind: parsed.kind };
  return parsed;
}

function isDateKind(kind: NumFmtKind): boolean {
  return kind === "date" || kind === "datetime";
}

interface NumberParse {
  readonly value: number;
  readonly numFmt?: string;
}

const coreRegexCache = new Map<string, RegExp>();

function coreNumberRegex(locale: Locale): RegExp {
  let re = coreRegexCache.get(locale.id);
  if (!re) {
    const g = escapeRegExp(locale.group);
    const d = escapeRegExp(locale.decimal);
    re = new RegExp(`^(?:(\\d{1,3}(?:${g}\\d{3})+|\\d+)(?:${d}(\\d*))?|${d}(\\d+))(?:[eE]([+-]?\\d+))?$`);
    coreRegexCache.set(locale.id, re);
  }
  return re;
}

const CURRENCY_SYMBOLS = ["€", "$", "£"];

/**
 * Parses a locale number with optional sign, parentheses (negative),
 * currency symbol (before or after), percent sign, grouping and exponent.
 * Also simple fractions (`3 1/4`).
 */
export function parseLocaleNumber(text: string, locale: Locale): NumberParse | null {
  let s = text.trim();
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  let signSeen = false;
  const takeSign = (): boolean => {
    if (signSeen) return true;
    if (s.startsWith("-") || s.startsWith("+")) {
      if (negative && s.startsWith("-")) return false;
      if (s.startsWith("-")) negative = true;
      signSeen = true;
      s = s.slice(1).trimStart();
    }
    return true;
  };
  if (!takeSign()) return null;

  let currency: string | null = null;
  for (const sym of CURRENCY_SYMBOLS) {
    if (s.startsWith(sym)) {
      currency = sym;
      s = s.slice(sym.length).trimStart();
      break;
    }
  }
  if (currency && !takeSign()) return null;
  if (!currency) {
    for (const sym of CURRENCY_SYMBOLS) {
      if (s.endsWith(sym)) {
        currency = sym;
        s = s.slice(0, -sym.length).trimEnd();
        break;
      }
    }
  }
  let percent = false;
  if (!currency && s.endsWith("%")) {
    percent = true;
    s = s.slice(0, -1).trimEnd();
  }
  if (s === "") return null;

  const fraction = /^(\d+) (\d+)\/(\d+)$/.exec(s);
  if (fraction && !currency && !percent) {
    const den = Number(fraction[3]);
    const num = Number(fraction[2]);
    if (den === 0 || num >= den) return null;
    const value = Number(fraction[1]) + num / den;
    return { value: negative ? -value : value, numFmt: fraction[3].length > 1 ? "# ??/??" : "# ?/?" };
  }

  const match = coreNumberRegex(locale).exec(s);
  if (!match) return null;
  const intPart = match[1] ?? "0";
  const frac = match[2] ?? match[3] ?? "";
  const exp = match[4];
  const grouped = intPart.includes(locale.group);
  const digits = intPart.split(locale.group).join("");
  const expValue = exp !== undefined ? Number(exp) : 0;
  let value = Number(`${digits}.${frac || "0"}e${percent ? expValue - 2 : expValue}`);
  if (!Number.isFinite(value)) return null;
  if (negative) value = -value;

  const decimals = Math.min(frac.length, 30);
  let numFmt: string | undefined;
  if (percent) {
    numFmt = `${grouped ? "#,##0" : "0"}${decimals > 0 ? "." + "0".repeat(decimals) : ""}%`;
  } else if (currency) {
    numFmt = currencyFormat(currency, decimals > 0);
  } else if (exp !== undefined) {
    numFmt = "0.00E+00";
  } else if (grouped) {
    numFmt = decimals > 0 ? "#,##0.00" : "#,##0";
  }
  return { value: roundSignificant(value), numFmt };
}

function currencyFormat(symbol: string, decimals: boolean): string {
  const body = decimals ? "#,##0.00" : "#,##0";
  return symbol === "€" ? `${body}\\ "€"` : `"${symbol}"${body}`;
}

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

interface DateTimeParse {
  readonly value: number;
  readonly numFmt: string;
  readonly kind: "date" | "time";
}

interface DateOnly {
  readonly serial: number;
  readonly numFmt: string;
}

interface TimeOnly {
  readonly fraction: number;
  readonly numFmt: string;
}

/** Parses typed dates, times and date-times (`14/02/2025 9:30`). */
export function parseDateTime(text: string, locale: Locale, today: Date = new Date()): DateTimeParse | null {
  const s = text.trim().replace(/\s+/g, " ");
  const time = parseTime(s);
  if (time) return { value: time.fraction, numFmt: time.numFmt, kind: "time" };
  const date = parseDate(s, locale, today);
  if (date) return { value: date.serial, numFmt: date.numFmt, kind: "date" };
  // date + time: split at the last space before a time-looking tail
  const m = /^(.*\S) (\d{1,2}:\d{1,2}(?::\d{1,2})?(?: ?[ap]\.? ?m\.?| ?[ap])?)$/i.exec(s);
  if (m) {
    const d = parseDate(m[1], locale, today);
    const t = parseTime(m[2]);
    if (d && t && t.fraction < 1) {
      const timeFmt = t.numFmt.startsWith("[h]") ? "h:mm:ss" : t.numFmt;
      return { value: d.serial + t.fraction, numFmt: `${locale.dateFormat} ${timeFmt}`, kind: "date" };
    }
  }
  return null;
}

const TIME_RE = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?: ?([ap])\.? ?(?:m\.?)?)?$/i;

function parseTime(s: string): TimeOnly | null {
  const m = TIME_RE.exec(s);
  if (!m) {
    // elapsed hours beyond 99 ("100:00") are not common; keep text
    return null;
  }
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const sec = m[3] !== undefined ? Number(m[3]) : 0;
  const ampm = m[4]?.toLowerCase();
  if (mi > 59 || sec > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === "p" && h !== 12) h += 12;
    if (ampm === "a" && h === 12) h = 0;
    return { fraction: timeToFraction(h, mi, sec), numFmt: m[3] !== undefined ? "h:mm:ss AM/PM" : "h:mm AM/PM" };
  }
  if (h > 23) return { fraction: timeToFraction(h, mi, sec), numFmt: "[h]:mm:ss" };
  return { fraction: timeToFraction(h, mi, sec), numFmt: m[3] !== undefined ? "h:mm:ss" : "h:mm" };
}

function expandYear(text: string): number {
  const y = Number(text);
  if (text.length <= 2) return y < 30 ? 2000 + y : 1900 + y;
  return y;
}

function monthFromName(name: string, locale: Locale): number {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (n.length < 3) return -1;
  const lists = [locale.monthNames, locale.monthAbbr, ES_MONTHS, ES_ABBR, EN_MONTHS, EN_ABBR];
  for (const list of lists) {
    const idx = list.indexOf(n);
    if (idx >= 0) return idx + 1;
  }
  if (n === "sept" || n === "set" || n === "setiembre") return 9;
  return -1;
}

function parseDate(s: string, locale: Locale, today: Date): DateOnly | null {
  const currentYear = today.getFullYear();

  // ISO-like: yyyy-mm-dd, yyyy/mm/dd
  let m = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/.exec(s);
  if (m) {
    const serial = dateToSerial(Number(m[1]), Number(m[3]), Number(m[4]));
    return serial === null ? null : { serial, numFmt: locale.dateFormat };
  }

  // Numeric: a/b/c, a/b (same separator)
  m = /^(\d{1,2})([-/.])(\d{1,4})(?:\2(\d{1,4}))?$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    if (m[4] !== undefined) {
      if (m[3].length > 2 || m[4].length === 3) return null;
      const [d, mo] = locale.dateOrder === "DMY" ? [a, b] : [b, a];
      const serial = dateToSerial(expandYear(m[4]), mo, d);
      return serial === null ? null : { serial, numFmt: locale.dateFormat };
    }
    if (m[3].length === 4 && m[2] !== ".") {
      // month/yyyy → first day of that month
      const serial = dateToSerial(b, a, 1);
      return serial === null ? null : { serial, numFmt: "mmm-yy" };
    }
    if (m[3].length > 2) return null;
    const [d, mo] = locale.dateOrder === "DMY" ? [a, b] : [b, a];
    const serial = dateToSerial(currentYear, mo, d);
    if (serial !== null) return { serial, numFmt: "d-mmm" };
    // "2/25" style month/yy (Excel accepts when day/month is invalid)
    if (m[2] !== "." && a >= 1 && a <= 12) {
      const s2 = dateToSerial(expandYear(m[3]), a, 1);
      return s2 === null ? null : { serial: s2, numFmt: "mmm-yy" };
    }
    return null;
  }

  // With month names: 14-feb, 14 feb 2025, 14-feb-25, 14 de febrero de 2025, feb-2025, feb 14, 2025
  const words = s
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(/ de /g, " ")
    .split(/[\s\-/]+/)
    .filter((w) => w !== "");
  if (words.length < 2 || words.length > 3) return null;
  const isNum = (w: string) => /^\d{1,4}$/.test(w);
  // d mmm [y]
  if (isNum(words[0]) && !isNum(words[1])) {
    const mo = monthFromName(words[1], locale);
    if (mo < 0 || words[0].length > 2) return null;
    const d = Number(words[0]);
    if (words.length === 2) {
      const serial = dateToSerial(currentYear, mo, d);
      return serial === null ? null : { serial, numFmt: "d-mmm" };
    }
    if (!isNum(words[2]) || words[2].length === 3) return null;
    const serial = dateToSerial(expandYear(words[2]), mo, d);
    return serial === null ? null : { serial, numFmt: "d-mmm-yy" };
  }
  // mmm y  /  mmm d y
  if (!isNum(words[0]) && isNum(words[1])) {
    const mo = monthFromName(words[0], locale);
    if (mo < 0) return null;
    if (words.length === 2) {
      if (words[1].length === 3) return null;
      if (words[1].length <= 2 && Number(words[1]) <= daysInMonth(currentYear, mo) && locale.dateOrder === "MDY") {
        const serial = dateToSerial(currentYear, mo, Number(words[1]));
        return serial === null ? null : { serial, numFmt: "d-mmm" };
      }
      const serial = dateToSerial(expandYear(words[1]), mo, 1);
      return serial === null ? null : { serial, numFmt: "mmm-yy" };
    }
    if (!isNum(words[2]) || words[1].length > 2 || words[2].length === 3) return null;
    const serial = dateToSerial(expandYear(words[2]), mo, Number(words[1]));
    return serial === null ? null : { serial, numFmt: "d-mmm-yy" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// +/- formula detection
// ---------------------------------------------------------------------------

const REF_OR_CALL = /(\$?[A-Za-z]{1,3}\$?\d{1,7}|[A-Za-z][A-Za-z0-9._]*\()/;

/**
 * Whether the text after a leading `+`/`-` is a formula-like expression
 * (Excel turns `-A1` into `=-A1`). Prose such as `- comprar pan` is not.
 */
function looksLikeFormulaTail(rest: string): boolean {
  const t = rest.trim();
  if (t === "") return false;
  // Whitespace is only allowed next to operators, parentheses and commas.
  const compact = t.replace(/\s*([-+*/^&=<>(),:])\s*/g, "$1");
  if (/\s/.test(compact)) return false;
  if (!/^[A-Za-z0-9_$.:!(),+\-*/^&%<>="'#]+$/.test(compact)) return false;
  if (!/^[A-Za-z0-9$('"]/.test(compact)) return false;
  if (REF_OR_CALL.test(compact)) return true;
  // numeric expression with an operator after the first operand: "-5+3"
  return /^[\d.(]+.*[-+*/^&]/.test(compact);
}

// ---------------------------------------------------------------------------
// toEditText
// ---------------------------------------------------------------------------

export interface EditTextSource {
  readonly input: string;
  readonly value:
    | { readonly type: "empty" }
    | { readonly type: "number"; readonly value: number }
    | { readonly type: "text"; readonly value: string }
    | { readonly type: "bool"; readonly value: boolean }
    | { readonly type: "error"; readonly value: string };
  readonly format: { readonly numFmt: string };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Date part as typed in the locale (`14/02/2025`, `2/14/2025`). */
export function formatEditDate(serial: number, locale: Locale): string {
  const p = serialToDate(serial);
  return locale.dateOrder === "DMY" ? `${pad2(p.d)}/${pad2(p.m)}/${p.y}` : `${p.m}/${p.d}/${p.y}`;
}

/** Time part as Excel shows it while editing (`9:30:00`). */
export function formatEditTime(serial: number): string {
  const p = serialToDate(serial);
  return `${p.hh}:${pad2(p.mi)}:${pad2(p.ss)}`;
}

/**
 * Text the editor shows when editing an existing cell: formulas as stored,
 * numbers in the locale without grouping (`1234,5`), dates `14/02/2025`,
 * percentages `12,5%`, booleans `VERDADERO`.
 */
export function toEditText(details: EditTextSource, locale: Locale = DEFAULT_LOCALE): string {
  const { input, value } = details;
  if (input.startsWith("=")) return input;
  switch (value.type) {
    case "empty":
      return input;
    case "bool":
      return value.value ? locale.trueWord : locale.falseWord;
    case "error":
      return input;
    case "text": {
      if (input.startsWith("'")) return input;
      const text = input !== "" ? input : value.value;
      if (classifyNumFmt(details.format.numFmt) === "text") return text;
      const reparsed = parseUserInput(text, locale);
      return reparsed.kind === "text" ? text : `'${text}`;
    }
    case "number": {
      const n = value.value;
      const kind = classifyNumFmt(details.format.numFmt);
      if (kind === "percent") return `${formatEditNumber(n * 100, locale)}%`;
      if ((kind === "date" || kind === "datetime") && n >= 0 && n <= MAX_DATE_SERIAL + 1) {
        const hasTime = n !== Math.floor(n) || kind === "datetime";
        return hasTime ? `${formatEditDate(n, locale)} ${formatEditTime(n)}` : formatEditDate(n, locale);
      }
      if (kind === "time" && n >= 0 && n <= MAX_DATE_SERIAL + 1) {
        return n < 1 ? formatEditTime(n) : `${formatEditDate(n, locale)} ${formatEditTime(n)}`;
      }
      return formatEditNumber(n, locale);
    }
  }
}
