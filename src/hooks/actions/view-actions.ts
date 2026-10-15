import type { SheetInfo } from "@/engine/contract";
import type { AppController } from "@/hooks/app-controller";
import { freezeAt } from "@/hooks/selection-ops";

/** View actions: freeze panes, grid lines, zoom. */

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const ZOOM_PRESETS: ReadonlyArray<number> = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];

export function clampZoom(zoom: number): number {
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) * 100) / 100;
}

async function info(c: AppController): Promise<SheetInfo | null> {
  const session = c.session;
  if (!session) return null;
  return c.engine.getSheetInfo(session.doc, session.activeSheet).catch(() => null);
}

export function isFrozen(sheet: SheetInfo | null): boolean {
  return Boolean(sheet && (sheet.frozenRows > 0 || sheet.frozenCols > 0));
}

/** "Inmovilizar paneles" / "Movilizar paneles" toggle at the active cell. */
export async function toggleFreezePanes(c: AppController): Promise<void> {
  const s = c.selection;
  if (!s) return;
  if (isFrozen(await info(c))) {
    await c.apply([{ type: "setFrozen", sheet: s.sheet, rows: 0, cols: 0 }]);
    return;
  }
  const { rows, cols } = freezeAt(s.active);
  if (rows === 0 && cols === 0) {
    c.notify("Selecciona la celda situada debajo y a la derecha de lo que quieres inmovilizar.", "info");
    return;
  }
  await c.apply([{ type: "setFrozen", sheet: s.sheet, rows, cols }]);
}

export async function freeze(c: AppController, rows: number, cols: number): Promise<void> {
  const s = c.selection;
  if (s) await c.apply([{ type: "setFrozen", sheet: s.sheet, rows, cols }]);
}

export async function toggleGridLines(c: AppController): Promise<void> {
  const s = c.selection;
  const sheet = await info(c);
  if (s && sheet) await c.apply([{ type: "setShowGridLines", sheet: s.sheet, show: !sheet.showGridLines }]);
}

export function setZoom(c: AppController, zoom: number): void {
  const session = c.session;
  if (!session) return;
  const next = clampZoom(zoom);
  session.grid?.setZoom(next);
  const view = session.grid?.getViewport() ?? session.viewFor(session.activeSheet);
  session.setViewport({ ...view, zoom: next });
}

export function stepZoom(c: AppController, direction: 1 | -1): void {
  const session = c.session;
  if (!session) return;
  const current = session.zoom.get();
  const next = direction > 0 ? ZOOM_PRESETS.find((z) => z > current + 1e-6) : [...ZOOM_PRESETS].reverse().find((z) => z < current - 1e-6);
  setZoom(c, next ?? current);
}
