import { describe, expect, it } from "vitest";
import { getFileName, getFormatFromPath, samePath, untitledFileName } from "@/files/path";

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

  it("names new workbooks like Excel", () => {
    expect(untitledFileName(1)).toBe("Libro1.xlsx");
    expect(untitledFileName(3)).toBe("Libro3.xlsx");
  });

  it("compares Windows paths ignoring case and slash style", () => {
    expect(samePath("C:\\Datos\\A.xlsx", "c:/datos/a.XLSX")).toBe(true);
    expect(samePath("C:\\Datos\\A.xlsx", "C:\\Datos\\B.xlsx")).toBe(false);
  });
});
