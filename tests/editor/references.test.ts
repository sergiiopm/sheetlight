import { describe, expect, it } from "vitest";
import { MAX_COLS, MAX_ROWS } from "@/engine/types";
import {
  autoCloseFormula,
  canInsertRefAt,
  cycleRefsInText,
  formatSheetName,
  rangeToRefText,
  shiftFormula,
  validateFormula,
} from "@/editor/references";
import { colorRefs, refHighlights, REF_COLORS } from "@/editor/ref-colors";
import { tokenize } from "@/editor/tokenizer";

describe("shiftFormula", () => {
  it("shifts relative parts only", () => {
    expect(shiftFormula("=A1+$B$2+C$3+$D4", 2, 1)).toBe("=B3+$B$2+D$3+$D6");
    expect(shiftFormula("=SUM(A1:B2)", 1, 0)).toBe("=SUM(A2:B3)");
    expect(shiftFormula("=SUM(A:A)", 5, 2)).toBe("=SUM(C:C)");
    expect(shiftFormula("=SUM(1:2)", 3, 7)).toBe("=SUM(4:5)");
    expect(shiftFormula("=SUM($A:B)", 0, 1)).toBe("=SUM($A:C)");
    expect(shiftFormula("=Hoja2!A1*'Mi hoja'!B2", 1, 1)).toBe("=Hoja2!B2*'Mi hoja'!C3");
    expect(shiftFormula("=A1#", 1, 0)).toBe("=A2#");
  });

  it("leaves strings, names and functions untouched", () => {
    expect(shiftFormula('=IF(A1="A1",Ventas,LOG10(B1))', 1, 0)).toBe('=IF(A2="A1",Ventas,LOG10(B2))');
  });

  it("produces #REF! when leaving the sheet", () => {
    expect(shiftFormula("=A1+B2", -1, 0)).toBe("=#REF!+B1");
    expect(shiftFormula("=Hoja2!A1", 0, -1)).toBe("=Hoja2!#REF!");
    expect(shiftFormula(`=XFD1`, 0, 1)).toBe("=#REF!");
  });

  it("is the identity for a zero shift", () => {
    expect(shiftFormula("=a1+b2", 0, 0)).toBe("=a1+b2");
  });
});

describe("cycleRefsInText (F4)", () => {
  it("cycles the ref at the caret through the four modes", () => {
    let text = "=A1+B1";
    let caret = 3; // after A1
    const seen: string[] = [];
    for (let k = 0; k < 4; k += 1) {
      const r = cycleRefsInText(text, caret, caret);
      expect(r).not.toBeNull();
      text = r!.text;
      caret = r!.selStart;
      seen.push(text);
    }
    expect(seen).toEqual(["=$A$1+B1", "=A$1+B1", "=$A1+B1", "=A1+B1"]);
  });

  it("puts the caret at the end of the cycled ref", () => {
    expect(cycleRefsInText("=SUM(A1:B2)", 6, 6)).toEqual({ text: "=SUM($A$1:$B$2)", selStart: 14, selEnd: 14 });
  });

  it("prefers the ref ending at the caret", () => {
    expect(cycleRefsInText("=A1+B1", 6, 6)?.text).toBe("=A1+$B$1");
  });

  it("cycles every ref touched by a selection", () => {
    const r = cycleRefsInText("=A1+B1", 1, 6);
    expect(r?.text).toBe("=$A$1+$B$1");
    expect(r?.selStart).toBe(1);
    expect(r?.selEnd).toBe(10);
  });

  it("toggles whole rows and columns", () => {
    expect(cycleRefsInText("=SUM(A:B)", 7, 7)?.text).toBe("=SUM($A:$B)");
    expect(cycleRefsInText("=SUM($A:$B)", 7, 7)?.text).toBe("=SUM(A:B)");
    expect(cycleRefsInText("=SUM(1:2)", 7, 7)?.text).toBe("=SUM($1:$2)");
  });

  it("keeps the sheet prefix", () => {
    expect(cycleRefsInText("='Mi hoja'!A1", 13, 13)?.text).toBe("='Mi hoja'!$A$1");
  });

  it("returns null without a ref", () => {
    expect(cycleRefsInText("=SUM(1,2)", 5, 5)).toBeNull();
  });
});

describe("canInsertRefAt", () => {
  const ok = (text: string, caret = text.length) => canInsertRefAt(text, caret);
  it.each(["=", "=SUM(", "=SUM(A1,", "=A1+", "=A1*", "=A1:", "=(", "= ", "=A1 + ", "={", "=A1<>"])("allows after %s", (t) => {
    expect(ok(t)).toBe(true);
  });
  it.each(["=A1", "=SUM(A1)", '="a', "=10%", "=SUM", "=1", "hola", ""])("rejects after %s", (t) => {
    expect(ok(t)).toBe(false);
  });
  it("checks what follows the caret", () => {
    expect(canInsertRefAt("=SUM(,B1)", 5)).toBe(true);
    expect(canInsertRefAt("=SUM()", 5)).toBe(true);
    expect(canInsertRefAt("=SUM(B1)", 5)).toBe(false);
    expect(canInsertRefAt('=A1&"x"', 4)).toBe(false);
  });
});

describe("autoCloseFormula / validateFormula", () => {
  it("closes parentheses and strings", () => {
    expect(autoCloseFormula("=SUM(A1:A3")).toBe("=SUM(A1:A3)");
    expect(autoCloseFormula("=IF(A1>0,SUM(B1:B2")).toBe("=IF(A1>0,SUM(B1:B2))");
    expect(autoCloseFormula('=CONCAT("a')).toBe('=CONCAT("a")');
    expect(autoCloseFormula("=1+2")).toBe("=1+2");
    expect(autoCloseFormula("hola (")).toBe("hola (");
  });

  it.each(["=SUM(A1:A3)", "=-A1", "=A1*-2", "=10%", "=A1 B1", "=TODAY()", "={1,2;3,4}", "=IF(A1,,1)", '=""', "=+A1"])(
    "accepts %s",
    (f) => {
      expect(validateFormula(f)).toBeNull();
    },
  );

  it.each(["=", "=A1+", "=SUM(A1))", "=1,2", "=1 2", "=*2", "=A1**2", "=¿", '="abc', "=SUM(A1+)"])("rejects %s", (f) => {
    expect(validateFormula(f)).toMatch(/Hay un problema con esta fórmula/);
  });

  it("ignores non-formulas", () => {
    expect(validateFormula("hola")).toBeNull();
  });
});

describe("helpers", () => {
  it("formats picked ranges", () => {
    expect(rangeToRefText({ r0: 2, c0: 1, r1: 2, c1: 1 })).toBe("B3");
    expect(rangeToRefText({ r0: 2, c0: 1, r1: 4, c1: 2 })).toBe("B3:C5");
    expect(rangeToRefText({ r0: 0, c0: 1, r1: MAX_ROWS - 1, c1: 2 })).toBe("B:C");
    expect(rangeToRefText({ r0: 2, c0: 0, r1: 4, c1: MAX_COLS - 1 })).toBe("3:5");
  });

  it("quotes sheet names when needed", () => {
    expect(formatSheetName("Hoja1")).toBe("Hoja1");
    expect(formatSheetName("Mi hoja")).toBe("'Mi hoja'");
    expect(formatSheetName("A1")).toBe("'A1'");
    expect(formatSheetName("2024")).toBe("'2024'");
    expect(formatSheetName("It's")).toBe("'It''s'");
    expect(formatSheetName("Año")).toBe("Año");
  });
});

describe("colorRefs", () => {
  it("assigns palette colors by distinct reference", () => {
    const refs = colorRefs(tokenize("=A1+B2+$A$1+Hoja2!A1+SUM(C1:D2)"));
    expect(refs.map((r) => r.color)).toEqual([REF_COLORS[0], REF_COLORS[1], REF_COLORS[0], REF_COLORS[2], REF_COLORS[3]]);
    expect(refs[4].range).toEqual({ r0: 0, c0: 2, r1: 1, c1: 3 });
  });

  it("highlights only refs on the current sheet, without duplicates", () => {
    const refs = colorRefs(tokenize("=A1+$A$1+Hoja2!B1+hoja1!C1"));
    const hl = refHighlights(refs, "Hoja1");
    expect(hl).toEqual([
      { range: { r0: 0, c0: 0, r1: 0, c1: 0 }, color: REF_COLORS[0] },
      { range: { r0: 0, c0: 2, r1: 0, c1: 2 }, color: REF_COLORS[2] },
    ]);
  });
});
