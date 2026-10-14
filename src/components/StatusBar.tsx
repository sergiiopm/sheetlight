import { Minus, Plus } from "lucide-react";
import { useController } from "@/components/controller-context";
import { setZoom, stepZoom, ZOOM_MAX, ZOOM_MIN } from "@/hooks/actions/view-actions";
import { loadLabel, loadPercent, statItems, statSummary } from "@/hooks/selection-stats";
import { useStore } from "@/hooks/store";
import type { WorkbookSession } from "@/hooks/workbook-session";

/**
 * Excel status bar: mode (Listo / Introducir / Modificar / Señalar), CSV
 * loading progress, Promedio / Recuento / Suma of the selection and zoom.
 */
export function StatusBar({ session }: { session: WorkbookSession }) {
  const controller = useController();
  const mode = useStore(session.editMode);
  const load = useStore(session.load);
  const zoom = useStore(session.zoom);
  const stats = useStore(controller.stats.stats);
  const items = statItems(stats);
  const loading = loadLabel(load);
  const percent = loadPercent(load);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-background px-3 text-[11px] text-muted-foreground">
      <span className="shrink-0" aria-live="polite">
        {mode}
      </span>
      {loading ? (
        <span className="flex min-w-0 items-center gap-2" role="status">
          {percent !== null && !load?.error ? (
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span className="block h-full bg-brand transition-[width]" style={{ width: `${percent}%` }} />
            </span>
          ) : null}
          <span className={load?.error ? "truncate text-destructive" : "truncate"}>{loading}</span>
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-4">
        {items.length > 0 ? (
          <button
            type="button"
            title="Copiar al portapapeles"
            className="flex items-center gap-4 rounded-sm px-1 hover:bg-accent hover:text-foreground"
            onClick={() => void navigator.clipboard?.writeText(statSummary(stats)).catch(() => undefined)}
          >
            {items.map((item) => (
              <span key={item.id}>
                {item.label}: <span className="text-foreground tabular-nums">{item.value}</span>
              </span>
            ))}
          </button>
        ) : null}
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Alejar" className="rounded-sm p-0.5 hover:bg-accent hover:text-foreground" onClick={() => stepZoom(controller, -1)}>
            <Minus className="h-3 w-3" />
          </button>
          <input
            type="range"
            aria-label="Zoom"
            min={ZOOM_MIN * 100}
            max={ZOOM_MAX * 100}
            step={5}
            value={Math.round(zoom * 100)}
            onChange={(event) => setZoom(controller, Number(event.target.value) / 100)}
            className="h-1 w-24 cursor-pointer accent-[var(--brand)]"
          />
          <button type="button" aria-label="Acercar" className="rounded-sm p-0.5 hover:bg-accent hover:text-foreground" onClick={() => stepZoom(controller, 1)}>
            <Plus className="h-3 w-3" />
          </button>
          <button
            type="button"
            title="Zoom al 100 %"
            className="w-10 rounded-sm text-right tabular-nums hover:bg-accent hover:text-foreground"
            onClick={() => setZoom(controller, 1)}
          >
            {Math.round(zoom * 100)} %
          </button>
        </div>
      </div>
    </footer>
  );
}
