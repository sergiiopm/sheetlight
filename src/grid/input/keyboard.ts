import type { Direction } from "@/engine/types";
import type { SheetGeometry } from "../geometry/SheetGeometry";
import { focusOf } from "../selection/selection";
import type { GridInteractions } from "./GridInteractions";
import type { SelectionState } from "@/model/selection";

const ARROWS: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

const MODIFIERS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock"]);

export interface KeyboardContext {
  readonly geom: SheetGeometry;
  readonly actions: GridInteractions;
  selection(): SelectionState;
  /** Scroll the active cell into view (Ctrl+Backspace). */
  revealActive(): void;
  /** Open the context menu at the active cell (Shift+F10 / menu key). */
  contextMenuAtActive(): void;
}

/** What the grid does with a key. `edit` keys are handled but the default action is kept for IME. */
export type KeyResult = "handled" | "unhandled" | "ime";

/** A key that types a character (not a shortcut). AltGr arrives as Ctrl+Alt on Windows. */
export function isTypingKey(e: KeyboardEvent): boolean {
  if ([...e.key].length !== 1) return false; // one code point (named keys like "Shift" are longer)
  if (e.metaKey) return false;
  const altGr = e.ctrlKey && e.altKey;
  if ((e.ctrlKey || e.altKey) && !altGr) return false;
  return true;
}

/**
 * Excel keyboard behavior of the grid. Returns what happened so the caller
 * can preventDefault (handled) or forward the event (`onUnhandledKey`).
 */
export function handleKeyDown(k: KeyboardContext, e: KeyboardEvent): KeyResult {
  const g = k.actions;
  const ctrl = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;
  if (e.isComposing || e.key === "Process") {
    g.requestEdit("type");
    return "ime";
  }
  // Excel "End mode": End, then an arrow, behaves like Ctrl+arrow (End, Home = Ctrl+End).
  const endMode = g.endMode;
  if (!MODIFIERS.has(e.key)) g.endMode = false;
  const dir = ARROWS[e.key];
  if (dir) {
    if (e.altKey) return "unhandled";
    if (ctrl || endMode) void g.jumpToEdge(dir, shift);
    else g.moveSelection(dir, shift);
    return "handled";
  }
  switch (e.key) {
    case "PageDown":
      if (ctrl) return "unhandled"; // next sheet (shell)
      g.page(e.altKey ? "right" : "down", shift);
      return "handled";
    case "PageUp":
      if (ctrl) return "unhandled";
      g.page(e.altKey ? "left" : "up", shift);
      return "handled";
    case "Home": {
      const { geom } = k;
      if (endMode && !ctrl) {
        g.goTo(g.lastUsedCell(), shift);
        return "handled";
      }
      if (ctrl) g.goTo({ row: geom.frozenRows, col: geom.frozenCols }, shift);
      else g.goTo({ row: (shift ? focusOf(k.selection()) : k.selection().active).row, col: geom.frozenCols }, shift);
      return "handled";
    }
    case "End":
      if (ctrl) {
        g.goTo(g.lastUsedCell(), shift);
        return "handled";
      }
      if (e.altKey) return "unhandled";
      g.endMode = !endMode;
      return "handled";
    case "Tab":
      if (ctrl || e.altKey) return "unhandled";
      g.advance(true, shift);
      return "handled";
    case "Enter":
      if (ctrl || e.altKey) return "unhandled";
      g.advance(false, shift);
      return "handled";
    case " ":
      if (ctrl && shift) g.selectAll();
      else if (ctrl) g.selectColumnsOfActive();
      else if (shift) g.selectRowsOfActive();
      else {
        g.requestEdit("type", " ");
      }
      return "handled";
    case "a":
    case "A":
      if (ctrl && !e.altKey) {
        g.selectAll();
        return "handled";
      }
      break;
    case "F2":
      if (ctrl || e.altKey || shift) return "unhandled";
      g.requestEdit("f2");
      return "handled";
    case "F10":
      if (shift && !ctrl) {
        k.contextMenuAtActive();
        return "handled";
      }
      return "unhandled";
    case "ContextMenu":
      k.contextMenuAtActive();
      return "handled";
    case "Delete":
      if (ctrl || e.altKey || shift) return "unhandled";
      g.clearContents();
      return "handled";
    case "Backspace":
      if (ctrl) {
        k.revealActive();
        return "handled";
      }
      if (e.altKey) return "unhandled";
      g.requestEdit("backspace");
      return "handled";
    default:
      break;
  }
  if (isTypingKey(e)) {
    g.requestEdit("type", e.key);
    return "handled";
  }
  return "unhandled";
}
