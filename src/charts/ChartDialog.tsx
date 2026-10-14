import { useEffect, useMemo, useState } from "react";
import type { ChartSeries, ChartSpec, ChartType, RangeValues, SheetMeta, WorkbookEngine } from "@/engine/contract";
import type { CellRange, DocumentId, SheetId } from "@/engine/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ChartPreview } from "@/charts/ChartPreview";
import { resolveChartData, type ChartData, type ChartLook } from "@/charts/data";
import { inferSeries, type SeriesOrientation } from "@/charts/infer";
import { formatRef, resolveRef } from "@/charts/refs";
import { normalizeColor, paletteColor } from "@/charts/theme";
import { CHART_VARIANTS, SAMPLE_DATA, isPieLike, retypeData, variantOf, type ChartVariant } from "@/charts/variants";

/** What the dialog produces; the layer adds sheet/anchor (insert) or id/anchor (edit). */
export type ChartDraftFields = Omit<ChartSpec, "id" | "fromFile" | "anchor" | "sheet">;

export interface ChartDialogInsert {
  readonly mode: "insert";
  /** Source block (already expanded to the current region / trimmed). */
  readonly range: CellRange;
}

export interface ChartDialogEdit {
  readonly mode: "edit";
  readonly chart: ChartSpec;
}

export interface ChartDialogProps {
  readonly engine: WorkbookEngine;
  readonly doc: DocumentId;
  readonly sheet: SheetId;
  readonly sheets: ReadonlyArray<SheetMeta>;
  readonly request: ChartDialogInsert | ChartDialogEdit;
  readonly onCancel: () => void;
  /** `dataSheet`/`dataRange`: where the series data lives (insert mode, to place the chart next to it). */
  readonly onSubmit: (fields: ChartDraftFields, source: { sheet: SheetId; range: CellRange } | null) => void;
}

const LEGEND_OPTIONS: ReadonlyArray<{ value: ChartSpec["legend"]; label: string }> = [
  { value: "none", label: "Ninguna" },
  { value: "right", label: "Derecha" },
  { value: "bottom", label: "Abajo" },
  { value: "top", label: "Arriba" },
  { value: "left", label: "Izquierda" },
];

const COMBO_OPTIONS: ReadonlyArray<{ value: ChartType | ""; label: string }> = [
  { value: "", label: "Igual que el gráfico" },
  { value: "column", label: "Columnas" },
  { value: "line", label: "Líneas" },
  { value: "area", label: "Áreas" },
];

const selectClass =
  "flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface FormState {
  variant: ChartVariant;
  title: string;
  legend: ChartSpec["legend"];
  xAxisTitle: string;
  yAxisTitle: string;
  series: ChartSeries[];
}

function sheetNameOf(sheets: ReadonlyArray<SheetMeta>, id: SheetId): string {
  return sheets.find((s) => s.id === id)?.name ?? "Hoja1";
}

function defaultTitle(series: ReadonlyArray<ChartSeries>): string {
  return series.length === 1 ? "" : "Título del gráfico";
}

export function ChartDialog({ engine, doc, sheet, sheets, request, onCancel, onSubmit }: ChartDialogProps) {
  const isInsert = request.mode === "insert";
  const sheetName = sheetNameOf(sheets, sheet);

  const [form, setForm] = useState<FormState>(() => {
    if (request.mode === "edit") {
      const c = request.chart;
      return {
        variant: variantOf(c.type, c.grouping),
        title: c.title ?? "",
        legend: c.legend,
        xAxisTitle: c.xAxisTitle ?? "",
        yAxisTitle: c.yAxisTitle ?? "",
        series: c.series.map((s) => ({ ...s })),
      };
    }
    return { variant: CHART_VARIANTS[0], title: "", legend: "bottom", xAxisTitle: "", yAxisTitle: "", series: [] };
  });
  const [rangeText, setRangeText] = useState(() => (request.mode === "insert" ? formatRef(sheetName, request.range) : ""));
  const [orientation, setOrientation] = useState<SeriesOrientation | null>(null);
  const [source, setSource] = useState<{ sheet: SheetId; range: CellRange; values: RangeValues } | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [data, setData] = useState<ChartData | null>(null);
  const [titleTouched, setTitleTouched] = useState(!isInsert);

  // Insert mode: read the source block whenever the range text changes.
  useEffect(() => {
    if (!isInsert) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const areas = resolveRef(rangeText, sheets, sheet);
      if (!areas || areas.length !== 1) {
        setRangeError("Escriba un rango válido, por ejemplo A1:C13.");
        setSource(null);
        return;
      }
      const area = areas[0];
      try {
        const values = await engine.getRangeValues(doc, area.sheet, area.range);
        if (cancelled) return;
        setRangeError(null);
        setSource({ sheet: area.sheet, range: area.range, values });
      } catch {
        if (!cancelled) setRangeError("No se pudo leer el rango.");
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isInsert, rangeText, sheets, sheet, engine, doc]);

  // Insert mode: infer series from the block (again when orientation or scatter-ness changes).
  const isScatter = form.variant.type === "scatter";
  useEffect(() => {
    if (!isInsert || !source) return;
    const inferred = inferSeries(source.values, sheetNameOf(sheets, source.sheet), {
      orientation: orientation ?? undefined,
      chartType: isScatter ? "scatter" : undefined,
    });
    setForm((f) => ({
      ...f,
      series: inferred.series,
      title: titleTouched ? f.title : defaultTitle(inferred.series),
      legend: inferred.series.length > 1 || isPieLike(f.variant.type) ? "bottom" : "none",
    }));
    if (orientation === null) setOrientation(inferred.orientation);
    // titleTouched is read, not tracked: typing a title must not re-infer the series.
  }, [isInsert, source, orientation, isScatter, sheets]);

  const draft = useMemo(
    () => ({ sheet, type: form.variant.type, series: form.series }),
    [sheet, form.variant.type, form.series],
  );

  // Resolve preview data (debounced).
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (draft.series.length === 0) {
        setData(null);
        return;
      }
      try {
        const resolved = await resolveChartData(engine, doc, draft, sheets);
        if (!cancelled) setData(resolved);
      } catch {
        if (!cancelled) setData(null);
      }
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft, engine, doc, sheets]);

  const look: ChartLook = useMemo(
    () => ({
      type: form.variant.type,
      grouping: form.variant.grouping,
      title: form.title.trim() ? form.title : null,
      legend: form.legend,
      xAxisTitle: form.xAxisTitle.trim() ? form.xAxisTitle : null,
      yAxisTitle: form.yAxisTitle.trim() ? form.yAxisTitle : null,
    }),
    [form],
  );

  // With a single series and no explicit title, Excel shows the series name.
  const previewLook = useMemo(
    () => (look.title === null && !titleTouched && data?.series.length === 1 ? { ...look, title: data.series[0].name } : look),
    [look, data, titleTouched],
  );

  const pie = isPieLike(form.variant.type);
  const canCombo = form.variant.type === "column" || form.variant.type === "line" || form.variant.type === "area";
  const canSubmit = form.series.length > 0 && !rangeError;

  const updateSeries = (index: number, patch: Partial<ChartSeries>) =>
    setForm((f) => ({ ...f, series: f.series.map((s, i) => (i === index ? { ...s, ...patch } : s)) }));

  const submit = () => {
    if (!canSubmit) return;
    const title = form.title.trim() ? form.title : !titleTouched && data?.series.length === 1 ? data.series[0].name : null;
    onSubmit(
      {
        type: form.variant.type,
        grouping: form.variant.grouping,
        title,
        legend: form.legend,
        xAxisTitle: pie ? null : form.xAxisTitle.trim() || null,
        yAxisTitle: pie ? null : form.yAxisTitle.trim() || null,
        series: form.series.map((s) => ({
          ...s,
          color: pie ? null : normalizeColor(s.color),
          chartType: canCombo && s.chartType && s.chartType !== form.variant.type ? s.chartType : null,
        })),
      },
      source ? { sheet: source.sheet, range: source.range } : null,
    );
  };

  const thumbData = data ?? SAMPLE_DATA;
  const axisLabels = isScatter
    ? { x: "Título del eje X", y: "Título del eje Y" }
    : { x: "Título del eje de categorías", y: "Título del eje de valores" };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        data-chart-ui=""
        className="max-h-[92vh] max-w-[880px] overflow-y-auto"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && canSubmit) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{isInsert ? "Insertar gráfico" : "Editar gráfico"}</DialogTitle>
          <DialogDescription>Elija el tipo de gráfico, los datos y los títulos.</DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label="Tipo de gráfico" className="grid grid-cols-7 gap-1.5">
          {CHART_VARIANTS.map((v) => {
            const active = v.id === form.variant.id;
            return (
              <button
                key={v.id}
                type="button"
                role="radio"
                aria-checked={active}
                title={v.label}
                onClick={() => setForm((f) => ({ ...f, variant: v, legend: isPieLike(v.type) && f.legend === "none" ? "bottom" : f.legend }))}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-md border p-1 text-[11px] leading-tight transition-colors",
                  active ? "border-brand bg-brand/10 ring-1 ring-brand" : "border-border hover:bg-accent",
                )}
              >
                <ChartPreview
                  look={{ type: v.type, grouping: v.grouping, title: null, legend: "none", xAxisTitle: null, yAxisTitle: null }}
                  data={retypeData(thumbData, v.type)}
                  width={92}
                  height={56}
                  compact
                  className="overflow-hidden rounded-sm"
                />
                <span className="line-clamp-2 h-7 text-center text-muted-foreground">{v.label}</span>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-[440px_1fr] gap-4">
          <div className="flex flex-col gap-2">
            <div className="overflow-hidden rounded-md border bg-white">
              <ChartPreview look={previewLook} data={data} width={438} height={270} />
            </div>
            {form.series.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No hay series numéricas en el rango. Seleccione celdas con números (y, opcionalmente, rótulos).
              </p>
            )}
          </div>

          <div className="flex flex-col gap-3 text-sm">
            {isInsert && (
              <div className="flex flex-col gap-1">
                <label htmlFor="chart-range" className="text-xs font-medium">
                  Rango de datos
                </label>
                <Input id="chart-range" value={rangeText} onChange={(e) => setRangeText(e.target.value)} spellCheck={false} />
                {rangeError && <p className="text-xs text-destructive">{rangeError}</p>}
                <div className="flex items-center gap-3 pt-1 text-xs" role="radiogroup" aria-label="Series en">
                  <span className="text-muted-foreground">Series en:</span>
                  {(["cols", "rows"] as const).map((o) => (
                    <label key={o} className="flex items-center gap-1">
                      <input type="radio" name="chart-orientation" checked={orientation === o} onChange={() => setOrientation(o)} />
                      {o === "cols" ? "Columnas" : "Filas"}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label htmlFor="chart-title" className="text-xs font-medium">
                Título del gráfico
              </label>
              <Input
                id="chart-title"
                value={form.title}
                placeholder={data?.series.length === 1 ? data.series[0].name : "Sin título"}
                onChange={(e) => {
                  setTitleTouched(true);
                  setForm((f) => ({ ...f, title: e.target.value }));
                }}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="chart-legend" className="text-xs font-medium">
                Leyenda
              </label>
              <select
                id="chart-legend"
                className={selectClass}
                value={form.legend}
                onChange={(e) => setForm((f) => ({ ...f, legend: e.target.value as ChartSpec["legend"] }))}
              >
                {LEGEND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {!pie && (
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor="chart-x-title" className="text-xs font-medium">
                    {axisLabels.x}
                  </label>
                  <Input id="chart-x-title" value={form.xAxisTitle} onChange={(e) => setForm((f) => ({ ...f, xAxisTitle: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="chart-y-title" className="text-xs font-medium">
                    {axisLabels.y}
                  </label>
                  <Input id="chart-y-title" value={form.yAxisTitle} onChange={(e) => setForm((f) => ({ ...f, yAxisTitle: e.target.value }))} />
                </div>
              </div>
            )}

            {form.series.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium">Series</span>
                <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-1">
                  {form.series.map((s, i) => {
                    const resolvedName = data?.series[i]?.name ?? s.name ?? `Serie${i + 1}`;
                    const color = normalizeColor(s.color) ?? paletteColor(i);
                    return (
                      <li key={i} className="flex items-center gap-1.5" title={s.valuesRef}>
                        {!pie && (
                          <input
                            type="color"
                            aria-label={`Color de ${resolvedName}`}
                            value={color.toLowerCase()}
                            onChange={(e) => updateSeries(i, { color: e.target.value.toUpperCase() })}
                            className="h-7 w-8 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
                          />
                        )}
                        <Input
                          aria-label={`Nombre de la serie ${i + 1}`}
                          value={s.nameRef ? resolvedName : (s.name ?? "")}
                          placeholder={`Serie${i + 1}`}
                          onChange={(e) => updateSeries(i, { nameRef: null, name: e.target.value || null })}
                          className="h-7"
                        />
                        {canCombo && form.series.length > 1 && (
                          <select
                            aria-label={`Tipo de la serie ${i + 1}`}
                            className={cn(selectClass, "h-7 w-36 shrink-0 text-xs")}
                            value={s.chartType && s.chartType !== form.variant.type ? s.chartType : ""}
                            onChange={(e) => updateSeries(i, { chartType: (e.target.value || null) as ChartType | null })}
                          >
                            {COMBO_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        )}
                        {!pie && s.color && (
                          <Button type="button" variant="ghost" size="sm" className="h-7 px-1.5" onClick={() => updateSeries(i, { color: null })}>
                            Auto
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit}>
            {isInsert ? "Insertar" : "Aceptar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
