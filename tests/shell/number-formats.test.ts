import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_EUR,
  NUMBER_FORMAT_PRESETS,
  adjustDecimals,
  analyzeFormat,
  buildAccountingCode,
  buildCurrencyCode,
  buildNumberCode,
  buildPercentCode,
  delocalizeCode,
  displayDecimals,
  formatGeneral,
  formatPreview,
  localizeCode,
  serialToDate,
} from "@/lib/number-formats";

const fmt = (value: number | string, code: string) => formatPreview(value, code).text;

describe("number format presets", () => {
  it("stores Excel codes with en-US separators", () => {
    const byId = Object.fromEntries(NUMBER_FORMAT_PRESETS.map((p) => [p.id, p.code]));
    expect(byId.currency).toBe('#,##0.00\\ "€"');
    expect(byId.percent).toBe("0.00%");
    expect(byId.shortDate).toBe("dd/mm/yyyy");
    expect(byId.text).toBe("@");
    expect(NUMBER_FORMAT_PRESETS.every((p) => p.command === `format.numFmt.${p.id}`)).toBe(true);
  });

  it("builds number, currency, accounting and percent codes", () => {
    expect(buildNumberCode({ decimals: 2, thousands: true, negative: "minus" })).toBe("#,##0.00");
    expect(buildNumberCode({ decimals: 0, thousands: false, negative: "red" })).toBe("0;[Red]0");
    expect(buildCurrencyCode({ decimals: 2, symbol: "€", negative: "minus" })).toBe('#,##0.00\\ "€";\\-#,##0.00\\ "€"');
    expect(buildCurrencyCode({ decimals: 0, symbol: "$", negative: "minus" })).toBe('"$"#,##0;\\-"$"#,##0');
    expect(buildAccountingCode({ decimals: 2, symbol: "€" })).toBe(ACCOUNTING_EUR);
    expect(buildPercentCode(1)).toBe("0.0%");
  });
});

describe("formatPreview", () => {
  it("formats general numbers with Spanish separators", () => {
    expect(formatGeneral(1234.5)).toBe("1234,5");
    expect(formatGeneral(0.1 + 0.2)).toBe("0,3");
    expect(formatGeneral(1e12)).toBe("1E+12");
    expect(fmt(-3, "General")).toBe("-3");
  });

  it("formats numbers, thousands and decimals", () => {
    expect(fmt(1234.567, "#,##0.00")).toBe("1.234,57");
    expect(fmt(-1234.567, "#,##0.00")).toBe("-1.234,57");
    expect(fmt(1234567, "#,##0")).toBe("1.234.567");
    expect(fmt(0.5, "0.00")).toBe("0,50");
    expect(fmt(1.005, "0.00")).toBe("1,01");
    expect(fmt(12.5, "0.##")).toBe("12,5");
    expect(fmt(1234567, "#,##0,")).toBe("1.235");
  });

  it("formats currency with escaped and quoted literals", () => {
    expect(fmt(1234.5, '#,##0.00\\ "€"')).toBe("1.234,50 €");
    expect(fmt(-1234.5, '#,##0.00\\ "€";[Red]\\-#,##0.00\\ "€"')).toBe("-1.234,50 €");
    expect(formatPreview(-1, '#,##0.00\\ "€";[Red]\\-#,##0.00\\ "€"').color).toBe("#ff0000");
    expect(fmt(-5, "0_);\\(0\\)")).toBe("(5)");
    expect(fmt(1234.5, "[$€-x-euro2] #,##0.00")).toBe("€ 1.234,50");
  });

  it("formats accounting with the zero section", () => {
    expect(fmt(1234.5, ACCOUNTING_EUR).trim()).toBe("1.234,50 €");
    expect(fmt(0, ACCOUNTING_EUR).trim()).toBe("-   €");
  });

  it("formats percent and scientific", () => {
    expect(fmt(0.256, "0%")).toBe("26%");
    expect(fmt(0.256, "0.00%")).toBe("25,60%");
    expect(fmt(12345, "0.00E+00")).toBe("1,23E+04");
    expect(fmt(0.00012, "0.0E+00")).toBe("1,2E-04");
  });

  it("formats fractions", () => {
    expect(fmt(1.25, "# ?/?")).toBe("1 1/4");
    expect(fmt(0.5, "# ?/2")).toBe("1/2");
    expect(fmt(3, "# ?/?")).toBe("3");
  });

  it("formats dates and times in Spanish", () => {
    // 45678 = 2025-01-21 (Tuesday)
    expect(fmt(45678, "dd/mm/yyyy")).toBe("21/01/2025");
    expect(fmt(45678, 'dddd, d" de "mmmm" de "yyyy')).toBe("martes, 21 de enero de 2025");
    expect(fmt(45678, "d-mmm-yy")).toBe("21-ene-25");
    expect(fmt(45678.5, "h:mm:ss")).toBe("12:00:00");
    expect(fmt(45678.75, "h:mm AM/PM")).toBe("6:00 p. m.");
    expect(fmt(1.5, "[h]:mm:ss")).toBe("36:00:00");
    expect(fmt(45678.5104166667, "dd/mm/yyyy h:mm")).toBe("21/01/2025 12:15");
  });

  it("handles the 1900 leap-year bug", () => {
    expect(serialToDate(59)).toMatchObject({ y: 1900, m: 2, d: 28 });
    expect(serialToDate(60)).toMatchObject({ y: 1900, m: 2, d: 29 });
    expect(serialToDate(61)).toMatchObject({ y: 1900, m: 3, d: 1 });
    expect(serialToDate(1)).toMatchObject({ y: 1900, m: 1, d: 1 });
  });

  it("formats text with @", () => {
    expect(fmt("hola", "@")).toBe("hola");
    expect(fmt("x", '"Ref: "@')).toBe("Ref: x");
  });
});

describe("analyzeFormat", () => {
  it("detects categories and options", () => {
    expect(analyzeFormat("General").category).toBe("general");
    expect(analyzeFormat("@").category).toBe("text");
    expect(analyzeFormat("#,##0.00")).toMatchObject({ category: "number", decimals: 2, thousands: true });
    expect(analyzeFormat("0;[Red]0")).toMatchObject({ category: "number", decimals: 0, negative: "red" });
    expect(analyzeFormat('#,##0.00\\ "€"')).toMatchObject({ category: "currency", decimals: 2, symbol: "€" });
    expect(analyzeFormat(ACCOUNTING_EUR)).toMatchObject({ category: "accounting", decimals: 2, symbol: "€" });
    expect(analyzeFormat("dd/mm/yyyy").category).toBe("date");
    expect(analyzeFormat("h:mm:ss").category).toBe("time");
    expect(analyzeFormat("0.0%")).toMatchObject({ category: "percent", decimals: 1 });
    expect(analyzeFormat("0.00E+00")).toMatchObject({ category: "scientific", decimals: 2 });
    expect(analyzeFormat("# ?/?").category).toBe("fraction");
  });
});

describe("adjustDecimals", () => {
  it("adds and removes decimals in every numeric section", () => {
    expect(adjustDecimals("#,##0.00", 1)).toBe("#,##0.000");
    expect(adjustDecimals("#,##0.00", -1)).toBe("#,##0.0");
    expect(adjustDecimals("#,##0.0", -1)).toBe("#,##0");
    expect(adjustDecimals("#,##0", 1)).toBe("#,##0.0");
    expect(adjustDecimals("0%", 1)).toBe("0.0%");
    expect(adjustDecimals('#,##0.00\\ "€";[Red]\\-#,##0.00\\ "€"', 1)).toBe('#,##0.000\\ "€";[Red]\\-#,##0.000\\ "€"');
    expect(adjustDecimals("0.00E+00", -1)).toBe("0.0E+00");
    expect(adjustDecimals("0", -1)).toBe("0");
    expect(adjustDecimals("dd/mm/yyyy", 1)).toBe("dd/mm/yyyy");
  });

  it("starts from the displayed decimals for General", () => {
    expect(adjustDecimals("General", 1, 1)).toBe("0.00");
    expect(adjustDecimals("General", -1, 2)).toBe("0.0");
    expect(adjustDecimals("General", -1, 0)).toBe("0");
    expect(displayDecimals("1.234,567")).toBe(3);
    expect(displayDecimals("12")).toBe(0);
  });
});

describe("localized codes", () => {
  it("shows codes the way Excel ES does and converts back", () => {
    expect(localizeCode('#,##0.00\\ "€"')).toBe("#.##0,00 €");
    expect(localizeCode("General")).toBe("Estándar");
    expect(delocalizeCode("#.##0,00 €")).toBe('#,##0.00 "€"');
    expect(delocalizeCode("Estándar")).toBe("General");
    expect(fmt(1234.5, delocalizeCode("#.##0,00 €"))).toBe("1.234,50 €");
  });
});
