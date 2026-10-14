import { describe, expect, it } from "vitest";
import {
  EN_US,
  ES_ES,
  canonicalNumber,
  classifyNumFmt,
  dateToSerial,
  parseUserInput,
  serialToDate,
  toEditText,
  type EditTextSource,
  type ParseOptions,
} from "@/lib/locale";

const today = new Date(2025, 5, 10); // 10 June 2025
const opts: ParseOptions = { today };
const es = (text: string, o: ParseOptions = opts) => parseUserInput(text, ES_ES, o);
const en = (text: string, o: ParseOptions = opts) => parseUserInput(text, EN_US, o);

describe("date serials", () => {
  it("matches Excel's 1900 date system", () => {
    expect(dateToSerial(1900, 1, 1)).toBe(1);
    expect(dateToSerial(1900, 2, 28)).toBe(59);
    expect(dateToSerial(1900, 2, 29)).toBe(60); // Lotus leap-year bug
    expect(dateToSerial(1900, 3, 1)).toBe(61);
    expect(dateToSerial(1970, 1, 1)).toBe(25569);
    expect(dateToSerial(2025, 2, 14)).toBe(45702);
    expect(dateToSerial(2024, 2, 29)).toBe(45351);
    expect(dateToSerial(9999, 12, 31)).toBe(2958465);
  });

  it("rejects invalid dates", () => {
    expect(dateToSerial(2025, 2, 29)).toBeNull();
    expect(dateToSerial(2025, 13, 1)).toBeNull();
    expect(dateToSerial(2025, 4, 31)).toBeNull();
    expect(dateToSerial(1899, 12, 31)).toBeNull();
    expect(dateToSerial(1900, 0, 1)).toBeNull();
  });

  it("round-trips serials to calendar parts", () => {
    for (const serial of [1, 59, 60, 61, 25569, 45702, 2958465]) {
      const p = serialToDate(serial);
      if (serial === 60) {
        expect(p).toMatchObject({ y: 1900, m: 2, d: 29 });
      } else {
        expect(dateToSerial(p.y, p.m, p.d)).toBe(serial);
      }
    }
    expect(serialToDate(45702.5)).toMatchObject({ y: 2025, m: 2, d: 14, hh: 12, mi: 0, ss: 0 });
    expect(serialToDate(0.395833333333333)).toMatchObject({ hh: 9, mi: 30, ss: 0 });
    expect(serialToDate(0.99999999999)).toMatchObject({ y: 1900, m: 1, d: 1, hh: 0 });
  });
});

describe("parseUserInput (es-ES) — numbers", () => {
  it.each([
    ["1234", "1234", undefined],
    ["1234,5", "1234.5", undefined],
    ["1.234,56", "1234.56", "#,##0.00"],
    ["1.234", "1234", "#,##0"],
    ["1.234.567", "1234567", "#,##0"],
    ["-5", "-5", undefined],
    ["+5", "5", undefined],
    ["-1.234,5", "-1234.5", "#,##0.00"],
    ["(5)", "-5", undefined],
    ["(1.234,5)", "-1234.5", "#,##0.00"],
    [",5", "0.5", undefined],
    ["12,", "12", undefined],
    ["007", "7", undefined],
    ["  42  ", "42", undefined],
    ["1,5E3", "1500", "0.00E+00"],
    ["2e-3", "0.002", "0.00E+00"],
    ["0", "0", undefined],
    ["-0", "0", undefined],
    ["0,1", "0.1", undefined],
    ["3 1/4", "3.25", "# ?/?"],
    ["0 1/2", "0.5", "# ?/?"],
    ["1 3/16", "1.1875", "# ??/??"],
  ])("%s → %s", (text, input, numFmt) => {
    const r = es(text);
    expect(r.kind).toBe("number");
    expect(r.input).toBe(input);
    expect(r.numFmt).toBe(numFmt);
  });

  it.each([
    ["12%", "0.12", "0%"],
    ["12,5 %", "0.125", "0.0%"],
    ["-3%", "-0.03", "0%"],
    ["7%", "0.07", "0%"],
    ["100%", "1", "0%"],
    ["0,25%", "0.0025", "0.00%"],
  ])("percent %s → %s %s", (text, input, numFmt) => {
    expect(es(text)).toEqual({ input, numFmt, kind: "number" });
  });

  it.each([
    ["1.234,56 €", "1234.56", '#,##0.00\\ "€"'],
    ["€1.234,56", "1234.56", '#,##0.00\\ "€"'],
    ["-5 €", "-5", '#,##0\\ "€"'],
    ["5€", "5", '#,##0\\ "€"'],
    ["-€5", "-5", '#,##0\\ "€"'],
    ["€-5", "-5", '#,##0\\ "€"'],
    ["(5 €)", "-5", '#,##0\\ "€"'],
    ["$10,5", "10.5", '"$"#,##0.00'],
  ])("currency %s → %s", (text, input, numFmt) => {
    expect(es(text)).toEqual({ input, numFmt, kind: "number" });
  });

  it.each(["1234.5", "1.2345", "12,34,5", "1.23", "--5", "(-5)", "5 5", "1e400", "€", "%", "1/0 2"])(
    "%s stays text",
    (text) => {
      expect(es(text).kind).toBe("text");
      expect(es(text).input).toBe(text);
    },
  );
});

describe("parseUserInput (es-ES) — dates and times", () => {
  const serial = (y: number, m: number, d: number) => String(dateToSerial(y, m, d));

  it.each([
    ["14/02/2025", serial(2025, 2, 14), "dd/mm/yyyy"],
    ["14/2/25", serial(2025, 2, 14), "dd/mm/yyyy"],
    ["14-2-2025", serial(2025, 2, 14), "dd/mm/yyyy"],
    ["14.02.2025", serial(2025, 2, 14), "dd/mm/yyyy"],
    ["1/1/30", serial(1930, 1, 1), "dd/mm/yyyy"],
    ["1/1/29", serial(2029, 1, 1), "dd/mm/yyyy"],
    ["2025-02-14", serial(2025, 2, 14), "dd/mm/yyyy"],
    ["2025/2/14", serial(2025, 2, 14), "dd/mm/yyyy"],
    ["14/2", serial(2025, 2, 14), "d-mmm"],
    ["1.5", serial(2025, 5, 1), "d-mmm"],
    ["1-2", serial(2025, 2, 1), "d-mmm"],
    ["14-feb", serial(2025, 2, 14), "d-mmm"],
    ["14 feb", serial(2025, 2, 14), "d-mmm"],
    ["14-feb-2025", serial(2025, 2, 14), "d-mmm-yy"],
    ["14 de febrero de 2025", serial(2025, 2, 14), "d-mmm-yy"],
    ["3-Sept-24", serial(2024, 9, 3), "d-mmm-yy"],
    ["feb-2025", serial(2025, 2, 1), "mmm-yy"],
    ["2/2025", serial(2025, 2, 1), "mmm-yy"],
    ["2/25", serial(2025, 2, 1), "mmm-yy"],
    ["29/02/1900", "60", "dd/mm/yyyy"],
  ])("%s → serial %s (%s)", (text, input, numFmt) => {
    const r = es(text);
    expect(r.kind).toBe("date");
    expect(r.input).toBe(input);
    expect(r.numFmt).toBe(numFmt);
  });

  it.each(["32/1/2025", "29/02/2025", "14/13/2025", "13/25", "0/1/2025", "1.2345", "14-febr", "hola 12", "may"])(
    "%s stays text",
    (text) => {
      expect(es(text).kind).toBe("text");
    },
  );

  it.each([
    ["9:30", 9.5 / 24, "h:mm"],
    ["14:05:10", (14 * 3600 + 5 * 60 + 10) / 86400, "h:mm:ss"],
    ["0:00", 0, "h:mm"],
    ["25:00", 25 / 24, "[h]:mm:ss"],
    ["9:30 pm", 21.5 / 24, "h:mm AM/PM"],
    ["12:15 a. m.", 0.25 / 24, "h:mm AM/PM"],
    ["12:00 p", 0.5, "h:mm AM/PM"],
  ])("time %s", (text, value, numFmt) => {
    const r = es(text);
    expect(r.kind).toBe("time");
    expect(Number(r.input)).toBeCloseTo(value, 12);
    expect(r.numFmt).toBe(numFmt);
  });

  it.each(["9:60", "13:00 pm", "9:30:75"])("invalid time %s stays text", (text) => {
    expect(es(text).kind).toBe("text");
  });

  it("parses date + time", () => {
    const r = es("14/02/2025 9:30");
    expect(r.kind).toBe("date");
    expect(Number(r.input)).toBeCloseTo(45702 + 9.5 / 24, 10);
    expect(r.numFmt).toBe("dd/mm/yyyy h:mm");
    expect(es("2025-02-14 14:05:10").numFmt).toBe("dd/mm/yyyy h:mm:ss");
  });
});

describe("parseUserInput — booleans, text and formulas", () => {
  it.each([
    ["VERDADERO", "TRUE"],
    ["verdadero", "TRUE"],
    ["FALSO", "FALSE"],
    ["true", "TRUE"],
    ["False", "FALSE"],
  ])("%s → %s", (text, input) => {
    expect(es(text)).toEqual({ input, kind: "bool" });
  });

  it("keeps a leading apostrophe as forced text", () => {
    expect(es("'0123")).toEqual({ input: "'0123", kind: "text" });
    expect(es("'=A1")).toEqual({ input: "'=A1", kind: "text" });
  });

  it("passes formulas through untouched (en-US)", () => {
    expect(es("=SUM(A1:A3)")).toEqual({ input: "=SUM(A1:A3)", kind: "formula" });
    expect(es("=A1*1,5")).toEqual({ input: "=A1*1,5", kind: "formula" });
  });

  it.each([
    ["-A1", "=-A1"],
    ["+A1", "=+A1"],
    ["+SUM(A1:A3)", "=+SUM(A1:A3)"],
    ["-5+3", "=-5+3"],
    ["- A1 * 2", "=- A1 * 2"],
    ["+$B$2/4", "=+$B$2/4"],
  ])("%s → formula %s", (text, input) => {
    expect(es(text)).toEqual({ input, kind: "formula" });
  });

  it.each(["- comprar pan", "-hola", "+34 600 123 456", "-", "+", "hola", "Total:", "  ", "A1"])("%s is text", (text) => {
    expect(es(text)).toEqual({ input: text, kind: "text" });
  });

  it("returns empty for empty input", () => {
    expect(es("")).toEqual({ input: "", kind: "empty" });
  });

  it("keeps text with inner newlines", () => {
    expect(es("línea 1\nlínea 2")).toEqual({ input: "línea 1\nlínea 2", kind: "text" });
  });
});

describe("parseUserInput — target cell format", () => {
  it("applies automatic percent entry to percent cells", () => {
    expect(es("12", { today, cellNumFmt: "0%" })).toEqual({ input: "0.12", kind: "number" });
    expect(es("0,5", { today, cellNumFmt: "0.00%" })).toEqual({ input: "0.5", kind: "number" });
    expect(es("12%", { today, cellNumFmt: "0.00%" })).toEqual({ input: "0.12", kind: "number" });
  });

  it("keeps an existing format of the same family", () => {
    expect(es("14/2/2025", { today, cellNumFmt: "d-mmm-yy" })).toEqual({ input: "45702", kind: "date" });
    expect(es("1.234", { today, cellNumFmt: '#,##0.00\\ "€"' })).toEqual({ input: "1234", kind: "number" });
    expect(es("5 €", { today, cellNumFmt: '#,##0.00\\ "€"' })).toEqual({ input: "5", kind: "number" });
  });

  it("overrides a different family", () => {
    expect(es("12%", { today, cellNumFmt: "dd/mm/yyyy" }).numFmt).toBe("0%");
    expect(es("5 €", { today, cellNumFmt: "0.00" }).numFmt).toBe('#,##0\\ "€"');
  });
});

describe("parseUserInput (en-US)", () => {
  it("uses . as decimal and , as group", () => {
    expect(en("1,234.56")).toEqual({ input: "1234.56", numFmt: "#,##0.00", kind: "number" });
    expect(en("1.5")).toEqual({ input: "1.5", kind: "number" });
    expect(en("$1,234.50")).toEqual({ input: "1234.5", numFmt: '"$"#,##0.00', kind: "number" });
    expect(en("1,5").kind).toBe("text");
  });

  it("parses MDY dates", () => {
    expect(en("2/14/2025")).toEqual({ input: "45702", numFmt: "m/d/yyyy", kind: "date" });
    expect(en("2/14")).toEqual({ input: String(dateToSerial(2025, 2, 14)), numFmt: "d-mmm", kind: "date" });
    expect(en("14/2/2025").kind).toBe("text");
    expect(en("feb 14, 2025")).toEqual({ input: "45702", numFmt: "d-mmm-yy", kind: "date" });
  });

  it("accepts TRUE/FALSE but not the Spanish words", () => {
    expect(en("true").input).toBe("TRUE");
    expect(en("VERDADERO").kind).toBe("text");
  });
});

describe("classifyNumFmt", () => {
  it.each([
    ["General", "general"],
    ["0.00", "number"],
    ["#,##0", "number"],
    ["0%", "percent"],
    ["0.0%", "percent"],
    ['#,##0.00\\ "€"', "currency"],
    ["[$€-C0A] #,##0.00", "currency"],
    ['"$"#,##0.00', "currency"],
    ["dd/mm/yyyy", "date"],
    ["d-mmm", "date"],
    ["mmm-yy", "date"],
    ["mmmm", "date"],
    ["h:mm", "time"],
    ["[h]:mm:ss", "time"],
    ["mm:ss", "time"],
    ["h:mm AM/PM", "time"],
    ["dd/mm/yyyy h:mm", "datetime"],
    ["0.00E+00", "scientific"],
    ["@", "text"],
    ['0.00 "días"', "number"],
    ["#,##0.00;[Red]-#,##0.00", "number"],
  ])("%s → %s", (fmt, kind) => {
    expect(classifyNumFmt(fmt)).toBe(kind);
  });
});

describe("canonicalNumber", () => {
  it("prints engine numbers", () => {
    expect(canonicalNumber(1234.5)).toBe("1234.5");
    expect(canonicalNumber(0.1 + 0.2)).toBe("0.3");
    expect(canonicalNumber(1e21)).toBe("1E+21");
    expect(canonicalNumber(1e-7)).toBe("1E-7");
    expect(canonicalNumber(-0)).toBe("0");
  });
});

describe("toEditText", () => {
  const cell = (input: string, value: EditTextSource["value"], numFmt = "General"): EditTextSource => ({
    input,
    value,
    format: { numFmt },
  });

  it("shows formulas as stored", () => {
    expect(toEditText(cell("=SUM(A1:A3)", { type: "number", value: 6 }), ES_ES)).toBe("=SUM(A1:A3)");
  });

  it("shows numbers with the locale decimal and no grouping", () => {
    expect(toEditText(cell("1234.5", { type: "number", value: 1234.5 }, "#,##0.00"), ES_ES)).toBe("1234,5");
    expect(toEditText(cell("-0.125", { type: "number", value: -0.125 }), ES_ES)).toBe("-0,125");
    expect(toEditText(cell("1234.5", { type: "number", value: 1234.5 }), EN_US)).toBe("1234.5");
    expect(toEditText(cell("1E+21", { type: "number", value: 1e21 }), ES_ES)).toBe("1E+21");
    expect(toEditText(cell("1500", { type: "number", value: 1500 }, '#,##0.00\\ "€"'), ES_ES)).toBe("1500");
  });

  it("shows percentages", () => {
    expect(toEditText(cell("0.125", { type: "number", value: 0.125 }, "0.0%"), ES_ES)).toBe("12,5%");
    expect(toEditText(cell("0.07", { type: "number", value: 0.07 }, "0%"), ES_ES)).toBe("7%");
  });

  it("shows dates and times", () => {
    expect(toEditText(cell("45702", { type: "number", value: 45702 }, "d-mmm-yy"), ES_ES)).toBe("14/02/2025");
    expect(toEditText(cell("45702", { type: "number", value: 45702 }, "dd/mm/yyyy"), EN_US)).toBe("2/14/2025");
    expect(toEditText(cell("0.395833333333333", { type: "number", value: 0.395833333333333 }, "h:mm"), ES_ES)).toBe("9:30:00");
    expect(toEditText(cell("45702.5", { type: "number", value: 45702.5 }, "dd/mm/yyyy h:mm"), ES_ES)).toBe("14/02/2025 12:00:00");
    expect(toEditText(cell("45702.25", { type: "number", value: 45702.25 }, "dd/mm/yyyy"), ES_ES)).toBe("14/02/2025 6:00:00");
  });

  it("shows booleans in the locale", () => {
    expect(toEditText(cell("TRUE", { type: "bool", value: true }), ES_ES)).toBe("VERDADERO");
    expect(toEditText(cell("FALSE", { type: "bool", value: false }), ES_ES)).toBe("FALSO");
    expect(toEditText(cell("TRUE", { type: "bool", value: true }), EN_US)).toBe("TRUE");
  });

  it("prefixes an apostrophe for text that would parse as something else", () => {
    expect(toEditText(cell("hola", { type: "text", value: "hola" }), ES_ES)).toBe("hola");
    expect(toEditText(cell("0123", { type: "text", value: "0123" }), ES_ES)).toBe("'0123");
    expect(toEditText(cell("'0123", { type: "text", value: "0123" }), ES_ES)).toBe("'0123");
    expect(toEditText(cell("0123", { type: "text", value: "0123" }, "@"), ES_ES)).toBe("0123");
    expect(toEditText(cell("-A1", { type: "text", value: "-A1" }), ES_ES)).toBe("'-A1");
  });

  it("handles empty and error values", () => {
    expect(toEditText(cell("", { type: "empty" }), ES_ES)).toBe("");
    expect(toEditText(cell("#N/A", { type: "error", value: "#N/A" }), ES_ES)).toBe("#N/A");
  });

  it("round-trips edit text through parseUserInput", () => {
    const samples: Array<[string, number, string]> = [
      ["1234.5", 1234.5, "General"],
      ["0.125", 0.125, "0.0%"],
      ["45702", 45702, "dd/mm/yyyy"],
    ];
    for (const [input, value, numFmt] of samples) {
      const text = toEditText(cell(input, { type: "number", value }, numFmt), ES_ES);
      expect(parseUserInput(text, ES_ES, { today, cellNumFmt: numFmt }).input).toBe(input);
    }
  });
});
