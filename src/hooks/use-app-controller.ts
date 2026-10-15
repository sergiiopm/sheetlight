import { useEffect, useState } from "react";
import { installCharts } from "@/charts/shell-integration";
import { getEngine } from "@/engine";
import { getFormatFromPath } from "@/files/path";
import { AppController } from "@/hooks/app-controller";
import { registerShellCommands } from "@/hooks/app-commands";
import { browserClipboard, contentsFromDataTransfer } from "@/hooks/clipboard";
import { createFileGateway } from "@/hooks/file-gateway";
import { isEditableTarget } from "@/hooks/shortcuts";
import { windowTitle } from "@/hooks/workbook-session";
import { isTauri } from "@/lib/is-tauri";
import { getSettingsStore } from "@/lib/settings";
import { applyTheme, resolveTheme, watchSystemTheme } from "@/lib/theme";

/**
 * Creates the app-wide `AppController` once (it lives as long as the page;
 * StrictMode double effects must not create a second set of documents) and
 * wires it to the window: keyboard, paste, theme, title, "Open with",
 * second instance, drag & drop and the close request.
 */

let controllerPromise: Promise<AppController> | null = null;
let launchPathsTaken = false;

async function destroyWindow(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().destroy();
}

export function getAppController(): Promise<AppController> {
  controllerPromise ??= getEngine().then(async (engine) => {
    const controller = new AppController({
      engine,
      files: createFileGateway(),
      clipboard: browserClipboard,
      settings: getSettingsStore(),
      destroyWindow,
    });
    registerShellCommands(controller);
    installCharts(controller);
    await controller.manager.ensureOne();
    return controller;
  });
  return controllerPromise;
}

export function useAppController(): AppController | null {
  const [controller, setController] = useState<AppController | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getAppController().then((c) => {
      if (!cancelled) setController(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useWindowIntegration(controller);
  return controller;
}

function useWindowIntegration(controller: AppController | null): void {
  // Theme (light / dark / system).
  useEffect(() => {
    const settings = getSettingsStore();
    const apply = () => applyTheme(resolveTheme(settings.get().theme));
    apply();
    const unsubscribe = settings.subscribe(apply);
    const unwatch = watchSystemTheme(apply);
    return () => {
      unsubscribe();
      unwatch();
    };
  }, []);

  useEffect(() => {
    if (!controller) return;
    const c = controller;

    const onKeyDown = (event: KeyboardEvent) => {
      c.handleKey(event, "window");
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (c.handlePasteEvent(contentsFromDataTransfer(event.clipboardData))) event.preventDefault();
    };
    // Format painter: releasing the pointer over the grid applies the format.
    const onPointerUp = (event: PointerEvent) => {
      if (!c.painter.get()) return;
      const target = event.target as Element | null;
      if (!target?.closest?.("[data-grid-host]")) return;
      setTimeout(() => void c.finishFormatPainter(), 0);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("paste", onPaste);
    window.addEventListener("pointerup", onPointerUp, true);

    // Window title follows the active workbook.
    let unsubscribeMeta: (() => void) | null = null;
    const updateTitle = () => {
      const title = windowTitle(c.session?.meta.get() ?? null);
      if (document.title === title) return;
      document.title = title;
      if (isTauri()) {
        void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title).catch(() => undefined));
      }
    };
    const bindTitle = () => {
      unsubscribeMeta?.();
      unsubscribeMeta = c.session?.meta.subscribe(updateTitle) ?? null;
      updateTitle();
    };
    const unsubscribeSessions = c.manager.state.subscribe(bindTitle);
    bindTitle();

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("paste", onPaste);
      window.removeEventListener("pointerup", onPointerUp, true);
      unsubscribeSessions();
      unsubscribeMeta?.();
    };
  }, [controller]);

  // Native (Tauri) or browser file plumbing and close handling.
  useEffect(() => {
    if (!controller) return;
    const c = controller;
    if (!isTauri()) return browserFilePlumbing(c);

    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      if (!launchPathsTaken) {
        launchPathsTaken = true;
        const paths = await invoke<string[]>("take_launch_paths").catch(() => []);
        if (paths.length > 0) void c.manager.openPaths(paths);
      }
      if (cancelled) return;
      const handlers = await Promise.all([
        getCurrentWindow().onCloseRequested(async (event) => {
          if (!c.manager.anyDirty) return;
          event.preventDefault();
          await c.manager.requestCloseWindow();
        }),
        listen<string[]>("open-files", (event) => void c.manager.openPaths(event.payload)),
        getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "drop") void c.manager.openPaths(event.payload.paths.filter((p) => getFormatFromPath(p) !== null));
        }),
      ]);
      if (cancelled) handlers.forEach((unlisten) => unlisten());
      else unlisteners.push(...handlers);
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [controller]);
}

/** Plain browser: drop files onto the window, warn before unloading unsaved work. */
function browserFilePlumbing(c: AppController): () => void {
  const onDragOver = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  };
  const onDrop = (event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }))).then((picked) =>
      c.manager.openFiles(picked),
    );
  };
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!c.manager.anyDirty) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);
  window.addEventListener("beforeunload", onBeforeUnload);
  return () => {
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("drop", onDrop);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
}
