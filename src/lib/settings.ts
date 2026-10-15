import type { CsvOptions } from "@/engine/contract";

/**
 * User settings persisted in localStorage: theme, recent files, default font
 * and CSV defaults. Framework independent; React reads it through
 * `useSettings()` (src/hooks/use-settings.ts).
 */

export type ThemePreference = "light" | "dark" | "system";

export interface CsvDefaults {
  /** null = auto-detect when opening. */
  readonly delimiter: CsvOptions["delimiter"];
  readonly encoding: CsvOptions["encoding"];
  readonly decimal: CsvOptions["decimal"];
  /** Delimiter used when saving as CSV (Excel ES uses ";"). */
  readonly saveDelimiter: NonNullable<CsvOptions["delimiter"]>;
}

export interface AppSettings {
  readonly theme: ThemePreference;
  readonly recentFiles: ReadonlyArray<string>;
  readonly defaultFont: { readonly family: string; readonly size: number };
  readonly csv: CsvDefaults;
}

export const MAX_RECENT_FILES = 12;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  recentFiles: [],
  defaultFont: { family: "Calibri", size: 11 },
  csv: { delimiter: null, encoding: null, decimal: null, saveDelimiter: ";" },
};

const STORAGE_KEY = "sheetlight-settings";
/** Pre-settings key used by the scaffold's theme toggle. */
const LEGACY_THEME_KEY = "sheetlight-theme";

export type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

function memoryStorage(): SettingsStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

function defaultStorage(): SettingsStorage {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // Access denied (privacy mode): fall back to memory.
  }
  return memoryStorage();
}

const DELIMITERS = new Set([",", ";", "\t", "|"]);
const ENCODINGS = new Set(["utf-8", "utf-16le", "windows-1252"]);

function pick<T>(value: unknown, allowed: Set<unknown>, fallback: T): T {
  return allowed.has(value) ? (value as T) : fallback;
}

/** Validates untrusted JSON into settings, field by field. */
export function parseSettings(raw: unknown, legacyTheme?: string | null): AppSettings {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const theme = pick<ThemePreference>(data.theme ?? legacyTheme, new Set(["light", "dark", "system"]), DEFAULT_SETTINGS.theme);
  const recentFiles = Array.isArray(data.recentFiles)
    ? data.recentFiles.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, MAX_RECENT_FILES)
    : [];
  const font = (data.defaultFont && typeof data.defaultFont === "object" ? data.defaultFont : {}) as Record<string, unknown>;
  const size = typeof font.size === "number" && font.size >= 6 && font.size <= 72 ? font.size : DEFAULT_SETTINGS.defaultFont.size;
  const family = typeof font.family === "string" && font.family.trim() ? font.family.trim() : DEFAULT_SETTINGS.defaultFont.family;
  const csv = (data.csv && typeof data.csv === "object" ? data.csv : {}) as Record<string, unknown>;
  return {
    theme,
    recentFiles,
    defaultFont: { family, size },
    csv: {
      delimiter: pick(csv.delimiter, DELIMITERS, null),
      encoding: pick(csv.encoding, ENCODINGS, null),
      decimal: pick(csv.decimal, new Set([".", ","]), null),
      saveDelimiter: pick(csv.saveDelimiter, DELIMITERS, DEFAULT_SETTINGS.csv.saveDelimiter),
    },
  };
}

export function loadSettings(storage: SettingsStorage = defaultStorage()): AppSettings {
  let raw: unknown = null;
  try {
    const text = storage.getItem(STORAGE_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  return parseSettings(raw, raw ? null : storage.getItem(LEGACY_THEME_KEY));
}

export function saveSettings(settings: AppSettings, storage: SettingsStorage = defaultStorage()): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Quota or access errors are not worth interrupting the user.
  }
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => value.replaceAll("/", "\\").toLowerCase();
  return normalize(a) === normalize(b);
}

/** Moves `path` to the front of the list (deduplicated case-insensitively, like Windows). */
export function withRecentFile(list: ReadonlyArray<string>, path: string, max = MAX_RECENT_FILES): string[] {
  return [path, ...list.filter((item) => !samePath(item, path))].slice(0, max);
}

export function withoutRecentFile(list: ReadonlyArray<string>, path: string): string[] {
  return list.filter((item) => !samePath(item, path));
}

export interface SettingsStore {
  get(): AppSettings;
  update(patch: Partial<AppSettings> | ((current: AppSettings) => Partial<AppSettings>)): void;
  addRecentFile(path: string): void;
  removeRecentFile(path: string): void;
  clearRecentFiles(): void;
  subscribe(listener: () => void): () => void;
}

export function createSettingsStore(storage: SettingsStorage = defaultStorage()): SettingsStore {
  let state = loadSettings(storage);
  const listeners = new Set<() => void>();
  const set = (next: AppSettings) => {
    state = next;
    saveSettings(state, storage);
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    update(patch) {
      const partial = typeof patch === "function" ? patch(state) : patch;
      set({ ...state, ...partial });
    },
    addRecentFile(path) {
      set({ ...state, recentFiles: withRecentFile(state.recentFiles, path) });
    },
    removeRecentFile(path) {
      set({ ...state, recentFiles: withoutRecentFile(state.recentFiles, path) });
    },
    clearRecentFiles() {
      set({ ...state, recentFiles: [] });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let appSettings: SettingsStore | null = null;

/** The app-wide settings store (localStorage). */
export function getSettingsStore(): SettingsStore {
  appSettings ??= createSettingsStore();
  return appSettings;
}
