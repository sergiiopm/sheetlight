import { describe, expect, it } from "vitest";
import { isInString, tokenize, type TokenType } from "@/editor/tokenizer";

const types = (formula: string): Array<[TokenType, string]> => tokenize(formula).map((t) => [t.type, t.text]);

describe("tokenize", () => {
  it("covers the whole input", () => {
    for (const f of ["=SUM(A1:B2, 3) + 'My Sheet'!$C$4 & \"x\"", "=IF(A1>=2,\"a\"\"b\",#N/A)", "=¿?", "=\"open", "hello"]) {
      expect(tokenize(f).map((t) => t.text).join("")).toBe(f);
    }
  });

  it("tokenizes a simple formula", () => {
    expect(types("=SUM(A1:B2,3.5)")).toEqual([
      ["eq", "="],
      ["function", "SUM"],
      ["open", "("],
      ["ref", "A1:B2"],
      ["comma", ","],
      ["number", "3.5"],
      ["close", ")"],
    ]);
  });

  it("parses reference shapes", () => {
    const refs = tokenize("=A1+$B$2+C$3+$D4+A:A+$B:C+1:1+$2:$5+A1#+Hoja2!A1+'Mi hoja'!B2:C3+'It''s'!D4")
      .filter((t) => t.type === "ref")
      .map((t) => t.ref);
    expect(refs).toHaveLength(12);
    expect(refs[0]).toMatchObject({ kind: "cell", sheet: null, start: { row: 0, col: 0, rowAbs: false, colAbs: false } });
    expect(refs[1]).toMatchObject({ start: { row: 1, col: 1, rowAbs: true, colAbs: true } });
    expect(refs[2]).toMatchObject({ start: { rowAbs: true, colAbs: false } });
    expect(refs[3]).toMatchObject({ start: { rowAbs: false, colAbs: true } });
    expect(refs[4]).toMatchObject({ kind: "cols", start: { col: 0, row: -1 }, end: { col: 0 } });
    expect(refs[5]).toMatchObject({ kind: "cols", start: { col: 1, colAbs: true }, end: { col: 2, colAbs: false } });
    expect(refs[6]).toMatchObject({ kind: "rows", start: { row: 0 }, end: { row: 0 } });
    expect(refs[7]).toMatchObject({ kind: "rows", start: { row: 1, rowAbs: true }, end: { row: 4, rowAbs: true } });
    expect(refs[8]).toMatchObject({ kind: "cell", spill: true });
    expect(refs[9]).toMatchObject({ sheet: "Hoja2", kind: "cell" });
    expect(refs[10]).toMatchObject({ sheet: "Mi hoja", kind: "range", end: { row: 2, col: 2 } });
    expect(refs[11]).toMatchObject({ sheet: "It's" });
  });

  it("distinguishes functions, names and refs", () => {
    expect(types("=LOG10(A1)")[1]).toEqual(["function", "LOG10"]);
    expect(types("=LOG10+1")[1]).toEqual(["ref", "LOG10"]);
    expect(types("=A1B")[1]).toEqual(["name", "A1B"]);
    expect(types("=Ventas*2")[1]).toEqual(["name", "Ventas"]);
    expect(types("=STDEV.S(A1:A3)")[1]).toEqual(["function", "STDEV.S"]);
    expect(types("=_xlfn.XLOOKUP(1,A:A,B:B)")[1]).toEqual(["function", "_xlfn.XLOOKUP"]);
    expect(types("=Tabla1[Importe]")[1]).toEqual(["name", "Tabla1[Importe]"]);
    expect(types("=XFE1")[1]).toEqual(["name", "XFE1"]);
  });

  it("recognizes literals", () => {
    expect(types('="a""b"')[1]).toEqual(["string", '"a""b"']);
    expect(tokenize('="abc')[1]).toMatchObject({ type: "string", unterminated: true });
    expect(types("=TRUE")[1]).toEqual(["bool", "TRUE"]);
    expect(types("=TRUE()")[1]).toEqual(["function", "TRUE"]);
    expect(types("=#DIV/0!")[1]).toEqual(["error", "#DIV/0!"]);
    expect(types("=#n/a")[1]).toEqual(["error", "#n/a"]);
    expect(types("=1.5E+3")[1]).toEqual(["number", "1.5E+3"]);
    expect(types("=.5")[1]).toEqual(["number", ".5"]);
  });

  it("recognizes operators and separators", () => {
    expect(types("=A1<>B1").map((t) => t[0])).toEqual(["eq", "ref", "operator", "ref"]);
    expect(types("=A1<=1")[2]).toEqual(["operator", "<="]);
    expect(types("={1,2;3,4}").map((t) => t[0])).toEqual([
      "eq", "arrayOpen", "number", "comma", "number", "semicolon", "number", "comma", "number", "arrayClose",
    ]);
    expect(types("=10%")[2]).toEqual(["operator", "%"]);
  });

  it("keeps a decimal comma as an argument separator (en-US)", () => {
    expect(types("=A1*1,5").map((t) => t[0])).toEqual(["eq", "ref", "operator", "number", "comma", "number"]);
  });

  it("detects positions inside strings", () => {
    const tokens = tokenize('=A1&"xy"');
    expect(isInString(tokens, 5)).toBe(true);
    expect(isInString(tokens, 4)).toBe(false);
    expect(isInString(tokens, 8)).toBe(false);
    expect(isInString(tokenize('="ab'), 4)).toBe(true);
  });
});
