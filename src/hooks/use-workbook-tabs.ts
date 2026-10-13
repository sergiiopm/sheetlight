import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@/lib/is-tauri";
import { pickBrowserFiles, pickOpenPaths, readPathBytes } from "@/files/native";
import { formatLabel, getFileName, getFormatFromPath, samePath, untitledFileName } from "@/files/path";
import type { WorkbookFormat } from "@/files/types";

/**
 * Multi-document tab session, ported from Doclight's `useDocumentTabs`.
 *
 * Scaffold scope: it manages the open tabs and wires the native plumbing
 * (open dialog, files passed on the command line / "Open with", files sent by
 * a second instance, drag & drop, window title). Workbook contents are not
 * parsed yet: a tab only records which file it points to. Saving and the
 * unsaved-changes prompt arrive together with the workbook model.
 */

let launchPathsPromise: Promise<string[]> | null = null;
let nextTabNumber = 1;

export interface WorkbookTab {
  id: string;
  path: string | null;
  format: WorkbookFormat;
  dirty: boolean;
  /** Number of an unsaved new workbook ("Libro2.xlsx"); 0 for files on disk. */
  untitled: number;
  /** Size of the file read from disk, if any. */
  byteLength: number | null;
}

export function tabFileName(tab: Pick<WorkbookTab, "path" | "untitled">): string {
  return tab.path ? getFileName(tab.path) : untitledFileName(tab.untitled);
}

function nextUntitledNumber(tabs: WorkbookTab[]): number {
  const used = new Set(tabs.filter((tab) => !tab.path).map((tab) => tab.untitled));
  let number = 1;
  while (used.has(number)) number += 1;
  return number;
}

function isPristine(tab: WorkbookTab): boolean {
  return !tab.path && !tab.dirty;
}

function createTab(existing: WorkbookTab[], path: string | null, format: WorkbookFormat, byteLength: number | null): WorkbookTab {
  return {
    id: `tab-${nextTabNumber++}`,
    path,
    format,
    dirty: false,
    untitled: path ? 0 : nextUntitledNumber(existing),
    byteLength,
  };
}

interface UseWorkbookTabsOptions {
  onError: (message: string) => void;
}

export function useWorkbookTabs({ onError }: UseWorkbookTabsOptions) {
  const tabsRef = useRef<WorkbookTab[]>([]);
  const activeIdRef = useRef("");
  const openQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Always keep at least one workbook open.
  if (tabsRef.current.length === 0) {
    const first = createTab([], null, "xlsx", null);
    tabsRef.current = [first];
    activeIdRef.current = first.id;
  }

  const [tabs, setTabsState] = useState<WorkbookTab[]>(tabsRef.current);
  const [activeId, setActiveIdState] = useState(activeIdRef.current);

  const setTabs = useCallback((next: WorkbookTab[]) => {
    tabsRef.current = next;
    setTabsState(next);
  }, []);

  const activate = useCallback((id: string) => {
    activeIdRef.current = id;
    setActiveIdState(id);
  }, []);

  /** Adds a tab, replacing the active one if it is an untouched blank workbook. */
  const addTab = useCallback((tab: WorkbookTab) => {
    const current = tabsRef.current;
    const active = current.find((item) => item.id === activeIdRef.current);
    if (active && isPristine(active)) {
      setTabs(current.map((item) => (item.id === active.id ? tab : item)));
    } else {
      setTabs([...current, tab]);
    }
    activate(tab.id);
  }, [activate, setTabs]);

  const newWorkbook = useCallback(() => {
    const tab = createTab(tabsRef.current, null, "xlsx", null);
    setTabs([...tabsRef.current, tab]);
    activate(tab.id);
  }, [activate, setTabs]);

  const addOpenedFile = useCallback((path: string, byteLength: number) => {
    const format = getFormatFromPath(path);
    if (!format) {
      onError(`«${getFileName(path)}»: Sheetlight solo abre archivos .xlsx, .xls y .csv.`);
      return;
    }
    addTab(createTab(tabsRef.current, path, format, byteLength));
  }, [addTab, onError]);

  const openPath = useCallback(async (path: string) => {
    const existing = tabsRef.current.find((tab) => tab.path && samePath(tab.path, path));
    if (existing) {
      activate(existing.id);
      return;
    }
    if (!getFormatFromPath(path)) {
      onError(`«${getFileName(path)}»: Sheetlight solo abre archivos .xlsx, .xls y .csv.`);
      return;
    }
    try {
      const bytes = await readPathBytes(path);
      addOpenedFile(path, bytes.byteLength);
    } catch (error) {
      onError(typeof error === "string" ? error : `No se pudo abrir «${getFileName(path)}».`);
    }
  }, [activate, addOpenedFile, onError]);

  /** Opens files one after another so their tabs keep the requested order. */
  const openPaths = useCallback((paths: string[]) => {
    for (const path of paths) {
      openQueueRef.current = openQueueRef.current.then(() => openPath(path));
    }
  }, [openPath]);

  const openWorkbook = useCallback(async () => {
    try {
      if (isTauri()) {
        openPaths(await pickOpenPaths());
        return;
      }
      for (const file of await pickBrowserFiles()) {
        addOpenedFile(file.name, file.size);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "No se pudo abrir el libro.");
    }
  }, [addOpenedFile, onError, openPaths]);

  const closeTab = useCallback((id: string) => {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const remaining = current.filter((tab) => tab.id !== id);
    const next = remaining.length > 0 ? remaining : [createTab([], null, "xlsx", null)];
    setTabs(next);
    if (activeIdRef.current === id || !next.some((tab) => tab.id === activeIdRef.current)) {
      activate(next[Math.min(index, next.length - 1)].id);
    }
  }, [activate, setTabs]);

  const cycle = useCallback((step: number) => {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.id === activeIdRef.current);
    activate(current[(index + step + current.length) % current.length].id);
  }, [activate]);

  const moveTab = useCallback((id: string, overId: string) => {
    const current = [...tabsRef.current];
    const from = current.findIndex((tab) => tab.id === id);
    const to = current.findIndex((tab) => tab.id === overId);
    if (from === -1 || to === -1 || from === to) return;
    const [moved] = current.splice(from, 1);
    current.splice(to, 0, moved);
    setTabs(current);
  }, [setTabs]);

  const openPathsRef = useRef(openPaths);
  openPathsRef.current = openPaths;

  // Native wiring: launch arguments, second-instance files and drag & drop.
  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");

      launchPathsPromise ??= invoke<string[]>("take_launch_paths").catch(() => []);
      const launchPaths = await launchPathsPromise;
      if (cancelled) return;
      openPathsRef.current(launchPaths);

      const handlers = await Promise.all([
        listen<string[]>("open-files", (event) => openPathsRef.current(event.payload)),
        getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "drop") openPathsRef.current(event.payload.paths);
        }),
      ]);
      if (cancelled) handlers.forEach((unlisten) => unlisten());
      else unlisteners.push(...handlers);
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  const fileName = tabFileName(activeTab);

  useEffect(() => {
    const title = `${fileName}${activeTab.dirty ? " •" : ""} — Sheetlight`;
    document.title = title;
    if (!isTauri()) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      void getCurrentWindow().setTitle(title).catch(() => undefined);
    });
  }, [activeTab.dirty, fileName]);

  return {
    tabs,
    activeTab,
    fileName,
    formatLabel: formatLabel(activeTab.format),
    activate,
    newWorkbook,
    openWorkbook: () => void openWorkbook(),
    closeTab,
    closeActiveTab: () => closeTab(activeTab.id),
    nextTab: () => cycle(1),
    previousTab: () => cycle(-1),
    moveTab,
  };
}
