import type { ChartSpec, ChartType } from "@/engine/contract";
import type { ChartData } from "@/charts/data";
import { paletteColor } from "@/charts/theme";

export type ChartGrouping = ChartSpec["grouping"];

/** One entry of the chart type gallery. */
export interface ChartVariant {
  readonly id: string;
  /** Spanish, user-facing. */
  readonly label: string;
  readonly type: ChartType;
  readonly grouping: ChartGrouping;
}

export const CHART_VARIANTS: ReadonlyArray<ChartVariant> = [
  { id: "column", label: "Columnas agrupadas", type: "column", grouping: "clustered" },
  { id: "column-stacked", label: "Columnas apiladas", type: "column", grouping: "stacked" },
  { id: "column-percent", label: "Columnas 100 % apiladas", type: "column", grouping: "percentStacked" },
  { id: "bar", label: "Barras agrupadas", type: "bar", grouping: "clustered" },
  { id: "bar-stacked", label: "Barras apiladas", type: "bar", grouping: "stacked" },
  { id: "bar-percent", label: "Barras 100 % apiladas", type: "bar", grouping: "percentStacked" },
  { id: "line", label: "Líneas", type: "line", grouping: "standard" },
  { id: "line-stacked", label: "Líneas apiladas", type: "line", grouping: "stacked" },
  { id: "area", label: "Áreas", type: "area", grouping: "standard" },
  { id: "area-stacked", label: "Áreas apiladas", type: "area", grouping: "stacked" },
  { id: "pie", label: "Circular", type: "pie", grouping: "standard" },
  { id: "doughnut", label: "Anillos", type: "doughnut", grouping: "standard" },
  { id: "scatter", label: "Dispersión", type: "scatter", grouping: "standard" },
];

/** Gallery entry matching a chart's type and grouping (falls back to the first of that type). */
export function variantOf(type: ChartType, grouping: ChartGrouping): ChartVariant {
  return (
    CHART_VARIANTS.find((v) => v.type === type && v.grouping === grouping) ??
    CHART_VARIANTS.find((v) => v.type === type) ??
    CHART_VARIANTS[0]
  );
}

export function isPieLike(type: ChartType): boolean {
  return type === "pie" || type === "doughnut";
}

/** Small fixed data set for gallery thumbnails when there is no data yet. */
export const SAMPLE_DATA: ChartData = {
  categories: ["1", "2", "3", "4"],
  series: [
    { name: "A", values: [4, 6, 3, 7], xValues: [1, 2, 3, 4], color: paletteColor(0), type: "column" },
    { name: "B", values: [3, 4, 5, 4], xValues: [1.5, 2.5, 3.2, 4.4], color: paletteColor(1), type: "column" },
  ],
};

/** Re-types resolved data for a preview of another chart type (thumbnails). */
export function retypeData(data: ChartData, type: ChartType): ChartData {
  return { categories: data.categories, series: data.series.map((s) => ({ ...s, type })) };
}
