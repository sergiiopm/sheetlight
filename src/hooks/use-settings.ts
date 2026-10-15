import { useSyncExternalStore } from "react";
import { getSettingsStore, type AppSettings } from "@/lib/settings";

/** Current app settings; re-renders when they change. */
export function useSettings(): AppSettings {
  const store = getSettingsStore();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
