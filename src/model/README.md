# src/model

Application state that sits between the UI and the engine.

Responsibilities:

- Commands (`Command` contract): every user edit is a command
- Undo / redo stacks built on commands
- Selection state (`SelectionState`): active cell, ranges, multi-selection
- Clipboard: copy/cut/paste as TSV + HTML for Excel, Google Sheets and
  LibreOffice interop, paste values
- `GridModel` contract consumed by `src/grid`
