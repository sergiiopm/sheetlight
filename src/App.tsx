import { useEffect, useState } from "react";
import { FormulaBar } from "@/components/FormulaBar";
import { SheetTabs } from "@/components/SheetTabs";
import { StatusBar } from "@/components/StatusBar";
import { TabBar } from "@/components/TabBar";
import { Toolbar } from "@/components/Toolbar";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { useWorkbookTabs } from "@/hooks/use-workbook-tabs";
import { applyTheme, getPreferredTheme, type ThemeMode } from "@/lib/theme";

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [error, setError] = useState<string | null>(null);
  const session = useWorkbookTabs({ onError: setError });

  useEffect(() => {
    const initial = getPreferredTheme();
    setTheme(initial);
    applyTheme(initial);
  }, []);

  useShortcuts({
    onNew: session.newWorkbook,
    onOpen: session.openWorkbook,
    onCloseTab: session.closeActiveTab,
    onNextTab: session.nextTab,
    onPreviousTab: session.previousTab,
  });

  return (
    <div className="flex h-full flex-col bg-workspace">
      <Toolbar
        theme={theme}
        onNew={session.newWorkbook}
        onOpen={session.openWorkbook}
        onToggleTheme={() => {
          const next = theme === "dark" ? "light" : "dark";
          setTheme(next);
          applyTheme(next);
        }}
      />
      <TabBar
        tabs={session.tabs}
        activeId={session.activeTab.id}
        onSelect={session.activate}
        onClose={session.closeTab}
        onMove={session.moveTab}
        onNew={session.newWorkbook}
      />
      <FormulaBar />
      {error ? (
        <div className="mx-2 my-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
          <button type="button" className="ml-3 underline" onClick={() => setError(null)}>
            Cerrar
          </button>
        </div>
      ) : null}
      <main className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-1 bg-background text-muted-foreground">
        <p className="text-sm">Rejilla — pendiente</p>
        {session.activeTab.path ? (
          <p className="text-xs">«{session.fileName}» abierto; la lectura del contenido llegará en la siguiente fase.</p>
        ) : null}
      </main>
      <SheetTabs sheets={["Hoja1"]} activeIndex={0} />
      <StatusBar formatLabel={session.formatLabel} byteLength={session.activeTab.byteLength} />
    </div>
  );
}
