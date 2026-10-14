import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
import type { CellAddress, CellRange } from "@/engine/types";
import type { GridHandle, GridProps, GridViewport, RefHighlight, ReferencePicker } from "./api";
import { Grid } from "./core/Grid";

export interface SpreadsheetGridProps extends GridProps {
  readonly className?: string;
  readonly style?: CSSProperties;
}

const DEFAULT_VIEW: GridViewport = { topLeft: { row: 0, col: 0 }, zoom: 1 };

/**
 * React host of the canvas grid. React never re-renders on scroll or
 * selection: it mounts an imperative `Grid` (recreated when `engine`/`doc`
 * change; `sheet` switches reuse it) and forwards new props to it. The ref is
 * the public `GridHandle`.
 */
export const SpreadsheetGrid = forwardRef<GridHandle, SpreadsheetGridProps>(function SpreadsheetGrid(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<Grid | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const fallbackHost = useRef<HTMLDivElement | null>(null);
  const viewportListeners = useRef(new Set<(view: GridViewport) => void>());

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const grid = new Grid(host, propsRef.current);
    gridRef.current = grid;
    const unsubscribe = grid.subscribeViewport((view) => {
      for (const l of viewportListeners.current) l(view);
    });
    return () => {
      unsubscribe();
      grid.dispose();
      if (gridRef.current === grid) gridRef.current = null;
    };
  }, [props.engine, props.doc]);

  useLayoutEffect(() => {
    gridRef.current?.update(props);
  });

  useImperativeHandle(
    ref,
    (): GridHandle => ({
      focus: () => gridRef.current?.focus(),
      getCellRect: (cell: CellAddress) => gridRef.current?.getCellRect(cell) ?? null,
      scrollIntoView: (cell: CellAddress) => gridRef.current?.scrollIntoView(cell),
      getViewport: () => gridRef.current?.getViewport() ?? DEFAULT_VIEW,
      setZoom: (zoom: number) => gridRef.current?.setZoom(zoom),
      setRefHighlights: (h: ReadonlyArray<RefHighlight>) => gridRef.current?.setRefHighlights(h),
      setReferencePicker: (p: ReferencePicker | null) => gridRef.current?.setReferencePicker(p),
      setCopyMarquee: (r: CellRange | null) => gridRef.current?.setCopyMarquee(r),
      setCursorMode: (m: "default" | "formatPainter") => gridRef.current?.setCursorMode(m),
      measureAutofit: (cols: ReadonlyArray<number>) => gridRef.current?.measureAutofit(cols) ?? Promise.resolve(cols.map(() => 64)),
      getRangeRect: (r: CellRange) => gridRef.current?.getRangeRect(r) ?? new DOMRect(0, 0, 0, 0),
      getOverlayHost: () => gridRef.current?.getOverlayHost() ?? (fallbackHost.current ??= document.createElement("div")),
      subscribeViewport: (listener: (view: GridViewport) => void) => {
        // Kept here (not on the Grid) so subscriptions survive a grid recreation.
        viewportListeners.current.add(listener);
        return () => {
          viewportListeners.current.delete(listener);
        };
      },
    }),
    [],
  );

  return (
    <div
      ref={hostRef}
      className={props.className}
      style={{ position: "relative", overflow: "hidden", minWidth: 0, minHeight: 0, ...props.style }}
    />
  );
});

/**
 * Low-frequency viewport state (top-left cell, zoom) for chrome such as a
 * zoom slider, via `useSyncExternalStore`. Snapshots are cached so React
 * only re-renders when the value changes.
 */
export function useGridViewport(grid: GridHandle | null): GridViewport {
  const cache = useRef<GridViewport>(DEFAULT_VIEW);
  return useSyncExternalStore(
    (onChange) => (grid ? grid.subscribeViewport(onChange) : () => undefined),
    () => {
      if (!grid) return DEFAULT_VIEW;
      const v = grid.getViewport();
      const c = cache.current;
      if (c.zoom !== v.zoom || c.topLeft.row !== v.topLeft.row || c.topLeft.col !== v.topLeft.col) cache.current = v;
      return cache.current;
    },
  );
}
