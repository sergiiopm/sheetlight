import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  MAX_RECENT_FILES,
  createSettingsStore,
  loadSettings,
  parseSettings,
  withRecentFile,
  type SettingsStorage,
} from "@/lib/settings";
import { resolveTheme } from "@/lib/theme";

function storage(initial: Record<string, string> = {}): SettingsStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("settings", () => {
  it("returns defaults for empty or corrupt storage", () => {
    expect(loadSettings(storage())).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(storage({ "sheetlight-settings": "{not json" }))).toEqual(DEFAULT_SETTINGS);
  });

  it("validates every field", () => {
    const parsed = parseSettings({
      theme: "purple",
      recentFiles: ["C:\\a.xlsx", 3, ""],
      defaultFont: { family: "  Arial ", size: 400 },
      csv: { delimiter: ";", encoding: "latin9", decimal: ",", saveDelimiter: "x" },
    });
    expect(parsed.theme).toBe("system");
    expect(parsed.recentFiles).toEqual(["C:\\a.xlsx"]);
    expect(parsed.defaultFont).toEqual({ family: "Arial", size: 11 });
    expect(parsed.csv).toEqual({ delimiter: ";", encoding: null, decimal: ",", saveDelimiter: ";" });
  });

  it("migrates the scaffold theme key", () => {
    expect(loadSettings(storage({ "sheetlight-theme": "dark" })).theme).toBe("dark");
  });

  it("persists updates and notifies", () => {
    const backing = storage();
    const store = createSettingsStore(backing);
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.update({ theme: "dark" });
    store.addRecentFile("C:\\Datos\\Libro.xlsx");
    expect(calls).toBe(2);
    const reloaded = createSettingsStore(backing).get();
    expect(reloaded.theme).toBe("dark");
    expect(reloaded.recentFiles).toEqual(["C:\\Datos\\Libro.xlsx"]);
    store.removeRecentFile("c:/datos/libro.XLSX");
    expect(store.get().recentFiles).toEqual([]);
  });

  it("keeps recent files unique, newest first and bounded", () => {
    let list: string[] = [];
    for (let i = 0; i < MAX_RECENT_FILES + 3; i += 1) list = withRecentFile(list, `C:\\f${i}.xlsx`);
    expect(list).toHaveLength(MAX_RECENT_FILES);
    expect(list[0]).toBe(`C:\\f${MAX_RECENT_FILES + 2}.xlsx`);
    list = withRecentFile(list, "c:\\F5.XLSX");
    expect(list[0]).toBe("c:\\F5.XLSX");
    expect(list.filter((p) => p.toLowerCase() === "c:\\f5.xlsx")).toHaveLength(1);
  });

  it("resolves the system theme", () => {
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("light", "dark")).toBe("light");
  });
});
