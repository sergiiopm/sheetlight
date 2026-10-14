export type WorkbookFormat = "xlsx" | "xls" | "csv";

/** Dialog filters for opening workbooks (labels are user-facing, in Spanish). */
export const OPEN_FILTERS = [
  { name: "Hojas de cálculo", extensions: ["xlsx", "xlsm", "xls", "csv"] },
  { name: "Libro de Excel", extensions: ["xlsx"] },
  { name: "Libro de Excel habilitado para macros", extensions: ["xlsm"] },
  { name: "Libro de Excel 97-2003", extensions: ["xls"] },
  { name: "CSV", extensions: ["csv"] },
];

/** Formats Sheetlight can write. Legacy .xls is import-only. */
export const SAVE_FILTERS = [
  { name: "Libro de Excel", extensions: ["xlsx"] },
  { name: "CSV", extensions: ["csv"] },
];
