import { describe, expect, it } from "vitest";
import { CommandRegistry } from "@/model/commands";
import { formatShortcut, isEditableTarget, matchCommand, normalizeKeyEvent, type KeyLike } from "@/hooks/shortcuts";

function key(k: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods };
}

function registry(): CommandRegistry {
  const reg = new CommandRegistry();
  const ids: Array<[string, string]> = [
    ["file.saveAs", "Mod+Shift+S"],
    ["edit.redo", "Mod+Y"],
    ["format.numFmt.currency", "Mod+Shift+$"],
    ["format.numFmt.shortDate", "Mod+Shift+#"],
    ["format.cells", "Mod+1"],
    ["insert.smart", "Mod+Plus"],
    ["delete.smart", "Mod+Minus"],
    ["format.borders.none", "Mod+Shift+_"],
    ["sheet.next", "Mod+PageDown"],
    ["sheet.new", "Shift+F11"],
    ["edit.goTo", "Mod+G"],
  ];
  reg.register(...ids.map(([id, shortcut]) => ({ id, label: id, shortcut, run: () => undefined })));
  return reg;
}

describe("shortcut matching", () => {
  const reg = registry();
  const match = (event: KeyLike) => matchCommand(reg, event)?.id;

  it("matches plain registry shortcuts", () => {
    expect(match(key("S", { ctrlKey: true, shiftKey: true }))).toBe("file.saveAs");
    expect(match(key("PageDown", { ctrlKey: true }))).toBe("sheet.next");
    expect(match(key("F11", { shiftKey: true }))).toBe("sheet.new");
  });

  it("matches aliases", () => {
    expect(match(key("F12"))).toBe("file.saveAs");
    expect(match(key("z", { ctrlKey: true, shiftKey: true }))).toBe("edit.redo");
    expect(match(key("F5"))).toBe("edit.goTo");
  });

  it("uses the physical digit row for Ctrl+Shift shortcuts on any layout", () => {
    // Spanish layout: Shift+3 prints "·", Shift+4 prints "$".
    expect(match(key("·", { code: "Digit3", ctrlKey: true, shiftKey: true }))).toBe("format.numFmt.shortDate");
    expect(match(key("$", { code: "Digit4", ctrlKey: true, shiftKey: true }))).toBe("format.numFmt.currency");
    expect(match(key("!", { code: "Digit1", ctrlKey: true }))).toBe("format.cells");
  });

  it("handles Ctrl++ and Ctrl+- on every keyboard", () => {
    expect(match(key("+", { code: "BracketRight", ctrlKey: true }))).toBe("insert.smart");
    expect(match(key("+", { code: "Equal", ctrlKey: true, shiftKey: true }))).toBe("insert.smart");
    expect(match(key("+", { code: "NumpadAdd", ctrlKey: true }))).toBe("insert.smart");
    expect(match(key("=", { code: "Equal", ctrlKey: true, shiftKey: true }))).toBe("insert.smart");
    expect(match(key("-", { code: "Slash", ctrlKey: true }))).toBe("delete.smart");
    expect(match(key("_", { code: "Minus", ctrlKey: true, shiftKey: true }))).toBe("format.borders.none");
  });

  it("does not match without the modifiers", () => {
    expect(match(key("g"))).toBeUndefined();
    expect(match(key("g", { ctrlKey: true, altKey: true }))).toBeUndefined();
  });

  it("normalizes keys without changing unrelated events", () => {
    expect(normalizeKeyEvent(key("a", { ctrlKey: true }))).toMatchObject({ key: "a", ctrlKey: true, shiftKey: false });
  });
});

describe("shortcut labels", () => {
  it("formats Spanish Windows labels", () => {
    expect(formatShortcut("Mod+Shift+L")).toBe("Ctrl+Mayús+L");
    expect(formatShortcut("Mod+Plus")).toBe("Ctrl++");
    expect(formatShortcut("Mod+PageDown")).toBe("Ctrl+AvPág");
    expect(formatShortcut("Shift+F11")).toBe("Mayús+F11");
    expect(formatShortcut("Mod+Alt+v")).toBe("Ctrl+Alt+V");
  });

  it("detects editable targets", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({ tagName: "INPUT", type: "text", isContentEditable: false } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "INPUT", type: "checkbox", isContentEditable: false } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "CANVAS", isContentEditable: false } as unknown as EventTarget)).toBe(false);
  });
});
