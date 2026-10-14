# src/editor

Cell and formula editing (WS7). Public API: `src/editor/index.ts` (mounting
example in its header comment). Tests: `tests/editor/` (plus
`src/lib/locale.test.ts` for value parsing).

Formula syntax is always English (en-US): `=SUM(A1:A5,2)`, `,` as argument
separator and `.` as decimal separator inside formulas. Values are typed and
shown in the user's locale (es-ES: `1.234,5`, `14/02/2025`, `12,5 %`) via
`src/lib/locale.ts` (`parseUserInput` on commit, `toEditText` on F2).

## Files

| File | Responsibility |
| --- | --- |
| `session.ts` | `EditSession`: framework-free edit state machine (Introducir / Modificar / Señalar), commit/cancel, Ctrl+Enter fill, Enter/Tab movement, reference picking, F4, name box navigation, undo inside the editor, grid sync (`setRefHighlights`, `setReferencePicker`) |
| `use-edit-session.ts` | React glue: `useEditSession` (one session per document), `useEditState`, `useActiveCellDetails`, text measurement |
| `CellEditor.tsx` | In-cell overlay positioned with `GridHandle.getCellRect`, matching font/alignment/zoom; grows with the text; follows scroll/zoom |
| `FormulaBar.tsx` | Name box, ✕ / ✓ / fx buttons, the bar view of the same session, expand toggle |
| `NameBox.tsx` | Shows the active cell; Enter goes to `B7`, `A1:C10`, `A:C`, `3:5`, `Hoja2!A1` |
| `EditorTextarea.tsx` | Textarea bound to the session (shared by both views); colored refs via a mirror layer; IME-safe |
| `EditorPopups.tsx` | Function autocomplete list, signature help, formula error dialog |
| `tokenizer.ts` | Formula tokenizer (refs, sheet-qualified refs, strings, operators…) |
| `references.ts` | Ref formatting, relative shifting, F4 cycling, "can a ref go here", auto-close and validation |
| `autocomplete.ts` | Completion context, function filtering (en-US and Spanish names), signature context, value AutoComplete |
| `functions.ts` | Function catalog (~220 functions, Spanish descriptions and argument help) |
| `ref-colors.ts` | Excel-like reference palette and grid highlights |
| `details-cache.ts` | Small LRU of `CellDetails` invalidated by engine events |
| `moves.ts` | Active-cell movement after commit (also inside multi-cell selections) |

## Keys (while editing)

Enter / Shift+Enter commit and move down/up (walking a multi-cell selection);
Tab / Shift+Tab right/left (Enter after a Tab run returns to the first column);
Esc cancels; Alt+Enter inserts a line break (cell gets wrap); Ctrl+Enter fills
the selection (formulas shifted relatively); F2 toggles Introducir/Modificar;
arrows commit in Introducir mode or pick references where one can go;
Shift+arrows extend the picked range; F4 cycles `$`; Ctrl+Z / Ctrl+Y undo
inside the editor. With the function list open: ↑/↓, Tab/Enter accept, Esc
closes it.
