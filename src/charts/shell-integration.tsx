import { useMemo, useRef } from "react";
import type { WorkbookEngine } from "@/engine/contract";
import type { AppController } from "@/hooks/app-controller";
import type { ChartLayerProps as ShellChartLayerProps, ShellApply } from "@/hooks/chart-integration";
import { ChartLayer } from "@/charts/ChartLayer";
import { requestChartInsert } from "@/charts/commands";

/**
 * Engine view for the chart layer whose `apply` goes through the shell, so
 * chart edits update dirty / undo state like any other edit. The shell
 * reports apply errors itself; a null result means it failed.
 */
function shellEngine(engine: WorkbookEngine, apply: ShellApply): WorkbookEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === "apply") {
        return async (_doc: unknown, ops: Parameters<WorkbookEngine["apply"]>[1]) => {
          const result = (await apply(ops)) as Awaited<ReturnType<WorkbookEngine["apply"]>> | null;
          if (!result) throw new Error("No se pudo modificar el gráfico.");
          return result;
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function ShellChartLayer({ engine, doc, sheet, grid, apply }: ShellChartLayerProps) {
  // The shell passes a fresh `apply` each render; keep the engine view stable
  // so the layer does not rebuild its controller.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const proxied = useMemo(() => shellEngine(engine, (ops) => applyRef.current(ops)), [engine]);
  return <ChartLayer engine={proxied} doc={doc} sheet={sheet} grid={grid} />;
}

/** Plugs charts into the shell: overlay layer and "Insertar > Gráfico". */
export function installCharts(controller: AppController): void {
  controller.charts.setLayer(ShellChartLayer);
  controller.charts.setInsertHandler(({ doc, sheet, selection }) => {
    if (!requestChartInsert({ doc, sheet, ranges: selection.ranges, active: selection.active })) {
      controller.notify("No se puede insertar un gráfico en este documento.", "info");
    }
  });
}
