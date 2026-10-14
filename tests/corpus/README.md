# Test corpus

Realistic Spanish workbooks and CSVs used by the engine, file-layer, e2e and
benchmark tests. Everything here is produced by a deterministic generator; the
expected values are computed independently in Python (`corpus_lib/esfmt.py`),
never read back from a spreadsheet engine.

| Path | In git | Content |
|---|---|---|
| `files/` | yes (each file < 1 MB) | 6 `.xlsx` + 6 `.csv` with `<file>.expected.json` |
| `generated/` | no (`.gitignore`) | large benchmark files (~200 MB) |
| `private/` | no | your own real files for manual checks (never commit) |
| `known-gaps.json` | yes | accepted deviations per test section, with the reason |

## Commands

```bash
python -m venv tests/corpus/.venv
tests/corpus/.venv/Scripts/python -m pip install -r tests/corpus/requirements.txt   # Windows
tests/corpus/.venv/Scripts/python tests/corpus/gen_corpus.py files   # rewrite files/ (committed)
tests/corpus/.venv/Scripts/python tests/corpus/gen_corpus.py big     # write generated/ (benchmarks)
tests/corpus/.venv/Scripts/python tests/corpus/gen_corpus.py check   # CI: regenerate in a temp dir, byte-compare
```

`files/**` is marked `-text` in `tests/corpus/.gitattributes`, so git never
rewrites line endings (CRLF/LF and BOMs are part of what the CSVs test).
Change a file only by changing the generator and running `files`; `check`
fails otherwise.

## Who uses it

| Test | Where | Status |
|---|---|---|
| Schema / bytes guard | `tests/corpus/corpus.test.ts` (Vitest, `npm test`) | runs |
| Manifest + `xlsx_package::inspect` accepts every workbook | `src-tauri/tests/corpus_files.rs` | runs |
| IronCalc baseline: values, es display, formula text, frozen panes, merges | `src-tauri/tests/ironcalc_baseline.rs` | runs (gaps in `known-gaps.json`) |
| Fidelity warnings, chart/autofilter extraction | `corpus_files.rs` `xlsx_inspect_reports_every_fidelity_feature` | `#[ignore]` until WS3 |
| CSV detection (delimiter/encoding/decimal), rows, values | `corpus_files.rs` `csv_store_*` | `#[ignore]` until WS3 |
| Workbook backend values/display/input + sheet structure | `src-tauri/tests/engine_corpus.rs` | `#[ignore]` until WS2 (`open_workbook` TODO) |
| Benchmarks | `tests/bench/` | see its README |

Run the ignored ones with `cd src-tauri && cargo test --tests -- --ignored`.

## Expected JSON schema

```jsonc
{
  "file": "presupuesto_familiar.xlsx",
  "kind": "xlsx",                         // or "csv"
  "description": "...",
  "sheets": ["Presupuesto 2025", "Movimientos", "Categorías"],   // in order
  "activeSheet": "Presupuesto 2025",
  "definedNames": {"Ventas": "Datos!$F$2:$F$13"},
  "features": {                            // per sheet; 0-based row/col indices
    "Clientes": {"frozen": [1, 2], "merges": ["A1:C1"], "autoFilter": "A1:O251",
                 "filteredCols": [6], "hiddenRows": [2, 3], "hiddenCols": [14],
                 "colWidths": 14, "conditionalFormats": 0, "dataValidations": 0,
                 "comments": 0, "hyperlinks": 0, "images": 0, "charts": 0}
  },
  "fidelity": {"charts": 3, "images": 1, "comments": 3,          // FidelityFeature -> count
               "dataValidation": 3, "conditionalFormatting": 1, "autoFilter": 1},
  "cells": {
    "Presupuesto 2025!N8": {
      "value": {"type": "number", "value": 63209.57},  // = contract CellValue
      "display": "63.209,57 €",                          // es-ES, optional
      "input": "=SUM(N5:N7)"                             // en-US formula, optional
    }
  },
  // CSV only:
  "csv": {"delimiter": ";", "encoding": "utf-8", "decimal": ","},  // what auto-detection must find
  "bom": true, "lineEnding": "crlf",
  "rows": 61, "cols": 6                    // logical records incl. header; max fields per record
}
```

- CSV cell keys have no sheet prefix (single sheet named after the file stem).
- `anyOf: [CellValue, …]` replaces `value` where Excel's behavior is debatable
  (leading zeros, `TRUE` vs `VERDADERO`, 20-digit numbers…); any listed value passes.
- `display` is only given where it is unambiguous: "General" numbers with
  more than 9 significant digits, date-times and errors are not pinned.
- Numbers compare with a relative tolerance of 1e-6.

## Files

### `presupuesto_familiar.xlsx` — family budget
Sheets *Presupuesto 2025* (active), *Movimientos* (~310 rows), *Categorías*.
- Month × category grid filled with `SUMIFS` over the movements sheet (criteria
  from the row label and a literal month), `SUMIF`, `AVERAGE`, `VLOOKUP` into
  `Categorías!…` (unquoted sheet name with an accent), section totals, net
  savings and savings rate.
- Formats: `#,##0.00 "€"`, the Excel es-ES "Moneda" code `#,##0.00\ [$€-C0A]`,
  `#,##0.00 "€";[Red]-#,##0.00 "€"`, `0.0%`, `dd/mm/yyyy`.
- 3 conditional formats (cell rule, 3-colour scale, data bar), merged title,
  frozen panes at B4, autofilter on *Movimientos*, column widths, `=MONTH()`.

### `cuenta_resultados.xlsx` — P&L of a small company
Sheets *PyG*, *Diario* (~370 journal lines), *Plan contable*, *Préstamo*, *Inversión*.
- Quarterly P&L with `-SUMIFS(…, Diario!$H…, B$4)` against text quarters built
  with `="T"&ROUNDUP(G2/3,0)`, EBITDA/EBIT/taxes with `MAX` and a `25%` literal.
- Per-account detail with `INDEX/MATCH`, `XLOOKUP` (with not-found value),
  `SUMIF`, `COUNTIF`, `AVERAGEIF`, `MAXIFS`; an unknown account giving
  `#N/A` (`VLOOKUP`) and `#DIV/0!`.
- Loan: `PMT`, `EOMONTH`, 24-month amortization table, long date format
  `d "de" mmmm "de" yyyy`. Investment: `NPV`, `IRR`, `FV`, payback.
- Sheet names with spaces and accents (`'Plan contable'!`, *Préstamo*, *Inversión*).

### `clientes_inventario.xlsx` — customer list and stock
- *Clientes* (250 rows): autofilter with an **active filter** on *Provincia*
  (Madrid, Barcelona; the other 189 rows are hidden), frozen panes (1 row, 2 cols), a hidden
  column, postcodes (`08001`) and phones stored as text, booleans, `IF` risk.
- *Inventario* (120 rows): merged two-level header, hidden rows 41–43,
  `SUBTOTAL(9,…)` vs `SUBTOTAL(109,…)` vs `SUM`, `COUNTIF("Sí")`, margins in %.
- *Resumen*: `COUNTIF`, `COUNTIFS` with a `TRUE` criterion, `SUMIF`,
  `AVERAGEIF`, `COUNTA`, `MAX`, `LARGE`, `MEDIAN`.

### `informe_ventas.xlsx` — report with charts
- *Informe* (active): logo image, clustered column chart (4 series), line chart
  (total vs target), pie chart with percentage labels, 3 comments, data
  validation (list from a defined name, whole number 1–12, date range),
  internal and external hyperlinks, KPIs with `INDEX/MATCH/MAX`, defined names
  `Ventas` and `Regiones` used in formulas.
- *Datos*: monthly sales by region, totals, `% objetivo` with an icon set.

### `facturas.xlsx` — invoice and invoice register
- *Factura*: merged and wrapped issuer block (`\n` line breaks), invoice lines
  with discount, base and VAT per line (`ROUND`), VAT summary per rate
  (21/10/4 %) with `SUMIF` on a numeric criterion, IRPF with a `15%` literal,
  total, a cross-check, IBAN as text.
- *Registro*: 20 invoices, one pulled from *Factura* (`=Factura!F24`,
  `=Factura!G3`), booleans *Cobrada*, days overdue from a fixed reference date,
  quarterly totals with `SUMIFS(…,">="&DATE(…),…,"<"&DATE(…))`,
  `SUMIF(…,FALSE,…)`, `COUNTIF(…,TRUE)`.

### `horario_calendario.xlsx` — timetable, shifts and calendar
- *Horario*: 30-minute slots built with `=TIME(8,0,0)` and `=A3+TIME(0,30,0)`
  (`hh:mm`), vertical and horizontal merges with fills, 90° rotated text.
- *Turnos*: shift hours with `MOD(salida-entrada,1)` (night shifts), `[h]:mm`
  totals over 24 h, `SUMIF` per employee.
- *Calendario 2026*: month grids from `DATE/WEEKDAY`, `mmmm yyyy` and `d`
  formats, formula-based conditional formats, Spanish national holidays,
  `NETWORKDAYS`, `WORKDAY` with a holiday range, `SUMPRODUCT`, `dddd`.

### CSV files

| File | Encoding | Delimiter | Decimal | EOL | Exercises |
|---|---|---|---|---|---|
| `movimientos_banco_es.csv` | UTF-8 + BOM | `;` | `,` | CRLF | bank export: `dd/mm/yyyy`, thousands `.` in the balance, commas inside unquoted fields |
| `clientes_win1252.csv` | Windows-1252 | `;` | `,` | CRLF | ñ ç º ª € — «» ¿¡, `""` escapes, `;` and CRLF inside quoted fields |
| `inventario_tabuladores.csv` | UTF-8 | tab | `.` | LF | commas, `;` and a stray `"` inside fields (delimiter sniffing) |
| `unicode_utf16le.csv` | UTF-16LE + BOM | tab | `.` | CRLF | Excel "Texto Unicode" export: Greek, Japanese, Cyrillic, currency symbols, an emoji |
| `sensores_iso.csv` | UTF-8 | `,` | `.` | LF | ISO dates and date-times, negatives, scientific notation |
| `columnas_mixtas.csv` | UTF-8 | `,` | `.` | CRLF, no final EOL | mixed types, leading zeros, IBAN, 20-digit numbers, `12%`, `TRUE`/`VERDADERO`, `#N/A`, `(123)`, empty cells, ragged rows, **formula-looking text must stay text** (CSV injection) |

### `generated/` (benchmarks)

Same seeds and content as the Phase 0 spike, so numbers compare with
`docs/spikes/ironcalc-engine.md`:

| File | Size | Use |
|---|---|---|
| `big_100k.xlsx` | ~15 MB | open-time target (100k rows × 20 cols + 100k formulas) |
| `chain_100k.xlsx` | ~1 MB | recalc target (A1=1, A2=A1+1 … A100000) |
| `big_1M.csv` | ~79 MB | 1M-row CSV target (UTF-8, `,`, ISO dates) |
| `big_1M_es.csv` | ~80 MB | same rows as a Spanish export (`;`, decimal comma, `dd/mm/yyyy`, BOM) |

Each has a small `.expected.json` (rows, cols, CSV options, a few cells).

## Known gaps found by the IronCalc baseline (2026-10-14, rev `341ec87`)

Listed cell by cell in `known-gaps.json` (section `ironcalc`); WS2 owns the fixes or workarounds.

1. **Time and x.xx5 rounding**: IronCalc formats the raw double; Excel rounds
   to 15 significant digits first. Times built with `A3+TIME(0,30,0)` show
   `11:29` instead of `11:30`; a `MEDIAN` ending in .xx5 shows one cent less.
2. **`[$€-C0A]` currency format** (Excel es-ES default "Moneda"): rendered as
   `€9.360,00 ` instead of `9.360,00 €`.
3. **Near-zero results**: `718,8 - 59,9*12` shows `-0,00 €`; Excel snaps it to 0.
4. **Implicit intersection on range arguments**: `WORKDAY(…, J3:J11)` holidays
   and `SUMPRODUCT((WEEKDAY(J3:J11,2)<6)*1)` evaluate to `#VALUE!` (IronCalc
   inserts `@`). Correctness bug.
5. **Formula text is re-serialized**: `=@INDEX(…)` (Excel 365 also shows `@`
   for legacy `INDEX`; decide policy) and redundant parentheses are dropped.

Booleans and errors are not display-checked in the baseline: the es display
(`VERDADERO`/`FALSO`, error text) is a Sheetlight decision checked at the
backend level (`engine_corpus.rs`); see `docs/qa/excel-behavior.md`.
