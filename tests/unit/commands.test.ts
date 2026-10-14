import { describe, expect, it } from "vitest";
import { CommandRegistry, shortcutMatches } from "@/model/commands";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}) => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("command registry", () => {
  it("matches shortcuts with exact modifiers", () => {
    expect(shortcutMatches("Mod+B", key("b", { ctrlKey: true }))).toBe(true);
    expect(shortcutMatches("Mod+B", key("b", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(shortcutMatches("Mod+Shift+Z", key("Z", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(shortcutMatches("Shift+Space", key(" ", { shiftKey: true }))).toBe(true);
    expect(shortcutMatches("F2", key("F2"))).toBe(true);
  });

  it("runs enabled commands and skips disabled ones", async () => {
    const registry = new CommandRegistry();
    let runs = 0;
    let enabled = true;
    registry.register({ id: "x.run", label: "Ejecutar", shortcut: "Mod+K", isEnabled: () => enabled, run: () => void (runs += 1) });
    expect(registry.match(key("k", { ctrlKey: true }))?.id).toBe("x.run");
    expect(await registry.run("x.run")).toBe(true);
    enabled = false;
    expect(await registry.run("x.run")).toBe(false);
    expect(runs).toBe(1);
  });
});
