import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BarChart3, ChevronRight, Copy, Pencil, Trash2 } from "lucide-react";
import type { ChartSpec } from "@/engine/contract";
import { cn } from "@/lib/utils";
import { CHART_VARIANTS, variantOf, type ChartVariant } from "@/charts/variants";

interface ChartContextMenuProps {
  readonly chart: ChartSpec;
  readonly x: number;
  readonly y: number;
  readonly readOnly: boolean;
  readonly onEdit: () => void;
  readonly onChangeType: (variant: ChartVariant) => void;
  readonly onCopyImage: () => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}

const itemClass =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

/** Right-click menu of a chart (Spanish, Excel wording). */
export function ChartContextMenu({ chart, x, y, readOnly, onEdit, onChangeType, onCopyImage, onDelete, onClose }: ChartContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [typesOpen, setTypesOpen] = useState(false);
  const current = variantOf(chart.type, chart.grouping);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      data-chart-ui=""
      role="menu"
      aria-label="Gráfico"
      onKeyDown={onMenuKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 min-w-52 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left: pos.x, top: pos.y }}
    >
      <button type="button" role="menuitem" className={itemClass} disabled={readOnly} onClick={run(onEdit)}>
        <Pencil className="size-4" /> Editar gráfico…
      </button>
      <div className="relative" onMouseEnter={() => setTypesOpen(true)} onMouseLeave={() => setTypesOpen(false)}>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={typesOpen}
          className={itemClass}
          disabled={readOnly}
          onClick={() => setTypesOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") {
              e.preventDefault();
              setTypesOpen(true);
            }
          }}
        >
          <BarChart3 className="size-4" /> Cambiar tipo de gráfico
          <ChevronRight className="ml-auto size-4" />
        </button>
        {typesOpen && !readOnly && (
          <div role="menu" aria-label="Tipos de gráfico" className="absolute left-full top-0 z-50 ml-1 min-w-52 rounded-md border bg-popover p-1 shadow-md">
            {CHART_VARIANTS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="menuitemradio"
                aria-checked={v.id === current.id}
                className={cn(itemClass, v.id === current.id && "font-semibold")}
                onClick={run(() => onChangeType(v))}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" role="menuitem" className={itemClass} onClick={run(onCopyImage)}>
        <Copy className="size-4" /> Copiar como imagen
      </button>
      <div className="my-1 h-px bg-border" role="separator" />
      <button type="button" role="menuitem" className={itemClass} disabled={readOnly} onClick={run(onDelete)}>
        <Trash2 className="size-4" /> Eliminar
      </button>
    </div>,
    document.body,
  );
}
