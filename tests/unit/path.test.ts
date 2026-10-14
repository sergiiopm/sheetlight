import { describe, expect, it } from "vitest";
import {
  defaultSavePath,
  getFileName,
  getFormatFromPath,
  isMacroWorkbook,
  samePath,
  untitledFileName,
} from "@/files/path";

describe("files/path", () => {
  it("extracts the file name from Windows and POSIX paths", () => {
    expect(getFileName("C:\\Datos\\Presupuesto 2026.xlsx")).toBe("Presupuesto 2026.xlsx");
    expect(getFileName("/home/user/ventas.csv")).toBe("ventas.csv");
  });

  it("detects workbook formats case-insensitively", () => {
    expect(getFormatFromPath("C:\\a\\LIBRO.XLSX")).toBe("xlsx");
    expect(getFormatFromPath("antiguo.xls")).toBe("xls");
    expect(getFormatFromPath("datos.csv")).toBe("csv");
    expect(getFormatFromPath("notas.txt")).toBeNull();
  });

  it("opens macro-enabled workbooks as xlsx", () => {
    expect(getFormatFromPath("C:\\a\\Macros.XLSM")).toBe("xlsx");
    expect(isMacroWorkbook("C:\\a\\Macros.XLSM")).toBe(true);
    expect(isMacroWorkbook("libro.xlsx")).toBe(false);
  });

  it("offers an .xlsx name when the source format cannot be written back", () => {
    expect(defaultSavePath("C:\\a\\antiguo.xls")).toBe("C:\\a\\antiguo.xlsx");
    expect(defaultSavePath("C:\\a\\Macros.XLSM")).toBe("C:\\a\\Macros.xlsx");
    expect(defaultSavePath("C:\\a\\libro.xlsx")).toBe("C:\\a\\libro.xlsx");
    expect(defaultSavePath("C:\\a\\datos.csv")).toBe("C:\\a\\datos.csv");
  });

  it("names new workbooks like Excel", () => {
    expect(untitledFileName(1)).toBe("Libro1.xlsx");
    expect(untitledFileName(3)).toBe("Libro3.xlsx");
  });

  it("compares Windows paths ignoring case and slash style", () => {
    expect(samePath("C:\\Datos\\A.xlsx", "c:/datos/a.XLSX")).toBe(true);
    expect(samePath("C:\\Datos\\A.xlsx", "C:\\Datos\\B.xlsx")).toBe(false);
  });
});
