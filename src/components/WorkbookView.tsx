import { useEffect, useRef, useState } from "react";
import { FileSpreadsheet, TriangleAlert, X } from "lucide-react";
import { useController } from "@/components/controller-context";
import { CellEditor, FormulaBar, editModeLabel, useEditSession, useEditState } from "@/editor";
import { describeCsvOptions } from "@/files/csv";
import { summarizeFidelity } from "@/files/fidelity";
import { SpreadsheetGrid, type GridHandle } from "@/grid";
import { openFilterMenu } from "@/hooks/actions/data-actions";
import { useStore } from "@/hooks/store";
import { useSettings } from "@/hooks/use-settings";
import type { WorkbookSession } from "@/hooks/workbook-session";

/**
 * One open document: formula bar + canvas grid + in-cell editor, the
 * fidelity warning banner and the chart overlay slot. Mounted for the active
 * workbook tab (keyed by session), so each document gets its own grid and
 * edit session; the per-sheet scroll/zoom lives in the session.
 */
export function WorkbookView({ session }: { session: WorkbookSession }) {
  const controller = useController();
  const meta = useStore(session.meta);
  const settings = useSettings();
  const ChartLayer = useStore(controller.charts.layer);
  const { doc, activeSheet: sheet } = meta.info;

  // Keep the handle in state (callback ref) so the editor overlay re-renders when it mounts.
  const [grid, setGrid] = useState<GridHandle | null>(null);
  const gridRef = useRef(grid);
  gridRef.current = grid;

  const editor = useEditSession({
    engine: session.engine,
    doc,
    selection: session.selection,
    getGrid: () => gridRef.current,
    getSheets: () => session.info.sheets,
    onNavigateSheet: (target, range) => void controller.select(target, range),
    onCommit: (ops) => controller.manager.applyEdit(session, ops),
  });
  const editState = useEditState(editor);

  useEffect(() => {
    session.editor = editor;
    return () => {
      if (session.editor === editor) session.editor = null;
    };
  }, [session, editor]);

  useEffect(() => {
    session.editMode.set(editModeLabel(editState.status, editState.mode));
  }, [session, editState.status, editState.mode]);

  useEffect(() => {
    controller.attachGrid(session, grid);
    return () => {
      if (session.grid === grid) controller.attachGrid(session, null);
    };
  }, [controller, session, grid]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FormulaBar session={editor} className="shrink-0 border-b border-border" />
      <WorkbookBanners session={session} />
      <div data-grid-host className="relative min-h-0 flex-1 bg-background">
        <SpreadsheetGrid
          ref={setGrid}
          style={{ position: "absolute", inset: 0 }}
          engine={session.engine}
          doc={doc}
          sheet={sheet}
          selection={session.selection}
          initialView={session.viewFor(sheet)}
          onApply={(ops) => void controller.manager.apply(session, ops)}
          onEditRequest={editor.start}
          onUnhandledKey={(event) => {
            controller.handleKey(event, "grid");
          }}
          onContextMenu={(event) => controller.openContextMenu(event)}
          onFilterButton={(col, rect) =>
            openFilterMenu(controller, col, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
          }
          onViewportChange={(view) => session.setViewport(view)}
        />
        <CellEditor
          session={editor}
          grid={grid}
          defaultFontFamily={settings.defaultFont.family}
          defaultFontSizePt={settings.defaultFont.size}
        />
        {/*
          Chart overlay slot (WS6). The orchestrator injects the layer with
          `controller.charts.setLayer(...)`; it draws into
          `grid.getOverlayHost()` and positions charts with `grid.getRangeRect`.
        */}
        <div data-chart-slot className="contents">
          {ChartLayer ? (
            <ChartLayer engine={session.engine} doc={doc} sheet={sheet} grid={grid} apply={(ops) => controller.manager.apply(session, ops)} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Fidelity warnings of the opened file and the detected CSV options. */
function WorkbookBanners({ session }: { session: WorkbookSession }) {
  const controller = useController();
  const meta = useStore(session.meta);
  const { info } = meta;
  const fidelity = summarizeFidelity(info.warnings);

  if (fidelity.message && !meta.warningsDismissed) {
    const kept = [...fidelity.preserved, ...fidelity.editable];
    return (
      <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-amber-300/60 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
        <TriangleAlert className="mt-px h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <span>{fidelity.message}</span>
          {kept.length > 0 ? <span className="text-amber-800/80 dark:text-amber-200/70"> Se conservarán: {kept.join(", ")}.</span> : null}
        </div>
        <button
          type="button"
          aria-label="Cerrar aviso"
          title="Cerrar aviso"
          className="rounded-sm p-0.5 hover:bg-amber-200/60 dark:hover:bg-amber-500/20"
          onClick={() => {
            session.patchMeta({ warningsDismissed: true });
            controller.focusGrid();
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  if (info.csv && info.sourceFormat === "csv" && !meta.csvHintDismissed && session.source.kind !== "new") {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-workspace px-3 py-1 text-xs text-muted-foreground">
        <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">CSV abierto con: {describeCsvOptions(info.csv)}</span>
        <button
          type="button"
          className="rounded-sm px-1.5 py-0.5 text-foreground underline-offset-2 hover:underline"
          onClick={() => controller.openDialog({ kind: "csvOptions", sessionId: session.id })}
        >
          Cambiar…
        </button>
        <button
          type="button"
          aria-label="Cerrar aviso"
          className="rounded-sm p-0.5 hover:bg-accent"
          onClick={() => {
            session.patchMeta({ csvHintDismissed: true });
            controller.focusGrid();
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }
  return null;
}
