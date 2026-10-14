/**
 * Charts (WS6): model, Canvas 2D renderer, chart layer over the grid,
 * create/edit dialog and commands. See `README.md` for integration.
 */
export { ChartLayer, type ChartLayerProps } from "@/charts/ChartLayer";
export {
  registerChartCommands,
  requestChartInsert,
  onChartInsertRequest,
  CHART_INSERT_COMMAND,
  type ChartCommandContext,
  type ChartInsertRequest,
} from "@/charts/commands";
export { ChartLayerController, type ChartLayerCallbacks, type ChartLayerOptions } from "@/charts/controller";
export { resolveChartData, chartDependencies, type ChartData, type SeriesData, type ChartLook } from "@/charts/data";
export { renderChart, layoutChart, type ChartContext2D, type ChartLayout } from "@/charts/render";
export { renderChartPng } from "@/charts/chart-canvas";
export { parseRef, formatRef, quoteSheetName, resolveRef } from "@/charts/refs";
export { inferSeries, currentRegion } from "@/charts/infer";
export { CHART_VARIANTS } from "@/charts/variants";
