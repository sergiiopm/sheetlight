/**
 * Number format presets and helpers for the shell (toolbar, "Formato de
 * celdas" dialog). Codes are always stored as Excel number format codes with
 * en-US separators (`#,##0.00\ "€"`); the engine formats real cell values.
 *
 * This module also contains a small formatter used ONLY for the live preview
 * in the format dialog. It covers the common subset of Excel codes (sections,
 * colors, digits, thousands, scaling, %, scientific, fractions, dates/times,
 * literals) and renders with Spanish separators.
 */

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export type NumberCategory =
  | "general"
  | "number"
  | "currency"
  | "accounting"
  | "date"
  | "time"
  | "percent"
  | "fraction"
  | "scientific"
  | "text"
  | "custom";

export const CATEGORY_LABELS: Record<NumberCategory, string> = {
  general: "General",
  number: "Número",
  currency: "Moneda",
  accounting: "Contabilidad",
  date: "Fecha",
  time: "Hora",
  percent: "Porcentaje",
  fraction: "Fracción",
  scientific: "Científica",
  text: "Texto",
  custom: "Personalizada",
};

export const ACCOUNTING_EUR = '_-* #,##0.00\\ "€"_-;\\-* #,##0.00\\ "€"_-;_-* "-"??\\ "€"_-;_-@_-';
export const THOUSANDS_STYLE = '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-';

/** Toolbar "Formato de número" dropdown (Excel's Home ribbon list). */
export interface NumberFormatPreset {
  readonly id: string;
  readonly label: string;
  readonly code: string;
  /** Command id (`format.numFmt.<id>`). */
  readonly command: string;
}

export const NUMBER_FORMAT_PRESETS: ReadonlyArray<NumberFormatPreset> = [
  { id: "general", label: "General", code: "General" },
  { id: "number", label: "Número", code: "#,##0.00" },
  { id: "currency", label: "Moneda", code: '#,##0.00\\ "€"' },
  { id: "accounting", label: "Contabilidad", code: ACCOUNTING_EUR },
  { id: "shortDate", label: "Fecha corta", code: "dd/mm/yyyy" },
  { id: "longDate", label: "Fecha larga", code: 'dddd, d" de "mmmm" de "yyyy' },
  { id: "time", label: "Hora", code: "h:mm:ss" },
  { id: "percent", label: "Porcentaje", code: "0.00%" },
  { id: "fraction", label: "Fracción", code: "# ?/?" },
  { id: "scientific", label: "Científico", code: "0.00E+00" },
  { id: "text", label: "Texto", code: "@" },
].map((preset) => ({ ...preset, command: `format.numFmt.${preset.id}` }));

export const DATE_CODES: ReadonlyArray<string> = [
  "dd/mm/yyyy",
  "d/m/yy",
  "dd/mm/yy",
  'dddd, d" de "mmmm" de "yyyy',
  'd" de "mmmm" de "yyyy',
  "d-mmm",
  "d-mmm-yy",
  "mmm-yy",
  "mmmm-yy",
  "yyyy-mm-dd",
  "dd/mm/yyyy h:mm",
];

export const TIME_CODES: ReadonlyArray<string> = ["h:mm:ss", "h:mm", "hh:mm:ss", "h:mm AM/PM", "h:mm:ss AM/PM", "[h]:mm:ss", "mm:ss"];

export const FRACTION_CODES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "# ?/?", label: "De un dígito (1/4)" },
  { code: "# ??/??", label: "De dos dígitos (21/25)" },
  { code: "# ???/???", label: "De tres dígitos (312/943)" },
  { code: "# ?/2", label: "Medios (1/2)" },
  { code: "# ?/4", label: "Cuartos (2/4)" },
  { code: "# ?/8", label: "Octavos (4/8)" },
  { code: "# ??/16", label: "Dieciseisavos (8/16)" },
  { code: "# ?/10", label: "Décimos (3/10)" },
  { code: "# ??/100", label: "Centésimos (30/100)" },
];

/** Built-in codes offered in the "Personalizada" list. */
export const CUSTOM_CODES: ReadonlyArray<string> = [
  "General",
  "0",
  "0.00",
  "#,##0",
  "#,##0.00",
  '#,##0\\ "€"',
  '#,##0.00\\ "€"',
  '#,##0.00\\ "€";[Red]\\-#,##0.00\\ "€"',
  ACCOUNTING_EUR,
  THOUSANDS_STYLE,
  "0%",
  "0.00%",
  "0.00E+00",
  "# ?/?",
  "dd/mm/yyyy",
  "d-mmm-yy",
  "h:mm",
  "h:mm:ss",
  "[h]:mm:ss",
  "dd/mm/yyyy h:mm",
  "@",
];

export type NegativeStyle = "minus" | "red" | "parens" | "redParens";

export const NEGATIVE_STYLES: ReadonlyArray<{ id: NegativeStyle; label: string }> = [
  { id: "minus", label: "-1.234,10" },
  { id: "red", label: "1.234,10 (rojo)" },
  { id: "parens", label: "(1.234,10)" },
  { id: "redParens", label: "(1.234,10) (rojo)" },
];

export const CURRENCY_SYMBOLS: ReadonlyArray<{ id: string; label: string; suffix: boolean }> = [
  { id: "€", label: "€ Euro", suffix: true },
  { id: "$", label: "$ Dólar", suffix: false },
  { id: "£", label: "£ Libra", suffix: false },
  { id: "", label: "Ninguno", suffix: true },
];

function decimalsPart(decimals: number): string {
  return decimals > 0 ? `.${"0".repeat(Math.min(30, decimals))}` : "";
}

function withNegative(positive: string, negative: NegativeStyle): string {
  switch (negative) {
    case "minus":
      return positive;
    case "red":
      return `${positive};[Red]${positive}`;
    case "parens":
      return `${positive}_);\\(${positive}\\)`;
    case "redParens":
      return `${positive}_);[Red]\\(${positive}\\)`;
  }
}

export function buildNumberCode(options: { decimals: number; thousands: boolean; negative: NegativeStyle }): string {
  const base = `${options.thousands ? "#,##0" : "0"}${decimalsPart(options.decimals)}`;
  return withNegative(base, options.negative);
}

function symbolPart(symbol: string): { prefix: string; suffix: string } {
  if (!symbol) return { prefix: "", suffix: "" };
  const info = CURRENCY_SYMBOLS.find((item) => item.id === symbol);
  const quoted = `"${symbol}"`;
  return info?.suffix === false ? { prefix: quoted, suffix: "" } : { prefix: "", suffix: `\\ ${quoted}` };
}

export function buildCurrencyCode(options: { decimals: number; symbol: string; negative: NegativeStyle }): string {
  const { prefix, suffix } = symbolPart(options.symbol);
  const base = `${prefix}#,##0${decimalsPart(options.decimals)}${suffix}`;
  if (options.negative === "minus") return `${base};\\-${base}`;
  return withNegative(base, options.negative);
}

export function buildAccountingCode(options: { decimals: number; symbol: string }): string {
  const { prefix, suffix } = symbolPart(options.symbol);
  const num = `#,##0${decimalsPart(options.decimals)}`;
  const zero = `"-"${"?".repeat(options.decimals)}`;
  return `_-${prefix}* ${num}${suffix}_-;\\-${prefix}* ${num}${suffix}_-;_-${prefix}* ${zero}${suffix}_-;_-@_-`;
}

export function buildPercentCode(decimals: number): string {
  return `0${decimalsPart(decimals)}%`;
}

export function buildScientificCode(decimals: number): string {
  return `0${decimalsPart(decimals)}E+00`;
}

// ---------------------------------------------------------------------------
// Tokenizer (shared by detection, preview, localization)
// ---------------------------------------------------------------------------

type Token =
  | { kind: "literal"; text: string; raw: string }
  | { kind: "quoted"; text: string; raw: string }
  | { kind: "escaped"; text: string; raw: string }
  | { kind: "bracket"; text: string; raw: string }
  | { kind: "space"; text: string; raw: string } // `_x`
  | { kind: "fill"; text: string; raw: string } // `*x`
  | { kind: "sep"; text: ";"; raw: ";" };

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"') {
      const end = code.indexOf('"', i + 1);
      const stop = end === -1 ? code.length : end;
      tokens.push({ kind: "quoted", text: code.slice(i + 1, stop), raw: code.slice(i, stop + 1) });
      i = stop + 1;
    } else if (ch === "\\") {
      tokens.push({ kind: "escaped", text: code[i + 1] ?? "", raw: code.slice(i, i + 2) });
      i += 2;
    } else if (ch === "[") {
      const end = code.indexOf("]", i + 1);
      const stop = end === -1 ? code.length : end;
      tokens.push({ kind: "bracket", text: code.slice(i + 1, stop), raw: code.slice(i, stop + 1) });
      i = stop + 1;
    } else if (ch === "_") {
      tokens.push({ kind: "space", text: code[i + 1] ?? "", raw: code.slice(i, i + 2) });
      i += 2;
    } else if (ch === "*") {
      tokens.push({ kind: "fill", text: code[i + 1] ?? "", raw: code.slice(i, i + 2) });
      i += 2;
    } else if (ch === ";") {
      tokens.push({ kind: "sep", text: ";", raw: ";" });
      i += 1;
    } else {
      tokens.push({ kind: "literal", text: ch, raw: ch });
      i += 1;
    }
  }
  return tokens;
}

function splitSections(tokens: Token[]): Token[][] {
  const sections: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "sep") sections.push([]);
    else sections[sections.length - 1].push(token);
  }
  return sections;
}

function bareText(section: Token[]): string {
  return section
    .filter((t) => t.kind === "literal")
    .map((t) => t.text)
    .join("");
}

function isDateSection(section: Token[]): boolean {
  const bare = bareText(section).toLowerCase();
  if (/[dy]/.test(bare)) return true;
  if (/[hs]/.test(bare)) return true;
  if (section.some((t) => t.kind === "bracket" && /^(h+|m+|s+)$/i.test(t.text))) return true;
  // A lone "m"/"mm" run without digit placeholders is a month.
  return /m/.test(bare) && !/[0#?]/.test(bare);
}

// ---------------------------------------------------------------------------
// Category detection (to initialize the dialog)
// ---------------------------------------------------------------------------

export interface FormatAnalysis {
  readonly category: NumberCategory;
  readonly decimals: number;
  readonly thousands: boolean;
  readonly symbol: string;
  readonly negative: NegativeStyle;
}

function countDecimals(section: Token[]): number {
  const bare = bareText(section);
  const dot = bare.indexOf(".");
  if (dot === -1) return 0;
  let n = 0;
  for (let i = dot + 1; i < bare.length && /[0#?]/.test(bare[i]); i += 1) n += 1;
  return n;
}

function findSymbol(section: Token[]): string {
  for (const token of section) {
    if (token.kind === "quoted" && /^[€$£¥]$/.test(token.text.trim())) return token.text.trim();
    if (token.kind === "bracket" && token.text.startsWith("$")) {
      const symbol = token.text.slice(1).split("-")[0];
      if (symbol) return symbol;
    }
    if (token.kind === "literal" && /[€$£¥]/.test(token.text)) return token.text;
  }
  return "";
}

export function analyzeFormat(code: string): FormatAnalysis {
  const base: FormatAnalysis = { category: "custom", decimals: 2, thousands: false, symbol: "€", negative: "minus" };
  const trimmed = code.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "general") return { ...base, category: "general" };
  const sections = splitSections(tokenize(trimmed));
  const first = sections[0];
  const bare = bareText(first);
  if (sections.length === 1 && bare.trim() === "@") return { ...base, category: "text" };
  const decimals = countDecimals(first);
  if (isDateSection(first)) {
    const lower = bare.toLowerCase();
    const isTime = !/[dy]/.test(lower) && !(/m/.test(lower) && !/[hs]/.test(lower));
    return { ...base, category: isTime ? "time" : "date", decimals: 0 };
  }
  if (bare.includes("/") && bare.includes("?")) return { ...base, category: "fraction", decimals: 0 };
  if (/E[+-]/i.test(bare)) return { ...base, category: "scientific", decimals };
  if (bare.includes("%")) return { ...base, category: "percent", decimals };
  const symbol = findSymbol(first);
  const thousands = /[0#],[0#]/.test(bare);
  const second = sections[1];
  let negative: NegativeStyle = "minus";
  if (second) {
    const red = second.some((t) => t.kind === "bracket" && t.text.toLowerCase() === "red");
    const parens = second.some((t) => (t.kind === "escaped" || t.kind === "literal") && t.text === "(");
    negative = red ? (parens ? "redParens" : "red") : parens ? "parens" : "minus";
  }
  if (first.some((t) => t.kind === "fill")) return { ...base, category: "accounting", decimals, symbol, thousands: true };
  if (symbol) return { ...base, category: "currency", decimals, symbol, thousands, negative };
  if (/^[#0,.]+$/.test(bare.replace(/[()]/g, "")) || /^[#0,.]+$/.test(bare)) {
    return { ...base, category: "number", decimals, thousands, negative, symbol: "" };
  }
  return { ...base, decimals, thousands, symbol };
}

// ---------------------------------------------------------------------------
// Increase / decrease decimals (toolbar buttons)
// ---------------------------------------------------------------------------

/**
 * Adds (`delta > 0`) or removes one decimal place in every numeric section of
 * `code`. `General` uses `displayDecimals` (decimals currently shown in the
 * active cell) as the starting point, like Excel.
 */
export function adjustDecimals(code: string, delta: 1 | -1, displayDecimals = 0): string {
  const trimmed = code.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "general") {
    const next = Math.max(0, displayDecimals + delta);
    return next === 0 ? "0" : `0.${"0".repeat(next)}`;
  }
  const sections = splitSections(tokenize(trimmed));
  const out = sections.map((section) => {
    if (isDateSection(section) || bareText(section).trim() === "@") return section.map((t) => t.raw).join("");
    // Find the last digit placeholder before the exponent and the decimal point index.
    const indices = section.map((t, i) => (t.kind === "literal" && /[0#?]/.test(t.text) ? i : -1)).filter((i) => i >= 0);
    if (indices.length === 0) return section.map((t) => t.raw).join("");
    const expIndex = section.findIndex((t) => t.kind === "literal" && /e/i.test(t.text));
    const mantissa = expIndex === -1 ? indices : indices.filter((i) => i < expIndex);
    const dotIndex = section.findIndex((t, i) => t.kind === "literal" && t.text === "." && (expIndex === -1 || i < expIndex));
    const tokens = section.map((t) => t.raw);
    const last = mantissa[mantissa.length - 1];
    if (delta > 0) {
      if (dotIndex === -1) tokens.splice(last + 1, 0, ".0");
      else tokens.splice(last + 1, 0, "0");
    } else if (dotIndex !== -1) {
      const decimalsAfter = mantissa.filter((i) => i > dotIndex);
      if (decimalsAfter.length <= 1) {
        // Remove the last decimal digit and the point.
        if (decimalsAfter.length === 1) tokens.splice(decimalsAfter[0], 1);
        tokens.splice(dotIndex, 1);
      } else {
        tokens.splice(decimalsAfter[decimalsAfter.length - 1], 1);
      }
    }
    return tokens.join("");
  });
  return out.join(";");
}

/** Number of decimals shown in a Spanish display string ("1.234,50" -> 2). */
export function displayDecimals(display: string): number {
  const match = /,(\d+)/.exec(display);
  return match ? match[1].length : 0;
}

// ---------------------------------------------------------------------------
// Localized display of codes (es): "#,##0.00\ "€"" <-> "#.##0,00 €"
// ---------------------------------------------------------------------------

/** Excel ES shows codes with swapped separators and simplified literals. */
export function localizeCode(code: string): string {
  return tokenize(code)
    .map((t) => {
      if (t.kind === "literal") return t.text === "," ? "." : t.text === "." ? "," : t.text;
      if (t.kind === "escaped" && t.text === " ") return " ";
      if (t.kind === "quoted" && /^[€$£¥]$/.test(t.text)) return t.text;
      return t.raw;
    })
    .join("")
    .replace(/^General$/i, "Estándar");
}

/** Inverse of `localizeCode` (equivalent, not necessarily identical, code). */
export function delocalizeCode(text: string): string {
  if (/^est[aá]ndar$/i.test(text.trim())) return "General";
  return tokenize(text)
    .map((t) => {
      if (t.kind === "literal") {
        if (t.text === ",") return ".";
        if (t.text === ".") return ",";
        if (/[€£¥]/.test(t.text)) return `"${t.text}"`;
        return t.text;
      }
      return t.raw;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Preview formatter
// ---------------------------------------------------------------------------

export interface FormattedPreview {
  readonly text: string;
  /** `#rrggbb` when the section has a color (`[Red]`). */
  readonly color: string | null;
}

const COLORS: Record<string, string> = {
  red: "#ff0000",
  rojo: "#ff0000",
  blue: "#0000ff",
  azul: "#0000ff",
  green: "#00a000",
  verde: "#00a000",
  black: "#000000",
  negro: "#000000",
  white: "#ffffff",
  blanco: "#ffffff",
  yellow: "#c0a000",
  amarillo: "#c0a000",
  magenta: "#ff00ff",
  cyan: "#00c0c0",
};

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function roundTo(value: number, decimals: number): number {
  if (decimals > 15) return value;
  return Number(`${Math.round(Number(`${value}e${decimals}`))}e-${decimals}`);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function formatGeneral(value: number): string {
  if (!Number.isFinite(value)) return "#¡NUM!";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e11 || abs < 1e-9) {
    const [m, e] = value.toExponential(5).split("e");
    const mantissa = m.replace(/\.?0+$/, "").replace(".", ",");
    const exp = Number(e);
    return `${mantissa}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const text = String(Number(value.toPrecision(10)));
  return text.replace(".", ",");
}

/** Excel serial date -> parts (1900 date system, with the 1900 leap-year bug). */
export function serialToDate(serial: number): { y: number; m: number; d: number; dow: number; h: number; min: number; s: number; frac: number } {
  const days = Math.floor(serial);
  let totalSeconds = Math.round((serial - days) * 86400);
  let dayOffset = days;
  if (totalSeconds >= 86400) {
    totalSeconds -= 86400;
    dayOffset += 1;
  }
  let y: number;
  let m: number;
  let d: number;
  if (dayOffset === 60) {
    y = 1900;
    m = 2;
    d = 29;
  } else {
    const base = Date.UTC(1899, 11, dayOffset < 60 ? 31 : 30);
    const date = new Date(base + dayOffset * 86400000);
    y = date.getUTCFullYear();
    m = date.getUTCMonth() + 1;
    d = date.getUTCDate();
  }
  const dow = dayOffset === 60 ? 4 : new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return {
    y,
    m,
    d,
    dow,
    h: Math.floor(totalSeconds / 3600),
    min: Math.floor((totalSeconds % 3600) / 60),
    s: totalSeconds % 60,
    frac: serial - days,
  };
}

type DateItem = { readonly code: string } | { readonly text: string };

function dateItems(section: Token[]): DateItem[] {
  const items: DateItem[] = [];
  const literalAt = (i: number) => (section[i]?.kind === "literal" ? section[i].text : "\u0000");
  for (let i = 0; i < section.length; i += 1) {
    const token = section[i];
    if (token.kind === "literal") {
      const ahead5 = [0, 1, 2, 3, 4].map((k) => literalAt(i + k)).join("");
      if (/^am\/pm$/i.test(ahead5)) {
        items.push({ code: "ampm" });
        i += 4;
        continue;
      }
      const ahead3 = [0, 1, 2].map((k) => literalAt(i + k)).join("");
      if (/^a\/p$/i.test(ahead3)) {
        items.push({ code: "ap" });
        i += 2;
        continue;
      }
      const ch = token.text.toLowerCase();
      if (/[ymdhs]/.test(ch)) {
        let code = ch;
        while (literalAt(i + 1).toLowerCase() === ch) {
          code += ch;
          i += 1;
        }
        items.push({ code });
      } else {
        items.push({ text: token.text });
      }
    } else if (token.kind === "bracket" && /^(h+|m+|s+)$/i.test(token.text)) {
      items.push({ code: `[${token.text.toLowerCase()}]` });
    } else {
      items.push({ text: renderToken(token) });
    }
  }
  return items;
}

function formatDate(value: number, section: Token[]): string {
  const parts = serialToDate(value);
  const items = dateItems(section);
  const codes = items.map((item) => ("code" in item ? item.code : null));
  const hasAmPm = codes.includes("ampm") || codes.includes("ap");
  const hours = hasAmPm ? ((parts.h + 11) % 12) + 1 : parts.h;
  let text = "";
  items.forEach((item, index) => {
    if (!("code" in item)) {
      text += item.text;
      return;
    }
    const code = item.code;
    const prev = codes.slice(0, index).reverse().find((c) => c !== null) ?? "";
    const next = codes.slice(index + 1).find((c) => c !== null) ?? "";
    switch (code) {
      case "ampm":
        text += parts.h < 12 ? "a. m." : "p. m.";
        return;
      case "ap":
        text += parts.h < 12 ? "a" : "p";
        return;
      case "y":
      case "yy":
        text += String(parts.y % 100).padStart(2, "0");
        return;
      case "d":
        text += String(parts.d);
        return;
      case "dd":
        text += String(parts.d).padStart(2, "0");
        return;
      case "ddd":
        text += DAYS[parts.dow].slice(0, 3);
        return;
      case "h":
        text += String(hours);
        return;
      case "hh":
        text += String(hours).padStart(2, "0");
        return;
      case "s":
        text += String(parts.s);
        return;
      case "ss":
        text += String(parts.s).padStart(2, "0");
        return;
      case "mmm":
        text += MONTHS[parts.m - 1].slice(0, 3);
        return;
      case "mmmm":
        text += MONTHS[parts.m - 1];
        return;
      case "mmmmm":
        text += MONTHS[parts.m - 1][0];
        return;
      case "m":
      case "mm": {
        const minutes = /^\[?h/.test(prev) || /^\[?s/.test(next);
        const n = minutes ? parts.min : parts.m;
        text += code === "mm" ? String(n).padStart(2, "0") : String(n);
        return;
      }
      default:
        if (code.startsWith("[h")) text += String(Math.floor(value * 24));
        else if (code.startsWith("[m")) text += String(Math.floor(value * 1440));
        else if (code.startsWith("[s")) text += String(Math.floor(value * 86400));
        else if (code.startsWith("y")) text += String(parts.y);
        else if (code.startsWith("d")) text += DAYS[parts.dow];
        else if (code.startsWith("m")) text += MONTHS[parts.m - 1];
        else text += code;
    }
  });
  return text;
}

function bestFraction(value: number, maxDen: number): [number, number] {
  let bestN = 0;
  let bestD = 1;
  let bestErr = Math.abs(value);
  for (let d = 1; d <= maxDen; d += 1) {
    const n = Math.round(value * d);
    const err = Math.abs(value - n / d);
    if (err < bestErr - 1e-12) {
      bestErr = err;
      bestN = n;
      bestD = d;
    }
  }
  return [bestN, bestD];
}

function formatFraction(value: number, section: Token[]): string {
  const bare = bareText(section);
  const match = /^(.*?)([#0?]+)?\s*([?0#]+)\/([?0#]+|\d+)(.*)$/.exec(bare);
  if (!match) return formatGeneral(value);
  const [, prefix, wholePart, , denPart, suffix] = match;
  const abs = Math.abs(value);
  let whole = wholePart ? Math.floor(abs) : 0;
  const rest = wholePart ? abs - whole : abs;
  let n: number;
  let d: number;
  if (/^\d+$/.test(denPart)) {
    d = Number(denPart);
    n = Math.round(rest * d);
  } else {
    [n, d] = bestFraction(rest, 10 ** denPart.length - 1);
  }
  if (n === d && wholePart) {
    whole += 1;
    n = 0;
  }
  const sign = value < 0 ? "-" : "";
  const fraction = n === 0 ? "" : `${n}/${d}`;
  const wholeText = wholePart ? (whole === 0 && fraction ? "" : String(whole)) : "";
  const body = [wholeText, fraction].filter(Boolean).join(" ") || "0";
  return `${prefix}${sign}${body}${suffix}`;
}

interface NumberPattern {
  /** Integer placeholders without commas, e.g. "###0". */
  intDigits: string;
  /** Decimal placeholders, e.g. "00". */
  decDigits: string;
  thousands: boolean;
  scale: number;
  percent: number;
  exponent: { sign: "+" | "-"; digits: number } | null;
}

function formatNumberSection(value: number, section: Token[], hasExplicitNegative: boolean): string {
  const isLiteral = (i: number, re: RegExp) => section[i]?.kind === "literal" && re.test(section[i].text);
  const start = section.findIndex((t) => t.kind === "literal" && /[0#?]/.test(t.text));
  if (start === -1) return renderLiterals(section);
  let end = start;
  for (let i = start + 1; i < section.length; i += 1) {
    if (isLiteral(i, /^[0#?.,]$/)) {
      end = i;
      continue;
    }
    if (isLiteral(i, /^[eE]$/) && isLiteral(i + 1, /^[+-]$/)) {
      for (let j = i + 2; isLiteral(j, /^[0#]$/); j += 1) end = j;
    }
    break;
  }
  const core = section.slice(start, end + 1).map((t) => t.text).join("");
  const literalText = section.map((t) => (t.kind === "literal" ? t.text : "")).join("");
  const pattern = parsePattern(core, literalText);
  const n = (Math.abs(value) * 100 ** pattern.percent) / 1000 ** pattern.scale;
  let body: string;
  let isZero: boolean;
  if (pattern.exponent) {
    const decimals = pattern.decDigits.length;
    let exp = n === 0 ? 0 : Math.floor(Math.log10(n));
    let mantissa = n === 0 ? 0 : n / 10 ** exp;
    if (roundTo(mantissa, decimals) >= 10) {
      exp += 1;
      mantissa /= 10;
    }
    const m = roundTo(mantissa, decimals).toFixed(decimals).replace(".", ",");
    const expText = String(Math.abs(exp)).padStart(pattern.exponent.digits, "0");
    body = `${m}E${exp < 0 ? "-" : pattern.exponent.sign === "+" ? "+" : ""}${expText}`;
    isZero = n === 0;
  } else {
    const decimals = pattern.decDigits.length;
    const rounded = roundTo(n, decimals);
    isZero = rounded === 0;
    const [intRaw, decRaw = ""] = rounded.toFixed(decimals).split(".");
    const minInt = (pattern.intDigits.match(/0/g) ?? []).length;
    const spaceInt = (pattern.intDigits.match(/\?/g) ?? []).length;
    let intPart = intRaw === "0" && minInt === 0 ? "" : intRaw.padStart(minInt, "0");
    if (pattern.thousands) intPart = groupThousands(intPart);
    // '?' placeholders without a digit render as spaces (alignment).
    intPart = intPart.padStart(minInt + spaceInt, " ");
    // Optional decimals ('#', '?') drop trailing zeros; '?' keeps a space.
    let dec = decRaw;
    let pad = "";
    for (let k = pattern.decDigits.length - 1; k >= 0 && dec.endsWith("0") && pattern.decDigits[k] !== "0"; k -= 1) {
      dec = dec.slice(0, -1);
      if (pattern.decDigits[k] === "?") pad += " ";
    }
    body = intPart + (pattern.decDigits.length > 0 ? `,${dec}${pad}` : "");
  }
  const sign = value < 0 && !hasExplicitNegative && !isZero ? "-" : "";
  return `${sign}${renderLiterals(section.slice(0, start))}${body}${renderLiterals(section.slice(end + 1))}`;
}

function parsePattern(core: string, literalText: string): NumberPattern {
  let mant = core;
  let exponent: NumberPattern["exponent"] = null;
  const e = /[eE]([+-])(0+)$/.exec(core);
  if (e) {
    mant = core.slice(0, e.index);
    exponent = { sign: e[1] as "+" | "-", digits: e[2].length };
  }
  // Trailing commas after the last digit scale by 1000.
  let scale = 0;
  while (mant.endsWith(",")) {
    scale += 1;
    mant = mant.slice(0, -1);
  }
  const dot = mant.indexOf(".");
  const intRaw = dot === -1 ? mant : mant.slice(0, dot);
  const decRaw = dot === -1 ? "" : mant.slice(dot + 1);
  return {
    intDigits: intRaw.replace(/,/g, ""),
    decDigits: decRaw.replace(/,/g, ""),
    thousands: intRaw.includes(","),
    scale,
    percent: (literalText.match(/%/g) ?? []).length,
    exponent,
  };
}

function renderToken(token: Token): string {
  switch (token.kind) {
    case "literal":
    case "quoted":
    case "escaped":
      return token.text;
    case "space":
      return " ";
    case "bracket":
      return token.text.startsWith("$") ? token.text.slice(1).split("-")[0] : "";
    case "fill":
    case "sep":
      return "";
  }
}

function renderLiterals(section: Token[]): string {
  return section.map(renderToken).join("");
}

/**
 * Formats `value` with an Excel number format code, Spanish separators.
 * Used for previews only; the engine is the source of truth for cell display.
 */
export function formatPreview(value: number | string, code: string): FormattedPreview {
  const trimmed = code.trim();
  if (typeof value === "string") {
    const sections = splitSections(tokenize(trimmed));
    const textSection = sections.find((s) => bareText(s).includes("@"));
    if (!textSection) return { text: value, color: null };
    return { text: textSection.map((t) => (t.kind === "literal" && t.text === "@" ? value : renderToken(t))).join(""), color: null };
  }
  if (trimmed === "" || trimmed.toLowerCase() === "general") return { text: formatGeneral(value), color: null };
  const sections = splitSections(tokenize(trimmed));
  let section = sections[0];
  let explicitNegative = false;
  if (value < 0 && sections.length >= 2 && sections[1].length > 0) {
    section = sections[1];
    explicitNegative = true;
  } else if (value === 0 && sections.length >= 3 && sections[2].length > 0) {
    section = sections[2];
  }
  if (bareText(section).trim() === "@") return { text: formatGeneral(value), color: null };
  let color: string | null = null;
  for (const token of section) {
    if (token.kind === "bracket") color = COLORS[token.text.toLowerCase()] ?? color;
  }
  const bare = bareText(section);
  let text: string;
  if (isDateSection(section)) text = value < 0 ? "#".repeat(8) : formatDate(value, section);
  else if (bare.includes("/") && bare.includes("?")) text = formatFraction(value, section);
  else text = formatNumberSection(value, section, explicitNegative);
  return { text, color };
}
