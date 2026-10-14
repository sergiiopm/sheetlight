import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CellValue, CsvOptions } from "@/engine/contract";

/**
 * Fast guard for the committed corpus (tests/corpus/files): every file has an
 * expected JSON that matches the shared schema (see README.md), sizes stay
 * small, and the CSV byte-level properties the expectations claim (BOM,
 * encoding, line endings, delimiter) are really in the files. Values are
 * checked against engines by the Rust harness (src-tauri/tests).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const filesDir = path.join(here, "files");

interface ExpectedCell {
  readonly value?: CellValue;
  readonly anyOf?: ReadonlyArray<CellValue>;
  readonly display?: string;
  readonly input?: string;
}

interface Expected {
  readonly file: string;
  readonly kind: "xlsx" | "xls" | "csv";
  readonly description: string;
  readonly sheets: ReadonlyArray<string>;
  readonly activeSheet: string;
  readonly fidelity?: Readonly<Record<string, number>>;
  readonly csv?: CsvOptions;
  readonly bom?: boolean;
  readonly lineEnding?: "crlf" | "lf";
  readonly rows?: number;
  readonly cols?: number;
  readonly cells: Readonly<Record<string, ExpectedCell>>;
}

const FIDELITY_FEATURES = new Set([
  "charts", "images", "shapes", "comments", "dataValidation", "autoFilter", "conditionalFormatting",
  "pivotTables", "tables", "macros", "externalLinks", "sparklines", "slicers", "other",
]);

const dataFiles = readdirSync(filesDir).filter((n) => !n.endsWith(".expected.json") && !n.startsWith("."));

function loadExpected(name: string): Expected {
  return JSON.parse(readFileSync(path.join(filesDir, `${name}.expected.json`), "utf8")) as Expected;
}

function isCellValue(v: unknown): v is CellValue {
  if (typeof v !== "object" || v === null || !("type" in v)) return false;
  const t = (v as { type: unknown }).type;
  const value = (v as { value?: unknown }).value;
  switch (t) {
    case "empty":
      return value === undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "text":
    case "error":
      return typeof value === "string";
    case "bool":
      return typeof value === "boolean";
    default:
      return false;
  }
}

function decode(bytes: Buffer, encoding: string): string {
  const label = encoding === "utf-16le" ? "utf-16le" : encoding === "windows-1252" ? "windows-1252" : "utf-8";
  return new TextDecoder(label, { fatal: label !== "windows-1252", ignoreBOM: false }).decode(bytes);
}

describe("test corpus (tests/corpus/files)", () => {
  it("has the realistic Spanish files with expectations", () => {
    expect(dataFiles.filter((n) => n.endsWith(".xlsx")).length).toBeGreaterThanOrEqual(6);
    expect(dataFiles.filter((n) => n.endsWith(".csv")).length).toBeGreaterThanOrEqual(6);
    expect(dataFiles.filter((n) => n.endsWith(".xls")).length).toBeGreaterThanOrEqual(1);
    const orphans = readdirSync(filesDir)
      .filter((n) => n.endsWith(".expected.json"))
      .filter((n) => !dataFiles.includes(n.replace(/\.expected\.json$/, "")));
    expect(orphans).toEqual([]);
  });

  it.each(dataFiles)("%s: expected JSON follows the schema", (name) => {
    const exp = loadExpected(name);
    expect(exp.file).toBe(name);
    expect(path.extname(name).slice(1)).toBe(exp.kind);
    expect(statSync(path.join(filesDir, name)).size).toBeLessThan(1_000_000);
    expect(exp.description.length).toBeGreaterThan(20);
    expect(exp.sheets).toContain(exp.activeSheet);
    for (const feature of Object.keys(exp.fidelity ?? {})) {
      expect(FIDELITY_FEATURES.has(feature), `unknown FidelityFeature ${feature}`).toBe(true);
    }
    const refs = Object.entries(exp.cells);
    expect(refs.length).toBeGreaterThan(0);
    for (const [ref, cell] of refs) {
      const bang = ref.lastIndexOf("!");
      if (bang >= 0) expect(exp.sheets, ref).toContain(ref.slice(0, bang));
      expect(ref.slice(bang + 1), ref).toMatch(/^[A-Z]{1,3}[1-9]\d*$/);
      const candidates = cell.value ? [cell.value] : (cell.anyOf ?? []);
      expect(candidates.length, `${ref} has no value`).toBeGreaterThan(0);
      for (const v of candidates) expect(isCellValue(v), `${ref}: ${JSON.stringify(v)}`).toBe(true);
      if (cell.input !== undefined) expect(cell.input.startsWith("="), ref).toBe(true);
    }
  });

  const csvFiles = dataFiles.filter((n) => n.endsWith(".csv"));
  it.each(csvFiles)("%s: bytes match the declared CSV options", (name) => {
    const exp = loadExpected(name);
    const bytes = readFileSync(path.join(filesDir, name));
    const csv = exp.csv;
    expect(csv).toBeDefined();
    if (!csv?.encoding || !csv.delimiter) throw new Error("csv options incomplete");
    const bom =
      (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) || (bytes[0] === 0xff && bytes[1] === 0xfe);
    expect(bom).toBe(exp.bom);
    const text = decode(bytes, csv.encoding);
    expect(text.includes("�")).toBe(false);
    const hasCrlf = text.includes("\r\n");
    expect(hasCrlf ? "crlf" : "lf").toBe(exp.lineEnding);
    const header = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0];
    expect(header.split(csv.delimiter).length).toBeGreaterThanOrEqual(Math.min(exp.cols ?? 1, 5));
    if (csv.encoding === "windows-1252") expect(text).toMatch(/[ñáéíóú]/);
  });

  it.each(dataFiles.filter((n) => !n.endsWith(".csv")))("%s: has the container magic bytes of its kind", (name) => {
    const head = readFileSync(path.join(filesDir, name)).subarray(0, 4);
    // xlsx = zip package; xls = OLE2 compound document (BIFF8).
    const magic = name.endsWith(".xls") ? [0xd0, 0xcf, 0x11, 0xe0] : [0x50, 0x4b, 0x03, 0x04];
    expect([...head]).toEqual(magic);
  });

  it("known-gaps.json only references corpus files and cells", () => {
    const gaps = JSON.parse(readFileSync(path.join(here, "known-gaps.json"), "utf8")) as Record<string, unknown>;
    for (const [section, entries] of Object.entries(gaps)) {
      if (section.startsWith("_")) continue;
      for (const key of Object.keys(entries as Record<string, string>)) {
        const [file, cell] = key.split("|");
        expect(dataFiles, key).toContain(file);
        if (cell !== "*") expect(Object.keys(loadExpected(file).cells), key).toContain(cell);
      }
    }
  });
});
