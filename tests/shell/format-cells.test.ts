import { describe, expect, it } from "vitest";
import type { CellFormat } from "@/engine/contract";
import {
  clampDecimals,
  formatCellsOps,
  formatDraft,
  formatPatch,
  numberCode,
  numberDraftFromCode,
  type FormatDraft,
} from "@/hooks/format-cells";
import { ACCOUNTING_EUR } from "@/lib/number-formats";

const DEFAULTS = { family: "Calibri", size: 11 };
const RANGE = { r0: 0, c0: 0, r1: 2, c1: 1 };

function draftOf(format: CellFormat | null, merged = false): FormatDraft {
  return formatDraft(format, DEFAULTS, merged);
}

describe("Formato de celdas: number codes", () => {
  it("round-trips the toolbar presets through the dialog state", () => {
    for (const code of ["General", "#,##0.00", "0.00%", "0.00E+00", "@", "dd/mm/yyyy", "h:mm:ss", "# ?/?"]) {
      expect(numberCode(numberDraftFromCode(code))).toBe(code);
    }
    // Currency gets an explicit (equivalent) negative section.
    expect(numberCode(numberDraftFromCode('#,##0.00\\ "€"'))).toBe('#,##0.00\\ "€";\\-#,##0.00\\ "€"');
  });

  it("does not patch the number format of an untouched code", () => {
    const initial = formatDraft({ numFmt: '#,##0.00\\ "€"', style: {} }, DEFAULTS);
    expect(formatPatch(initial, { ...initial })).toEqual({});
  });

  it("builds number codes from the category options", () => {
    const base = numberDraftFromCode("General");
    expect(numberCode({ ...base, category: "number", decimals: 0, thousands: true, negative: "minus" })).toBe("#,##0");
    expect(numberCode({ ...base, category: "number", decimals: 1, thousands: false, negative: "red" })).toBe("0.0;[Red]0.0");
    expect(numberCode({ ...base, category: "currency", decimals: 2, symbol: "$", negative: "minus" })).toBe('"$"#,##0.00;\\-"$"#,##0.00');
    expect(numberCode({ ...base, category: "accounting", decimals: 2, symbol: "€" })).toBe(ACCOUNTING_EUR);
    expect(numberCode({ ...base, category: "percent", decimals: 0 })).toBe("0%");
    expect(numberCode({ ...base, category: "scientific", decimals: 3 })).toBe("0.000E+00");
    expect(numberCode({ ...base, category: "text" })).toBe("@");
    expect(numberCode({ ...base, category: "custom", customCode: "  " })).toBe("General");
  });

  it("clamps decimals to Excel's 0..30", () => {
    expect(clampDecimals(-3)).toBe(0);
    expect(clampDecimals(2.6)).toBe(3);
    expect(clampDecimals(99)).toBe(30);
    expect(clampDecimals(Number.NaN)).toBe(0);
  });

  it("starts date/time/fraction lists on the current code or the first entry", () => {
    expect(numberDraftFromCode("d-mmm-yy")).toMatchObject({ category: "date", dateCode: "d-mmm-yy" });
    expect(numberDraftFromCode("General").dateCode).toBe("dd/mm/yyyy");
  });
});

describe("Formato de celdas: patch and ops", () => {
  const format: CellFormat = { numFmt: "General", style: { bold: true, hAlign: "center", fill: "#ffff00" } };

  it("initialises from the active cell with defaults for missing fields", () => {
    const draft = draftOf(format);
    expect(draft.font).toMatchObject({ family: "Calibri", size: 11, bold: true, italic: false, underline: "none", color: null });
    expect(draft.alignment).toMatchObject({ hAlign: "center", vAlign: "bottom", wrap: false, merge: false });
    expect(draft.fill).toBe("#ffff00");
  });

  it("only patches the fields the user changed", () => {
    const initial = draftOf(format);
    expect(formatPatch(initial, initial)).toEqual({});
    const edited: FormatDraft = {
      ...initial,
      font: { ...initial.font, italic: true, underline: "double" },
      alignment: { ...initial.alignment, hAlign: "general", wrap: true },
      fill: null,
      number: { ...initial.number, category: "percent", decimals: 1 },
    };
    expect(formatPatch(initial, edited)).toEqual({
      numFmt: "0.0%",
      hAlign: null,
      wrap: true,
      italic: true,
      underline: "double",
      fill: null,
    });
  });

  it("emits style, borders and merge ops as one batch", () => {
    const initial = draftOf(format);
    const edited: FormatDraft = {
      ...initial,
      font: { ...initial.font, color: "#c00000" },
      borders: [
        { preset: "outer", style: "thick", color: "#000000" },
        { preset: "inner", style: "thin", color: "#808080" },
      ],
      alignment: { ...initial.alignment, merge: true },
    };
    const ops = formatCellsOps(1, [RANGE, { r0: 5, c0: 5, r1: 5, c1: 5 }], initial, edited);
    expect(ops.map((op) => op.type)).toEqual(["setStyle", "setBorders", "setBorders", "merge"]);
    expect(ops[0]).toMatchObject({ patch: { color: "#c00000" } });
    expect(ops[3]).toMatchObject({ type: "merge", range: RANGE, mode: "merge" });
  });

  it("unmerges when the merge box is cleared and does nothing when unchanged", () => {
    const initial = draftOf(format, true);
    expect(formatCellsOps(1, [RANGE], initial, initial)).toEqual([]);
    const ops = formatCellsOps(1, [RANGE], initial, { ...initial, alignment: { ...initial.alignment, merge: false } });
    expect(ops).toEqual([{ type: "unmerge", sheet: 1, ranges: [RANGE] }]);
  });

  it("clamps indent and rotation, keeping vertical text", () => {
    const initial = draftOf(null);
    const patch = formatPatch(initial, { ...initial, alignment: { ...initial.alignment, indent: 40, rotation: 255 } });
    expect(patch).toEqual({ indent: 15, rotation: 255 });
    expect(formatPatch(initial, { ...initial, alignment: { ...initial.alignment, rotation: -200 } })).toEqual({ rotation: -90 });
  });
});
