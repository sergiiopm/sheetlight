import type { Command, CommandId, CommandRegistry } from "@/model/commands";
import { shortcutMatches } from "@/model/commands";

/**
 * Keyboard shortcut helpers on top of `CommandRegistry.match`:
 * - layout-independent Excel shortcuts (Ctrl+Shift+1..7 and Ctrl+Shift+~ use
 *   the physical key, so they work on Spanish keyboards too);
 * - `+`/`-` named `Plus`/`Minus` (the registry syntax splits on `+`);
 * - extra bindings for commands with more than one shortcut (F12, Ctrl+Y…);
 * - Spanish labels for tooltips and menus ("Ctrl+Mayús+L").
 */

export interface KeyLike {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** US-layout symbols of the digit row, used by Excel's Ctrl+Shift shortcuts. */
const SHIFTED_CODES: Record<string, string> = {
  Digit1: "!",
  Digit2: "@",
  Digit3: "#",
  Digit4: "$",
  Digit5: "%",
  Digit6: "^",
  Digit7: "&",
  Digit9: "(",
  Digit0: ")",
  Backquote: "~",
  Minus: "_",
};

export function normalizeKeyEvent(event: KeyLike): KeyLike {
  const mod = event.ctrlKey || event.metaKey;
  let key = event.key;
  let shiftKey = event.shiftKey;
  if (mod && event.shiftKey && event.code && SHIFTED_CODES[event.code]) {
    key = SHIFTED_CODES[event.code];
  } else if (mod && !event.shiftKey && event.code && /^Digit\d$/.test(event.code)) {
    // Ctrl+1, Ctrl+5… regardless of what the layout prints on the key.
    key = event.code.slice(5);
  }
  if (key === "+" || event.code === "NumpadAdd") {
    key = "Plus";
    shiftKey = false;
  } else if ((key === "-" && !event.shiftKey) || event.code === "NumpadSubtract") {
    key = "Minus";
    shiftKey = false;
  } else if (key === "=" && mod && event.shiftKey) {
    // US layout: Ctrl+Shift+= is Excel's "insert" (Ctrl++).
    key = "Plus";
    shiftKey = false;
  }
  return { key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey, altKey: event.altKey };
}

/** Secondary bindings: [shortcut, command id]. */
export const SHORTCUT_ALIASES: ReadonlyArray<readonly [string, CommandId]> = [
  ["F12", "file.saveAs"],
  ["Mod+Shift+Z", "edit.redo"],
  ["F5", "edit.goTo"],
  ["Mod+F4", "file.close"],
  ["Shift+Delete", "edit.cut"],
  ["Mod+Insert", "edit.copy"],
  ["Shift+Insert", "edit.paste"],
];

export function matchCommand(registry: CommandRegistry, event: KeyLike): Command | undefined {
  const normalized = normalizeKeyEvent(event);
  const direct = registry.match(normalized);
  if (direct) return direct;
  for (const [shortcut, id] of SHORTCUT_ALIASES) {
    if (shortcutMatches(shortcut, normalized)) return registry.get(id);
  }
  return undefined;
}

const KEY_LABELS: Record<string, string> = {
  mod: "Ctrl",
  shift: "Mayús",
  alt: "Alt",
  plus: "+",
  minus: "-",
  pageup: "RePág",
  pagedown: "AvPág",
  escape: "Esc",
  delete: "Supr",
  insert: "Insert",
  space: "Espacio",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  tab: "Tab",
  enter: "Entrar",
  backspace: "Retroceso",
  home: "Inicio",
  end: "Fin",
};

/** "Mod+Shift+L" -> "Ctrl+Mayús+L". */
export function formatShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => KEY_LABELS[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part))
    .join("+");
}

/** True when keyboard input belongs to a text field (dialogs, editor, name box). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (element as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range", "color"].includes(type);
  }
  return false;
}

/**
 * Commands that also work while typing in a text field (a dialog input or
 * the formula bar): file and workbook-level actions only.
 */
export const GLOBAL_COMMANDS: ReadonlySet<CommandId> = new Set([
  "file.new",
  "file.open",
  "file.save",
  "file.saveAs",
  "file.close",
  "workbook.next",
  "workbook.previous",
]);
