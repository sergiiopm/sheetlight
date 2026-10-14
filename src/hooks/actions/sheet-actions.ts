import type { SheetId } from "@/engine/types";
import type { AppController } from "@/hooks/app-controller";
import { freeSheetName, sheetNameError } from "@/hooks/selection-ops";

/** Sheet tab actions: add, rename, delete, duplicate, move, hide, color, switch. */

export async function activateSheet(c: AppController, sheet: SheetId): Promise<void> {
  const session = c.session;
  if (!session) return;
  await c.manager.setActiveSheet(session, sheet);
  c.focusGrid();
}

/** Ctrl+PgUp / Ctrl+PgDn over visible sheets (no wrap, like Excel). */
export async function cycleSheet(c: AppController, step: 1 | -1): Promise<void> {
  const session = c.session;
  if (!session) return;
  const visible = session.info.sheets.filter((s) => !s.hidden);
  const index = visible.findIndex((s) => s.id === session.activeSheet);
  const next = visible[index + step];
  if (next) await activateSheet(c, next.id);
}

/** Shift+F11 / "+" button: new sheet after the active one, then show it. */
export async function addSheet(c: AppController): Promise<void> {
  const session = c.session;
  if (!session) return;
  const { sheets } = session.info;
  const index = sheets.findIndex((s) => s.id === session.activeSheet) + 1;
  const result = await c.apply([{ type: "addSheet", name: freeSheetName(sheets), index }]);
  const created = result?.created[0];
  if (created !== undefined) await activateSheet(c, created);
}

export async function renameSheet(c: AppController, sheet: SheetId, name: string): Promise<boolean> {
  const session = c.session;
  if (!session) return false;
  const current = session.info.sheets.find((s) => s.id === sheet);
  if (!current || current.name === name.trim()) return true;
  const error = sheetNameError(name, session.info.sheets, sheet);
  if (error) {
    c.notify(error, "error");
    return false;
  }
  return (await c.apply([{ type: "renameSheet", sheet, name: name.trim() }])) !== null;
}

/** Asks first (Excel: "Se eliminará permanentemente…"). */
export function requestDeleteSheet(c: AppController, sheet: SheetId): void {
  const session = c.session;
  if (!session) return;
  if (session.info.sheets.filter((s) => !s.hidden).length <= 1) {
    c.notify("Un libro debe contener al menos una hoja visible.", "error");
    return;
  }
  c.openDialog({ kind: "deleteSheet", sheet });
}

export async function deleteSheet(c: AppController, sheet: SheetId): Promise<void> {
  await c.apply([{ type: "deleteSheet", sheet }]);
}

export async function duplicateSheet(c: AppController, sheet: SheetId): Promise<void> {
  const result = await c.apply([{ type: "duplicateSheet", sheet }]);
  const created = result?.created[0];
  if (created !== undefined) await activateSheet(c, created);
}

export async function moveSheet(c: AppController, sheet: SheetId, index: number): Promise<void> {
  const session = c.session;
  if (!session) return;
  const from = session.info.sheets.findIndex((s) => s.id === sheet);
  if (from === -1 || from === index) return;
  await c.apply([{ type: "moveSheet", sheet, index }]);
}

export async function setSheetHidden(c: AppController, sheet: SheetId, hidden: boolean): Promise<void> {
  const session = c.session;
  if (!session) return;
  const visible = session.info.sheets.filter((s) => !s.hidden);
  if (hidden && visible.length <= 1) {
    c.notify("Un libro debe contener al menos una hoja visible.", "error");
    return;
  }
  if (hidden && sheet === session.activeSheet) {
    const index = visible.findIndex((s) => s.id === sheet);
    const next = visible[index + 1] ?? visible[index - 1];
    if (next) await activateSheet(c, next.id);
  }
  const result = await c.apply([{ type: "setSheetHidden", sheet, hidden }]);
  if (result && !hidden) await activateSheet(c, sheet);
}

export async function setSheetColor(c: AppController, sheet: SheetId, color: string | null): Promise<void> {
  await c.apply([{ type: "setSheetColor", sheet, color }]);
}
