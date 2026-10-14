import type { ThemePreference } from "@/lib/settings";

/** Effective theme applied to the document. */
export type ThemeMode = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function systemTheme(): ThemeMode {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference, system: ThemeMode = systemTheme()): ThemeMode {
  return preference === "system" ? system : preference;
}

export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

/** Calls `listener` when the OS switches between light and dark. */
export function watchSystemTheme(listener: (theme: ThemeMode) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const query = window.matchMedia(DARK_QUERY);
  const onChange = () => listener(query.matches ? "dark" : "light");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
