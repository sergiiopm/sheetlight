import type { CsvOptions } from "@/engine/contract";

// CSV import/export options for dialogs (labels are user-facing, in Spanish).
// `null` values mean "auto-detect" and are resolved by the native CSV store.

export type CsvDelimiter = NonNullable<CsvOptions["delimiter"]>;
export type CsvEncoding = NonNullable<CsvOptions["encoding"]>;
export type CsvDecimal = NonNullable<CsvOptions["decimal"]>;

export interface Choice<T> {
  readonly value: T;
  readonly label: string;
}

export const CSV_DELIMITERS: ReadonlyArray<Choice<CsvDelimiter>> = [
  { value: ";", label: "Punto y coma (;)" },
  { value: ",", label: "Coma (,)" },
  { value: "\t", label: "Tabulación" },
  { value: "|", label: "Barra vertical (|)" },
];

export const CSV_ENCODINGS: ReadonlyArray<Choice<CsvEncoding>> = [
  { value: "utf-8", label: "Unicode (UTF-8)" },
  { value: "windows-1252", label: "Europeo occidental (Windows-1252)" },
  { value: "utf-16le", label: "Unicode (UTF-16)" },
];

export const CSV_DECIMALS: ReadonlyArray<Choice<CsvDecimal>> = [
  { value: ",", label: "Coma (1.234,56)" },
  { value: ".", label: "Punto (1,234.56)" },
];

export const AUTO_LABEL = "Detectar automáticamente";

export const AUTO_CSV_OPTIONS: CsvOptions = { delimiter: null, encoding: null, decimal: null };

function labelOf<T>(choices: ReadonlyArray<Choice<T>>, value: T | null): string {
  if (value === null) return AUTO_LABEL;
  return choices.find((c) => c.value === value)?.label ?? String(value);
}

/** One-line summary for the status bar / import dialog: "Punto y coma (;) · Unicode (UTF-8) · Coma (1.234,56)". */
export function describeCsvOptions(options: CsvOptions): string {
  return [
    labelOf(CSV_DELIMITERS, options.delimiter),
    labelOf(CSV_ENCODINGS, options.encoding),
    labelOf(CSV_DECIMALS, options.decimal),
  ].join(" · ");
}

/**
 * Options for saving a CSV opened from disk: keep what was detected on open
 * (so a `;`/Windows-1252/decimal-comma file is written back the same way),
 * with explicit user choices winning.
 */
export function csvSaveOptions(
  detected: CsvOptions | null,
  chosen?: Partial<CsvOptions>,
): Partial<CsvOptions> {
  const out: { -readonly [K in keyof CsvOptions]?: CsvOptions[K] } = {};
  for (const key of ["delimiter", "encoding", "decimal"] as const) {
    const value = chosen?.[key] ?? detected?.[key] ?? null;
    if (value !== null) {
      // Each key keeps its own literal type.
      (out as Record<string, string>)[key] = value;
    }
  }
  return out;
}
