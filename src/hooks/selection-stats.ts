import type { SelectionStats, WorkbookEngine } from "@/engine/contract";
import type { CellRange } from "@/engine/types";
import type { SelectionState } from "@/model/selection";
import { createStore, type Store } from "@/hooks/store";
import type { SessionManager } from "@/hooks/session-manager";
import type { LoadState, WorkbookSession } from "@/hooks/workbook-session";

/**
 * Status bar statistics (Excel "Promedio / Recuento / Suma") for the active
 * selection, plus the CSV loading label. The engine computes the numbers
 * (`getSelectionStats`); this module decides when to ask and how to show
 * them. Framework independent and unit-tested.
 */

/** Number of cells covered by the ranges (overlaps counted twice, like a quick estimate). */
export function selectionCellCount(ranges: ReadonlyArray<CellRange>): number {
  let total = 0;
  for (const r of ranges) total += (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1);
  return total;
}

/** Excel shows statistics only when more than one cell is selected. */
export function wantsStats(selection: SelectionState): boolean {
  return selection.ranges.length > 1 || selectionCellCount(selection.ranges) > 1;
}

const STAT_FORMAT = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 10, useGrouping: true });

/** Spanish number for the status bar ("1.234,5"); keeps up to 10 decimals like Excel's General. */
export function formatStatNumber(value: number): string {
  if (!Number.isFinite(value)) return "#¡NUM!";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) {
    return value.toExponential(5).replace(".", ",").replace(/e\+?/, "E+").replace("E+-", "E-");
  }
  return STAT_FORMAT.format(value);
}

export interface StatItem {
  readonly id: "average" | "count" | "numericCount" | "min" | "max" | "sum";
  readonly label: string;
  readonly value: string;
}

/**
 * Items in Excel's order. With numbers: Promedio, Recuento, Suma; with text
 * only: Recuento. Nothing for an all-empty selection.
 */
export function statItems(stats: SelectionStats | null): StatItem[] {
  if (!stats || stats.count === 0) return [];
  const items: StatItem[] = [];
  if (stats.numericCount > 0 && stats.average !== null) {
    items.push({ id: "average", label: "Promedio", value: formatStatNumber(stats.average) });
  }
  items.push({ id: "count", label: "Recuento", value: stats.count.toLocaleString("es-ES") });
  if (stats.numericCount > 0) items.push({ id: "sum", label: "Suma", value: formatStatNumber(stats.sum) });
  return items;
}

/** Plain-text summary for clipboard / tooltip: "Promedio: 2 · Recuento: 3 · Suma: 6". */
export function statSummary(stats: SelectionStats | null): string {
  return statItems(stats)
    .map((item) => `${item.label}: ${item.value}`)
    .join(" · ");
}

/** "Cargando… 120.000 filas (35 %)" while a CSV streams in; error text when it failed. */
export function loadLabel(load: LoadState | null): string | null {
  if (!load) return null;
  if (load.error) return `Error al cargar: ${load.error}`;
  if (load.done) return null;
  const rows = `${load.rowsLoaded.toLocaleString("es-ES")} ${load.rowsLoaded === 1 ? "fila" : "filas"}`;
  const percent = loadPercent(load);
  return percent === null ? `Cargando… ${rows}` : `Cargando… ${rows} (${percent} %)`;
}

/** 0..100, or null when the total size is unknown. */
export function loadPercent(load: LoadState | null): number | null {
  if (!load || load.bytesTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((load.bytesRead / load.bytesTotal) * 100)));
}

/**
 * Follows the active session's selection and data changes and asks the
 * engine for statistics after a short debounce (selecting a whole column of a
 * 1M-row sheet must not flood the engine). Late answers are dropped.
 */
export class SelectionStatsTracker {
  readonly stats: Store<SelectionStats | null> = createStore<SelectionStats | null>(null);

  private timer: ReturnType<typeof setTimeout> | null = null;
  private token = 0;
  private bound: WorkbookSession | null = null;
  private unbind: (() => void) | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly engine: WorkbookEngine,
    private readonly manager: SessionManager,
    private readonly delayMs = 120,
  ) {
    this.unsubscribe = manager.state.subscribe(() => this.bind());
    this.bind();
  }

  dispose(): void {
    this.unsubscribe();
    this.unbind?.();
    if (this.timer) clearTimeout(this.timer);
  }

  private bind(): void {
    const session = this.manager.active;
    if (session === this.bound) return;
    this.unbind?.();
    this.bound = session;
    this.stats.set(null);
    if (!session) {
      this.unbind = null;
      return;
    }
    const unsubs = [
      session.selection.subscribe(() => this.schedule()),
      session.dataEvents.subscribe((event) => {
        if (event.type === "cells" || event.type === "sheetData" || event.type === "structure") {
          if (event.sheet === session.activeSheet) this.schedule();
        } else if (event.type === "loadProgress") {
          this.schedule();
        }
      }),
    ];
    this.unbind = () => unsubs.forEach((unsub) => unsub());
    this.schedule();
  }

  /** Recomputes after the debounce. */
  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, this.delayMs);
  }

  async refresh(): Promise<void> {
    const session = this.bound;
    const token = ++this.token;
    if (!session) return;
    const selection = session.selection.get();
    if (!wantsStats(selection)) {
      this.stats.set(null);
      return;
    }
    try {
      const stats = await this.engine.getSelectionStats(session.doc, selection.sheet, selection.ranges);
      if (token === this.token && this.bound === session) this.stats.set(stats);
    } catch {
      if (token === this.token) this.stats.set(null);
    }
  }
}
