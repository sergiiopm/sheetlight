import { describe, expect, it } from "vitest";

import { AUTO_CSV_OPTIONS, csvSaveOptions, describeCsvOptions } from "@/files/csv";
import { describeWarning, lostOnSaveMessage, summarizeFidelity } from "@/files/fidelity";

describe("csv options", () => {
  it("describes detected and automatic options in Spanish", () => {
    expect(describeCsvOptions({ delimiter: ";", encoding: "windows-1252", decimal: "," })).toBe(
      "Punto y coma (;) · Europeo occidental (Windows-1252) · Coma (1.234,56)",
    );
    expect(describeCsvOptions(AUTO_CSV_OPTIONS)).toContain("Detectar automáticamente");
  });

  it("keeps detected options on save unless the user chose others", () => {
    const detected = { delimiter: ";", encoding: "utf-8", decimal: "," } as const;
    expect(csvSaveOptions(detected)).toEqual(detected);
    expect(csvSaveOptions(detected, { delimiter: "\t" })).toEqual({ ...detected, delimiter: "\t" });
    expect(csvSaveOptions(null)).toEqual({});
  });
});

describe("fidelity", () => {
  it("summarizes warnings by what happens on save", () => {
    const summary = summarizeFidelity([
      { feature: "charts", count: 2, onSave: "preserved" },
      { feature: "autoFilter", count: 1, onSave: "editable" },
      { feature: "pivotTables", count: 1, onSave: "lost" },
      { feature: "macros", count: 1, onSave: "lost" },
    ]);
    expect(summary.preserved).toEqual(["2 gráficos"]);
    expect(summary.editable).toEqual(["1 autofiltro"]);
    expect(summary.message).toBe(
      "Este archivo contiene 1 tabla dinámica y macros que Sheetlight no admite: se perderán al guardarlo.",
    );
    expect(summarizeFidelity([{ feature: "images", count: 1, onSave: "preserved" }]).message).toBeNull();
    expect(describeWarning({ feature: "comments", count: 1, onSave: "preserved" })).toBe("1 comentario");
  });

  it("reports features dropped by a save", () => {
    expect(lostOnSaveMessage([])).toBeNull();
    expect(lostOnSaveMessage(["slicers", "macros", "charts"])).toBe(
      "Se guardó el archivo sin segmentaciones, macros y gráficos.",
    );
  });
});
