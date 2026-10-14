# Excel behavior spec

What Sheetlight must do the way Excel (Windows, es-ES) does it, for the v0.1
scope in `docs/PLAN.md`. Every row names the test that pins it; a row without
a test is an open coverage gap (listed at the end). Status: **ok** = covered
and passing, **bug** = covered by an `#[ignore]`d / known-gap test that fails
today, **gap** = not covered yet, **decision** = deliberate difference from
Excel.

Test locations (paths from the repo root):

| Short name | File |
|---|---|
| `sel` | `tests/grid/selection.test.ts` (selection model, Vitest) |
| `int` | `tests/grid/interactions.test.ts` (grid controller, Vitest) |
| `brw` | `tests/grid/browser/interaction.test.ts` (real Chromium, Vitest + Playwright) |
| `ses` | `tests/editor/session.test.ts` (edit session: in-cell editor + formula bar) |
| `ref` | `tests/editor/references.test.ts` · `aut` `tests/editor/autocomplete.test.ts` |
| `eb` | `src-tauri/tests/excel_behavior.rs` (engine actor; ids `EB-xx`) |
| `fn` | `src-tauri/tests/engine_functions.rs` · `rt` `src-tauri/tests/engine_roundtrip.rs` |
| `wb` | `src-tauri/src/engine/workbook/tests.rs` and the unit tests next to it (WS2) |

Run: `npm test` (sel/int/brw/ses/ref/aut; brw needs a Chromium, see
`tests/grid/browser/browser-env.ts`), `cd src-tauri && cargo test` (the rest),
`cargo test -- --ignored` for the open bugs.

## 1. Keyboard navigation

| # | Excel behavior | Status | Test |
|---|---|---|---|
| K1 | Arrows move one cell; skip hidden rows/columns | ok | brw "keyboard navigation: arrows skip hidden rows/cols, Shift extends, Home / Ctrl+Home / Tab / Enter" |
| K2 | Ctrl+Arrow jumps to the edge of the data block, then to the next block, then to the sheet edge (row 1048576 / column XFD) | ok | brw "Ctrl+arrows jump to the data edge like Excel (hidden rows skipped)"; eb `ctrl_arrows_jump_between_data_blocks`, `ctrl_arrows_in_empty_rows_reach_the_sheet_edges` |
| K3 | Shift+Arrow / Ctrl+Shift+Arrow extend the selection from the anchor | ok | brw K1 test; int "routes keys to navigation, edit requests and the shell" |
| K4 | Home → column A of the row; Ctrl+Home → A1, or the first unfrozen cell with frozen panes | ok | int "Home / Ctrl+Home respect frozen panes; Page Down scrolls a screen" |
| K5 | Ctrl+End → last used cell; End then Arrow behaves like Ctrl+Arrow (End mode) | ok | int "End mode: End then an arrow jumps like Ctrl+arrow; End, Home goes to the last used cell" |
| K6 | Page Down / Page Up move one screen and scroll with it | ok | brw "Page Down moves a screen and scrolls with it" |
| K7 | Tab / Shift+Tab move right/left; Enter / Shift+Enter down/up; inside a multi-cell selection they cycle within it and wrap across ranges, skipping hidden cells and merge interiors | ok | sel "Tab / Enter cycle the active cell inside the selection", "cycling skips hidden cells and merge interiors, and wraps across ranges"; ses "Enter and Tab walk a multi-cell selection" |
| K8 | Enter after a run of Tabs returns to the column where the run started | ok | ses "Enter after a Tab sequence returns to the starting column" |
| K9 | Unhandled shortcuts reach the app (Ctrl+S, Ctrl+B…) | ok | brw "unhandled shortcuts bubble to onUnhandledKey"; `tests/unit/commands.test.ts` "matches shortcuts with exact modifiers" |

## 2. Selection

| # | Excel behavior | Status | Test |
|---|---|---|---|
| S1 | Click selects, Shift+click extends from the anchor, Ctrl+click adds a range | ok | sel "click, shift-extend, ctrl-add"; brw "click, Shift+click and Ctrl+click build Excel selections" |
| S2 | Drag selects a range; dragging past the edge auto-scrolls | ok | brw "drag-selects a range", "drag-selecting past the bottom edge auto-scrolls and keeps extending" |
| S3 | Selections expand to cover merged cells; clicking a merge selects it with the active cell at its top-left | ok | sel "expands to merged cells"; brw "clicking a merged cell selects the whole merge…" |
| S4 | Header click selects a row/column, corner selects the sheet; Ctrl+Space / Shift+Space / Ctrl+A | ok | sel "row/column/all selection"; brw "header and corner clicks…"; int "selection shortcuts: Ctrl+A, Ctrl+Space, Shift+Space, Space types" |
| S5 | Right click keeps a selection that contains the cell, otherwise selects the cell | ok | int / brw "…keeps a selection that contains the clicked cell…" |
| S6 | Status bar: Recuento counts non-empty cells, Suma / Promedio / Mín / Máx only numbers, over all selected ranges | ok | eb `status_bar_stats_follow_excel`; wb `selection_stats_range_values_and_edges` |

## 3. Editing

| # | Excel behavior | Status | Test |
|---|---|---|---|
| E1 | Typing on a cell starts Enter mode replacing the content; F2 / double click edit the existing content (Edit mode); Backspace starts empty; Delete clears contents only | ok | brw "edit requests: typing, F2, Backspace, double click; Delete clears contents"; ses "Backspace starts with an empty editor"; wb `clear_contents_keeps_formats` |
| E2 | In Enter mode arrows commit and move; in Edit mode (F2 toggles) arrows move the caret | ok | ses "arrow keys commit and move in Enter mode", "F2 toggles Edit mode, where arrows move the caret" |
| E3 | Esc cancels; ✓ / ✕ in the formula bar commit / cancel without moving | ok | ses "Esc cancels without committing", "the ✓ button commits without moving and ✕ cancels" |
| E4 | Alt+Enter inserts a line break and turns on wrap | ok | ses "Alt+Enter inserts a newline and commits with wrap" |
| E5 | Ctrl+Enter fills the whole selection (formulas shifted) and keeps it selected | ok | ses "Ctrl+Enter fills the selection with shifted formulas and keeps the selection", "Ctrl+Enter fills values with their number format" |
| E6 | Typing `14/02/2025`, `12,5 %`, `1.234,50 €` (es) stores a date / percent / number and applies the matching format | ok | ses "sends the number format of typed dates, percents and currency"; wb `locale_in.rs` `dates_and_times`, `percent_and_currency`, `spanish_numbers` |
| E7 | A leading apostrophe forces text and is not displayed (`'00123`, `'=1+1`) | ok | eb `apostrophe_forces_text` |
| E8 | AutoComplete of text already in the column; Backspace drops the suggestion | ok | ses "suggests existing text from the same column", "Backspace drops the suggestion" |
| E9 | IME composition (accents via dead keys, Japanese) never commits half-composed text | ok | int "IME composition opens the editor without consuming the key"; ses "ignores keys while an IME composition is in progress" |
| E10 | One edit / paste / fill is one undo step; undo restores the content and re-selects the edited cells; a new edit clears redo | ok | eb `undo_restores_value_and_selection`, `one_batch_is_one_undo_step`; wb `one_apply_is_one_undo_step`, `new_apply_clears_redo`; rt `editing_a_precedent_recalculates_dependents_and_undo_restores` |
| E11 | Booleans show as VERDADERO / FALSO | ok | eb `booleans_display_in_spanish` |
| E12 | Error values show Excel's English codes (`#DIV/0!`, `#N/A`) — Excel es-ES shows `#¡DIV/0!`, `#N/D` | decision | eb `booleans_display_in_spanish`; formulas are en-US, so error codes stay en-US too |

## 4. Formulas

| # | Excel behavior | Status | Test |
|---|---|---|---|
| F1 | Formula syntax en-US (`,` separator, `.` decimal); ~150 most-used functions give Excel's results | ok | fn `functions_return_excel_results` (≈300 formulas, 250+ functions), `every_tested_function_is_listed` |
| F2 | Errors: `#DIV/0!`, `#N/A`, `#VALUE!`, `#NAME?`, `#REF!`, `#NUM!` where Excel gives them | ok | fn (error rows); eb `delete_referenced_row_gives_ref_error` |
| F3 | Reference intersection (`A1:A5 A3:B3`) and union (`(A1:A2,B1:B2)`) | **bug** | fn `KNOWN`, strict `functions_return_excel_results_strict` |
| F4 | Range arguments in WORKDAY holidays / WEEKDAY inside SUMPRODUCT evaluate as ranges, not implicit intersection | **bug** | corpus `horario_calendario.xlsx` K16/K18/K19 (known-gaps `workbook`) |
| F5 | The formula bar shows the formula as typed (function names upper-cased) | ok / **bug** for legacy `INDEX` (`=@INDEX`) and dropped parentheses | fn `formulas_keep_their_en_us_text`; corpus known gaps |
| F6 | Invalid formula: the editor stays open with a Spanish message | ok | ses "keeps the editor open with a Spanish message on an invalid formula", "reopens the editor when the engine rejects the formula" |
| F7 | Missing closing parentheses are added on commit | ok | ses "auto-closes parentheses on commit"; ref "closes parentheses and strings" |
| F8 | Function autocomplete (also by Spanish name) with signature help; Esc closes the list first | ok | ses "autocompletes function names with keyboard navigation", "finds functions by their Spanish name", "Esc closes the completion list first, then cancels"; aut "signatureContext" |
| F9 | Arrow keys / clicks while typing a formula insert references (point mode) where a reference may go | ok | ses "picks references with arrow keys in Enter mode", "installs the grid reference picker where a ref may go"; ref "canInsertRefAt"; brw "reference picker…" |
| F10 | Referenced ranges are colored in the editor and on the grid | ok | ses "pushes colored ref highlights to the grid"; ref "colorRefs" |
| F11 | F4 cycles `A1` → `$A$1` → `A$1` → `$A1` | ok | ref "cycles the ref at the caret through the four modes"; ses "F4 cycles the reference at the caret" |
| F12 | `+` / `-` start a formula like `=` | ok | ses "+/- formulas are committed as formulas" |
| F13 | Editing a precedent recalculates dependents (also across sheets) | ok | rt `editing_a_precedent_recalculates_dependents_and_undo_restores`; wb `set_cells_and_recalculate_formulas` |

## 5. Fill handle

| # | Excel behavior | Status | Test |
|---|---|---|---|
| H1 | Dragging the handle extends along the axis with the larger distance; dragging back inside clears | ok | int "extends along the axis with the larger distance and shrinks back inside", "commits a fill op, or clears what was dragged back over"; brw "fill handle drag emits a fill op and selects the target" |
| H2 | Double click fills down as far as the neighbouring column has data | ok | int "double click fills down as far as the neighbouring column has data" |
| H3 | A single number is copied; two or more numbers continue the linear step (also upwards) | ok | eb `fill_single_number_copies`, `fill_two_numbers_continue_the_step_down_and_up`; wb `fill.rs` `numbers` |
| H4 | One date steps by a day; dates a month apart step by months | ok | eb `fill_dates_by_day_and_by_month`; wb `fill.rs` `dates` |
| H5 | Month / weekday names (es and en, full and abbreviated) continue and wrap, keeping capitalization | ok | eb `fill_spanish_month_and_weekday_names`; wb `fill_month_names`, `fill.rs` `month_and_day_names` |
| H6 | Text ending in a number increments; other text is copied | ok | eb `fill_text_with_numbers_increments` |
| H7 | Formulas shift relative references only, in both directions | ok | eb `fill_formulas_shift_relative_references_only`; wb `fill_series_numbers_and_formulas` |
| H8 | Formats are copied with the values; the filled range stays selected | ok | eb `fill_selects_target_and_copies_formats` |
| H9 | Ctrl+drag toggles copy vs series | gap | — |

## 6. Clipboard and paste

| # | Excel behavior | Status | Test |
|---|---|---|---|
| C1 | Copy puts the displayed values on the system clipboard as TSV (+ HTML) | ok | eb `copy_puts_displayed_values_as_tsv`; wb `copy_paste_internal_shifts_formulas`, `clipboard.rs` `tsv_quoting` |
| C2 | Copy shows a marching-ants marquee until Esc / the next edit | ok (drawing) | brw "copy marquee and ref highlights draw on the overlay layer only" |
| C3 | Paste of an internal copy keeps formulas (shifted) and formats | ok | wb `copy_paste_internal_shifts_formulas` |
| C4 | Cut + paste moves the cells; formulas pointing at them follow | ok | eb `cut_paste_moves_and_dependents_follow` |
| C5 | Pasting one cell into a bigger selection fills all of it | ok | eb `paste_single_cell_into_a_range_fills_it` |
| C6 | Paste special: values; transpose | ok | eb `paste_values_and_transpose` |
| C7 | Transpose also transposes formula references | **bug** | eb `transpose_paste_transposes_formula_references` (ignored) |
| C8 | Text from Excel es / Google Sheets / LibreOffice (TSV and HTML) is typed with the es locale (dates, `1.234,5`, VERDADERO) | ok | eb `paste_text_from_excel_es_types_values`; wb `paste_text_from_other_apps`, `paste.rs` `excel_html`, `google_sheets_html`, `libreoffice_html`, `tsv_with_quotes_and_newlines` |

## 7. Structure, sort, filter, find

| # | Excel behavior | Status | Test |
|---|---|---|---|
| T1 | Inserting rows inside a referenced range extends it; deleting a referenced row gives `#REF!` | ok | eb `insert_row_inside_a_range_extends_formulas`, `delete_referenced_row_gives_ref_error`; wb `insert_and_delete_rows_adjust_formulas` |
| T2 | Resizing one of several selected columns resizes all; double click on the border autofits; dragging a hidden column open unhides it | ok | int "resizing one of several selected columns…", "a column outside the header selection resizes alone…", "autofit groups columns…"; brw "dragging a column border resizes; double click autofits" |
| T3 | Frozen panes stay put while scrolling | ok | brw "frozen panes: cells in the frozen area stay put while scrolling" |
| T4 | Sort ascending: numbers, then text (case-insensitive), blanks always last; descending reverses but blanks stay last; header row kept | ok | eb `sort_orders_numbers_text_then_blanks`; wb `sort_with_header_and_undo` |
| T5 | Autofilter: value list with counts, filtering hides rows, the column shows a filter mark | ok | wb `autofilter_hides_rows_and_reports_values`; brw "autofilter buttons report their column" |
| T6 | A file's active filter opens filtered, with the filter mark | **bug** | corpus known gap `clientes_inventario.xlsx|Clientes!@filteredCols` |
| T7 | Find: case-insensitive by default; "whole cell" and "match case" options | ok | eb `find_respects_whole_cell_and_case`; wb `find_and_replace`, `find.rs` `replaces_case_insensitively` |
| T8 | Ctrl+wheel zooms 50 %–200 % (Excel 10 %–400 %) | decision | brw "wheel scrolls, Ctrl+wheel zooms within 50%..200%" |

## 8. Display (es-ES)

| # | Excel behavior | Status | Test |
|---|---|---|---|
| D1 | Numbers, currency, percent, dates and times display like Excel es-ES (`1.234,50 €`, `12,5%`, `14/02/2025`) | ok | corpus `engine_corpus.rs` `workbook_backend_matches_corpus_expectations`; wb `number_formats_display_in_spanish`, `display.rs` `spanish_number_formats` |
| D2 | Values are rounded to 15 significant digits before formatting (times built with `TIME()` show `11:30`, not `11:29`) | **bug** | corpus known gaps (`Horario!A5…`) |
| D3 | `[$€-C0A]` currency tokens (Excel es-ES "Moneda") show `9.360,00 €` | **bug** | corpus known gaps (`Presupuesto 2025!N5…`) |
| D4 | Near-zero results snap to 0 (`718,8 - 59,9*12` shows `0,00 €`) | **bug** | corpus known gap `Presupuesto 2025!S16` |
| D5 | `[Red]` sections color negative numbers | ok | wb `number_format_patch_and_negative_red`, `display.rs` `number_format_colors` |

## 9. Files

| # | Excel behavior | Status | Test |
|---|---|---|---|
| X1 | CSV dialect detection: `;` vs `,` vs tab, decimal comma, UTF-8 (BOM), UTF-16, Windows-1252, quoted line breaks | ok / **bug** (`utf-8-bom` is outside the contract) | `corpus_files.rs` `csv_store_detects_options_and_reads_expected_cells` |
| X2 | Formula-looking text in a CSV stays text (CSV injection) | ok | corpus `columnas_mixtas.csv` |
| X3 | Saving a CSV keeps its encoding, delimiter and decimal separator | **bug** (double encoding) | rt `csv_open_edit_save_csv_reopen` (known gaps `roundtrip_csv`) |
| X4 | Saving as .xlsx keeps values, formulas, formats, merges, frozen panes, hidden rows/columns, filters, and re-inserts charts, images, comments and validation | ok | rt `xlsx_open_edit_save_reopen`, `saving_twice_is_stable` |
| X5 | Opening a file with features that will be lost warns first; a save reports what was lost | ok | `engine_corpus.rs` `open_reports_fidelity_warnings`; rt `saving_a_workbook_as_csv_reports_what_is_lost` |
| X6 | `.xls` opens (read-only) and saves as `.xlsx` | ok / **bug** (3-D refs, number formats) | rt `xls_open_edit_save_as_xlsx_reopen`; known gaps `nominas_legacy.xls|…` |

## Open gaps

- **Coverage gaps**: H9 (Ctrl+drag fill), merge & center / format painter /
  border presets through the UI (engine covered by wb
  `borders_merge_and_copy_format`), sheet-tab keyboard shortcuts
  (Ctrl+PgUp/PgDn) and the shell's command shortcuts (WS4, not on `main`
  yet). Full-app e2e (shell + grid + editor + native engine) waits for the
  Phase 3 integration; see `tests/e2e/README.md`.
- **Bugs**: every **bug** row has a failing test kept out of the default run
  (`#[ignore]` or `tests/corpus/known-gaps.json`); `cargo test -- --ignored`
  lists them, and the CI job prints them in an informational step.
