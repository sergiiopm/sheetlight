import type { CellAddress, CellRange } from "@/engine/types";
import type { GridHandle, GridViewport, RefHighlight, ReferencePicker } from "@/grid/api";

/**
 * Test double for `GridHandle` (the real grid is WS1's). Records the calls the
 * editor makes and lets tests drive reference picking. Cells are 80x20 px.
 */
export class FakeGrid implements GridHandle {
  focused = 0;
  scrolledTo: CellAddress[] = [];
  highlights: ReadonlyArray<RefHighlight> = [];
  picker: ReferencePicker | null = null;
  viewport: GridViewport = { topLeft: { row: 0, col: 0 }, zoom: 1 };
  private readonly viewportListeners = new Set<(view: GridViewport) => void>();
  overlayHost: HTMLElement | null = null;

  focus(): void {
    this.focused += 1;
  }
  getCellRect(cell: CellAddress): DOMRect | null {
    const x = 40 + (cell.col - this.viewport.topLeft.col) * 80;
    const y = 20 + (cell.row - this.viewport.topLeft.row) * 20;
    if (x < 40 || y < 20) return null;
    return rect(x, y, 80, 20);
  }
  scrollIntoView(cell: CellAddress): void {
    this.scrolledTo.push(cell);
  }
  getViewport(): GridViewport {
    return this.viewport;
  }
  setZoom(zoom: number): void {
    this.viewport = { ...this.viewport, zoom };
    this.emitViewport();
  }
  setRefHighlights(highlights: ReadonlyArray<RefHighlight>): void {
    this.highlights = highlights;
  }
  setReferencePicker(picker: ReferencePicker | null): void {
    this.picker = picker;
  }
  setCopyMarquee(): void {}
  setCursorMode(): void {}
  async measureAutofit(cols: ReadonlyArray<number>): Promise<ReadonlyArray<number>> {
    return cols.map(() => 80);
  }
  getRangeRect(range: CellRange): DOMRect {
    return rect(range.c0 * 80, range.r0 * 20, (range.c1 - range.c0 + 1) * 80, (range.r1 - range.r0 + 1) * 20);
  }
  getOverlayHost(): HTMLElement {
    if (!this.overlayHost) throw new Error("no overlay host in tests");
    return this.overlayHost;
  }
  subscribeViewport(listener: (view: GridViewport) => void): () => void {
    this.viewportListeners.add(listener);
    return () => {
      this.viewportListeners.delete(listener);
    };
  }
  scrollTo(topLeft: CellAddress): void {
    this.viewport = { ...this.viewport, topLeft };
    this.emitViewport();
  }
  private emitViewport(): void {
    for (const l of this.viewportListeners) l(this.viewport);
  }
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({ x, y, width, height }),
  } as DOMRect;
}
