import { describe, expect, it } from "vitest";
import { buildFunctionList, completionContext, filterFunctions, signatureContext, valueCompletion } from "@/editor/autocomplete";
import { FUNCTIONS, argForIndex, formatSignature, getFunctionInfo } from "@/editor/functions";
import { tokenize } from "@/editor/tokenizer";

const ctx = (text: string, caret = text.length) => completionContext(text, caret, tokenize(text));
const sig = (text: string, caret = text.length) => signatureContext(tokenize(text), caret);

describe("function catalog", () => {
  it("has ~200 unique, documented functions", () => {
    expect(FUNCTIONS.length).toBeGreaterThanOrEqual(150);
    const names = new Set(FUNCTIONS.map((f) => f.name));
    expect(names.size).toBe(FUNCTIONS.length);
    for (const f of FUNCTIONS) {
      expect(f.description).not.toBe("");
      for (const a of f.args) expect(a.description, `${f.name}.${a.name}`).not.toBe("");
    }
  });

  it("includes the brief's key functions", () => {
    for (const n of ["SUMIFS", "XLOOKUP", "TEXTSPLIT", "NETWORKDAYS", "XIRR", "SORTBY", "LAMBDA", "ISNUMBER", "FLOOR.MATH", "STDEV.S"]) {
      expect(getFunctionInfo(n), n).toBeDefined();
    }
    expect(getFunctionInfo("_xlfn.xlookup")?.name).toBe("XLOOKUP");
  });

  it("formats signatures", () => {
    expect(formatSignature(getFunctionInfo("SUMIF")!)).toBe("SUMIF(rango, criterio, [rango_suma])");
    expect(formatSignature(getFunctionInfo("SUM")!)).toBe("SUM(número1, [número2...])");
    expect(formatSignature(getFunctionInfo("TODAY")!)).toBe("TODAY()");
  });

  it("maps argument indexes through repeating groups", () => {
    const sumifs = getFunctionInfo("SUMIFS")!;
    expect(argForIndex(sumifs, 0)?.arg.name).toBe("rango_suma");
    expect(argForIndex(sumifs, 3)?.arg.name).toBe("rango_criterios2");
    expect(argForIndex(sumifs, 4)).toMatchObject({ arg: { name: "criterio2" }, position: 3 });
    expect(argForIndex(sumifs, 5)?.arg.name).toBe("rango_criterios3");
    expect(argForIndex(getFunctionInfo("SUM")!, 4)?.arg.name).toBe("número5");
    expect(argForIndex(getFunctionInfo("IF")!, 3)).toBeNull();
    expect(argForIndex(getFunctionInfo("IFS")!, 3)?.arg.name).toBe("valor_si_verdadero2");
  });
});

describe("buildFunctionList", () => {
  it("intersects the catalog with engine names and keeps unknown engine functions", () => {
    const list = buildFunctionList(["sum", "SUM", "FOOBAR", "_xlfn.X", "VLOOKUP"]);
    expect(list.map((f) => f.name)).toEqual(["FOOBAR", "SUM", "VLOOKUP"]);
    expect(list[0].description).toBe("");
  });

  it("falls back to the whole catalog", () => {
    expect(buildFunctionList(null).length).toBe(FUNCTIONS.length);
  });
});

describe("completionContext", () => {
  it("finds the identifier being typed", () => {
    expect(ctx("=SU")).toEqual({ prefix: "SU", start: 1, end: 3 });
    expect(ctx("=A1+vlo")).toEqual({ prefix: "vlo", start: 4, end: 7 });
    expect(ctx("=IF(A1>0,su")).toEqual({ prefix: "su", start: 9, end: 11 });
    expect(ctx("=LOG1")).toEqual({ prefix: "LOG1", start: 1, end: 5 });
    expect(ctx("=STDEV.")).toEqual({ prefix: "STDEV.", start: 1, end: 7 });
  });

  it("is null where no function can go", () => {
    expect(ctx("SU")).toBeNull();
    expect(ctx('="SU')).toBeNull();
    expect(ctx("=SUM(")).toBeNull();
    expect(ctx("=$A")).toBeNull();
    expect(ctx("=A1 SU")).toBeNull();
    expect(ctx("=SU", 2)).toBeNull(); // caret in the middle of the word
    expect(ctx("=Hoja1!A")).toBeNull();
  });
});

describe("filterFunctions", () => {
  const list = buildFunctionList(null);
  it("matches by prefix, alphabetically", () => {
    const names = filterFunctions("sumi", list).map((f) => f.name);
    expect(names.slice(0, 2)).toEqual(["SUMIF", "SUMIFS"]);
  });

  it("matches Spanish names after English ones", () => {
    expect(filterFunctions("BUSCARV", list)[0].name).toBe("VLOOKUP");
    const si = filterFunctions("SI", list).map((f) => f.name);
    expect(si[0]).toBe("SIGN");
    expect(si).toContain("IF");
    expect(si.indexOf("IF")).toBeGreaterThan(si.indexOf("SIN"));
  });

  it("adds 'contains' matches for 3+ characters", () => {
    expect(filterFunctions("LOOKUP", list).map((f) => f.name)).toEqual(["LOOKUP", "HLOOKUP", "VLOOKUP", "XLOOKUP"]);
    expect(filterFunctions("UP", list).map((f) => f.name)).toEqual(["UPPER"]);
  });
});

describe("signatureContext", () => {
  it("tracks the innermost call and argument", () => {
    expect(sig("=SUM(")).toEqual({ name: "SUM", argIndex: 0, start: 1 });
    expect(sig("=IF(A1>0,")).toMatchObject({ name: "IF", argIndex: 1 });
    expect(sig("=IF(A1>0,SUM(B1,")).toMatchObject({ name: "SUM", argIndex: 1 });
    expect(sig("=IF(A1>0,SUM(B1,B2),")).toMatchObject({ name: "IF", argIndex: 2 });
    expect(sig('=IF(A1=",",')).toMatchObject({ name: "IF", argIndex: 1 });
    expect(sig("=SUM((A1+B1),")).toMatchObject({ name: "SUM", argIndex: 1 });
    expect(sig("=SUM({1,2,3},")).toMatchObject({ name: "SUM", argIndex: 1 });
    expect(sig("=_xlfn.XLOOKUP(A1,")).toMatchObject({ name: "XLOOKUP", argIndex: 1 });
  });

  it("uses the caret position", () => {
    expect(sig("=IF(A1,SUM(B1))", 5)).toMatchObject({ name: "IF", argIndex: 0 });
    expect(sig("=IF(A1,SUM(B1))", 12)).toMatchObject({ name: "SUM", argIndex: 0 });
    expect(sig("=SUM(A1)", 8)).toBeNull();
    expect(sig("=A1+1")).toBeNull();
  });
});

describe("valueCompletion", () => {
  const samples = ["Madrid", "Málaga", "Barcelona", "barcelona", "Bilbao", "Valencia"];
  it("completes a unique match", () => {
    expect(valueCompletion("Mad", samples)).toBe("rid");
    expect(valueCompletion("mad", samples)).toBe("rid");
    expect(valueCompletion("Bar", samples)).toBe("celona");
    expect(valueCompletion("V", samples)).toBe("alencia");
  });

  it("does nothing when ambiguous, exact or numeric", () => {
    expect(valueCompletion("B", samples)).toBeNull();
    expect(valueCompletion("Madrid", samples)).toBeNull();
    expect(valueCompletion("12", ["123"])).toBeNull();
    expect(valueCompletion("", samples)).toBeNull();
    expect(valueCompletion("=M", samples)).toBeNull();
  });
});
