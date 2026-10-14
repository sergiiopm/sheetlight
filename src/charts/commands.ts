import type { WorkbookEngine } from "@/engine/contract";
import type { CellAddress, CellRange, DocumentId, SheetId } from "@/engine/types";
import type { CommandRegistry } from "@/model/commands";
import type { SelectionStore } from "@/model/selection";

/** What the shell knows about the active document when a chart command runs. */
export interface ChartCommandContext {
  readonly engine: WorkbookEngine;
  readonly doc: DocumentId;
  readonly sheet: SheetId;
  readonly selection: SelectionStore;
  readonly readOnly?: boolean;
}

/** "Insert chart" request sent from a command to the `ChartLayer` of a document. */
export interface ChartInsertRequest {
  readonly doc: DocumentId;
  readonly sheet: SheetId;
  readonly ranges: ReadonlyArray<CellRange>;
  readonly active: CellAddress;
}

type InsertListener = (request: ChartInsertRequest) => void;
const insertListeners = new Map<DocumentId, Set<InsertListener>>();

/** Used by `ChartLayer`: receives insert requests for its document. */
export function onChartInsertRequest(doc: DocumentId, listener: InsertListener): () => void {
  let set = insertListeners.get(doc);
  if (!set) {
    set = new Set();
    insertListeners.set(doc, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) insertListeners.delete(doc);
  };
}

/** Asks the chart layer of `request.doc` to open the insert dialog. False if none is mounted. */
export function requestChartInsert(request: ChartInsertRequest): boolean {
  const set = insertListeners.get(request.doc);
  if (!set || set.size === 0) return false;
  for (const listener of set) listener(request);
  return true;
}

export const CHART_INSERT_COMMAND = "chart.insert";

/**
 * Registers chart commands (`chart.insert`, "Insertar gráfico"). The command
 * opens the create-chart dialog of the mounted `ChartLayer` with the current
 * selection. Returns the unregister function.
 */
export function registerChartCommands(
  registry: CommandRegistry,
  getContext: () => ChartCommandContext | null,
): () => void {
  return registry.register({
    id: CHART_INSERT_COMMAND,
    label: "Insertar gráfico",
    group: "Insertar",
    isEnabled: () => {
      const ctx = getContext();
      return !!ctx && !ctx.readOnly;
    },
    run: () => {
      const ctx = getContext();
      if (!ctx || ctx.readOnly) return;
      const sel = ctx.selection.get();
      requestChartInsert({ doc: ctx.doc, sheet: ctx.sheet, ranges: sel.ranges, active: sel.active });
    },
  });
}
