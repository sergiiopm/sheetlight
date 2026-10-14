/**
 * Public surface of the editor (WS7). Other modules import only from here.
 *
 * Mounting (shell, one per open document):
 *
 * ```tsx
 * // Keep the handle in state (callback ref) so the overlay re-renders when it mounts.
 * const [grid, setGrid] = useState<GridHandle | null>(null);
 * const gridRef = useRef(grid); gridRef.current = grid;
 * const session = useEditSession({
 *   engine, doc, selection,                  // the document's WorkbookSession
 *   getGrid: () => gridRef.current,
 *   getSheets: () => sheets,                 // SheetMeta[] (sheet-qualified refs, name box)
 *   onNavigateSheet: (sheet, range) => switchSheetAndSelect(sheet, range),
 *   // One undo step. Do NOT apply ApplyResult.selection: the session already
 *   // moved the selection. Reject with EngineError to reopen the editor with
 *   // the (Spanish) message.
 *   onCommit: (ops) => engine.apply(doc, ops),
 * });
 *
 * <FormulaBar session={session} />           // name box + ✕ ✓ fx + bar editor
 * <SpreadsheetGrid ref={setGrid} ... onEditRequest={session.start} />
 * <CellEditor session={session} grid={grid} />  // portal overlay
 * ```
 *
 * The session pushes reference highlights and the reference picker to the
 * grid (`GridHandle.setRefHighlights` / `setReferencePicker`) and positions
 * the in-cell editor with `GridHandle.getCellRect`. Shell commands that must
 * not run while editing (undo, paste…) can check `session.isEditing()`.
 * Keys typed in the editor never bubble to global shortcuts.
 */
export { CellEditor, DEFAULT_CELL_FONT_FAMILY, DEFAULT_CELL_FONT_SIZE_PT, type CellEditorProps } from "@/editor/CellEditor";
export { FormulaBar, type FormulaBarProps } from "@/editor/FormulaBar";
export { NameBox, type NameBoxProps } from "@/editor/NameBox";
export {
  EditSession,
  MAX_FILL_CELLS,
  NAME_BOX_ERROR,
  createEditSession,
  fillCellCount,
  type CommitMove,
  type CompletionState,
  type EditKeyEvent,
  type EditMode,
  type EditSessionOptions,
  type EditState,
  type EditSurface,
  type SignatureState,
} from "@/editor/session";
export { useActiveCellDetails, useEditSession, useEditState } from "@/editor/use-edit-session";
export { FUNCTIONS, CATEGORY_LABELS, formatSignature, getFunctionInfo, type FunctionCategory, type FunctionInfo } from "@/editor/functions";
export { REF_COLORS } from "@/editor/ref-colors";

/** Spanish status-bar label of an edit mode (Excel: "Listo / Introducir / Modificar / Señalar"). */
export function editModeLabel(status: "idle" | "editing", mode: "enter" | "edit" | "point"): string {
  if (status === "idle") return "Listo";
  return mode === "edit" ? "Modificar" : mode === "point" ? "Señalar" : "Introducir";
}
