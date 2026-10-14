import type { ApplyResult, ClearWhat, HAlign, StylePatch, VAlign } from "@/engine/contract";
import { rangeContains } from "@/engine/types";
import { adjustDecimals, displayDecimals } from "@/lib/number-formats";
import type { AppController, BorderChoice } from "@/hooks/app-controller";
import { bordersOp, clearOp, mergeOps, nextFontSize, styleOp, unmergeOp } from "@/hooks/selection-ops";

/** Formatting actions on the active selection. Toggle states come from the active cell. */

function currentStyle(c: AppController) {
  return c.activeCell.get()?.format.style ?? {};
}

export function setStyle(c: AppController, patch: StylePatch): Promise<ApplyResult | null> {
  const selection = c.selection;
  if (!selection) return Promise.resolve(null);
  return c.apply([styleOp(selection, patch)]);
}

export function toggleStyle(c: AppController, field: "bold" | "italic" | "strike" | "wrap"): Promise<ApplyResult | null> {
  const active = currentStyle(c)[field] === true;
  return setStyle(c, { [field]: !active });
}

export function toggleUnderline(c: AppController, kind: true | "double" = true): Promise<ApplyResult | null> {
  const current = currentStyle(c).underline;
  return setStyle(c, { underline: current === kind ? false : kind });
}

export function setNumFmt(c: AppController, code: string): Promise<ApplyResult | null> {
  return setStyle(c, { numFmt: code });
}

export function stepDecimals(c: AppController, delta: 1 | -1): Promise<ApplyResult | null> {
  const cell = c.activeCell.get();
  const code = cell?.format.numFmt ?? "General";
  const decimals = displayDecimals(cell?.display ?? "");
  return setNumFmt(c, adjustDecimals(code, delta, decimals));
}

export function stepFontSize(c: AppController, direction: 1 | -1): Promise<ApplyResult | null> {
  const size = currentStyle(c).fontSize ?? c.settings.get().defaultFont.size;
  return setStyle(c, { fontSize: nextFontSize(size, direction) });
}

export function setBorders(c: AppController, choice: BorderChoice): Promise<ApplyResult | null> {
  const selection = c.selection;
  if (!selection) return Promise.resolve(null);
  c.lastBorder.set(choice);
  return c.apply([bordersOp(selection, choice.preset, choice.style, choice.color)]);
}

/** Clicking the active alignment again returns to "general" (Excel). */
export function toggleHAlign(c: AppController, align: HAlign): Promise<ApplyResult | null> {
  const current = currentStyle(c).hAlign;
  return setStyle(c, { hAlign: current === align ? null : align });
}

export function toggleVAlign(c: AppController, align: VAlign): Promise<ApplyResult | null> {
  const current = currentStyle(c).vAlign ?? "bottom";
  return setStyle(c, { vAlign: current === align && align !== "bottom" ? null : align });
}

export function stepIndent(c: AppController, delta: 1 | -1): Promise<ApplyResult | null> {
  const style = currentStyle(c);
  const indent = Math.max(0, Math.min(15, (style.indent ?? 0) + delta));
  const patch: StylePatch = { indent };
  // Indenting general/centered text aligns it left like Excel.
  if (delta > 0 && (!style.hAlign || style.hAlign === "general" || style.hAlign === "center")) {
    return setStyle(c, { ...patch, hAlign: "left" });
  }
  return setStyle(c, patch);
}

/** True when the active cell is inside a merged range. */
export function activeIsMerged(c: AppController): boolean {
  const cell = c.activeCell.get();
  const selection = c.selection;
  return Boolean(cell?.merge && selection && rangeContains(cell.merge, selection.active.row, selection.active.col));
}

export function merge(c: AppController, mode: "merge" | "mergeCenter" | "mergeAcross"): Promise<ApplyResult | null> {
  const selection = c.selection;
  if (!selection) return Promise.resolve(null);
  const ops = mergeOps(selection, mode);
  if (ops.length === 0) {
    c.notify("Selecciona más de una celda para combinar.", "info");
    return Promise.resolve(null);
  }
  return c.apply(ops);
}

export function unmerge(c: AppController): Promise<ApplyResult | null> {
  const selection = c.selection;
  if (!selection) return Promise.resolve(null);
  return c.apply([unmergeOp(selection)]);
}

/** "Combinar y centrar" button: toggles like Excel. */
export function toggleMergeCenter(c: AppController): Promise<ApplyResult | null> {
  return activeIsMerged(c) ? unmerge(c) : merge(c, "mergeCenter");
}

export function clear(c: AppController, what: ClearWhat): Promise<ApplyResult | null> {
  const selection = c.selection;
  if (!selection) return Promise.resolve(null);
  return c.apply([clearOp(selection, what)]);
}

