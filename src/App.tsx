import { ControllerProvider } from "@/components/controller-context";
import { DialogHost } from "@/components/dialogs/DialogHost";
import { FilterMenu } from "@/components/FilterMenu";
import { GridContextMenu } from "@/components/GridContextMenu";
import { Notices } from "@/components/Notices";
import { SheetTabs } from "@/components/SheetTabs";
import { StatusBar } from "@/components/StatusBar";
import { TabBar } from "@/components/TabBar";
import { Toolbar } from "@/components/Toolbar";
import { WorkbookView } from "@/components/WorkbookView";
import type { AppController } from "@/hooks/app-controller";
import { useStore } from "@/hooks/store";
import { useAppController } from "@/hooks/use-app-controller";

/**
 * App layout (Excel-like): ribbon toolbar, document tabs, then for the active
 * workbook the formula bar + grid, sheet tabs and status bar. Dialogs, menus
 * and toasts float above.
 */
export default function App() {
  const controller = useAppController();
  if (!controller) {
    return <div className="flex h-full items-center justify-center bg-workspace text-sm text-muted-foreground">Cargando Sheetlight…</div>;
  }
  return (
    <ControllerProvider controller={controller}>
      <Shell controller={controller} />
    </ControllerProvider>
  );
}

function Shell({ controller }: { controller: AppController }) {
  const { sessions, activeId } = useStore(controller.manager.state);
  const active = sessions.find((s) => s.id === activeId) ?? null;
  return (
    <div className="flex h-full flex-col bg-workspace">
      <Toolbar />
      <TabBar />
      {active ? (
        <>
          <WorkbookView key={`${active.id}:${active.doc}`} session={active} />
          <SheetTabs session={active} />
          <StatusBar session={active} />
        </>
      ) : (
        <main className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No hay ningún libro abierto.</main>
      )}
      <GridContextMenu />
      <FilterMenu />
      <DialogHost />
      <Notices />
    </div>
  );
}
