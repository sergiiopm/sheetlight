import type { WorkbookFormat } from "@/files/types";

export function getFileName(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] || path;
}

export function getFormatFromPath(path: string): WorkbookFormat | null {
  const name = getFileName(path).toLowerCase();
  // Macro-enabled workbooks open as .xlsx (macros are reported as lost).
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) return "xlsx";
  if (name.endsWith(".xls")) return "xls";
  if (name.endsWith(".csv")) return "csv";
  return null;
}

export function formatLabel(format: WorkbookFormat): string {
  switch (format) {
    case "xlsx":
      return "Excel";
    case "xls":
      return "Excel 97-2003";
    case "csv":
      return "CSV";
  }
}

/** Name of a new, unsaved workbook ("Libro1.xlsx", "Libro2.xlsx", ...), like Excel. */
export function untitledFileName(number: number): string {
  return `Libro${number}.xlsx`;
}

export function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => value.replaceAll("/", "\\").toLowerCase();
  return normalize(a) === normalize(b);
}

/** True for `.xlsm`: opened as a workbook, macros are dropped on save. */
export function isMacroWorkbook(path: string): boolean {
  return getFileName(path).toLowerCase().endsWith(".xlsm");
}

/**
 * Path offered by "Guardar" for a document opened from `path`: formats
 * Sheetlight cannot write back as-is (`.xls`, `.xlsm`) get an `.xlsx` name,
 * like Excel's "Guardar como" for legacy files. CSV stays CSV.
 */
export function defaultSavePath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".xls") || lower.endsWith(".xlsm")) {
    return path.replace(/\.xlsm?$/i, ".xlsx");
  }
  return path;
}
