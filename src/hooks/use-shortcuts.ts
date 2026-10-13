import { useEffect } from "react";

interface ShortcutHandlers {
  onNew: () => void;
  onOpen: () => void;
  onCloseTab: () => void;
  onNextTab: () => void;
  onPreviousTab: () => void;
}

/**
 * App-level shortcuts for workbook (document) tabs.
 *
 * Unlike Doclight, Ctrl+PageUp / Ctrl+PageDown are left free: in a spreadsheet
 * they switch between sheets of the active workbook (handled by the grid later).
 */
export function useShortcuts({ onNew, onOpen, onCloseTab, onNextTab, onPreviousTab }: ShortcutHandlers) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;

      if (event.key === "Tab") {
        event.preventDefault();
        if (event.shiftKey) onPreviousTab();
        else onNextTab();
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "w") {
        event.preventDefault();
        onCloseTab();
      } else if (key === "n") {
        event.preventDefault();
        onNew();
      } else if (key === "o") {
        event.preventDefault();
        onOpen();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCloseTab, onNew, onNextTab, onOpen, onPreviousTab]);
}
