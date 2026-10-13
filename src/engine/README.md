# src/engine

Formula engine behind the `WorkbookEngine` TypeScript contract.

Responsibilities:

- `WorkbookEngine` contract: cell values and formulas, sheets, recalculation,
  dependency tracking, import/export of workbook data
- Adapter for the chosen engine (IronCalc, under evaluation in Phase 0),
  running in a Web Worker (WASM) or natively in `src-tauri`
- Fallback implementation if IronCalc is rejected (own parser + dependency
  graph + `formulajs`)

The rest of the app depends only on the contract, so the engine is swappable.
