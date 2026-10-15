import type { ChartData, ChartLook } from "@/charts/data";
import { renderChart, type RenderOptions } from "@/charts/render";

const EMPTY: ChartData = { categories: [], series: [] };

/**
 * A canvas that draws one chart at device-pixel resolution. Re-renders only
 * when the size, zoom or content changed, at most once per animation frame.
 */
export class ChartCanvas {
  readonly canvas: HTMLCanvasElement;
  private look: ChartLook | null = null;
  private data: ChartData | null = null;
  private cssW = 0;
  private cssH = 0;
  private zoom = 1;
  private dpr = 1;
  private frame = 0;
  private drawnKey = "";

  constructor(private readonly options: RenderOptions = {}) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
  }

  /** `width`/`height`: on-screen CSS px (already zoomed); `zoom` scales fonts and strokes. */
  setSize(width: number, height: number, zoom: number): void {
    if (width === this.cssW && height === this.cssH && zoom === this.zoom) return;
    this.cssW = width;
    this.cssH = height;
    this.zoom = zoom;
    this.schedule();
  }

  setContent(look: ChartLook, data: ChartData | null): void {
    this.look = look;
    this.data = data;
    this.drawnKey = "";
    this.schedule();
  }

  /** Draws synchronously (e.g. before taking a snapshot). */
  flush(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.draw();
  }

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    this.dpr = window.devicePixelRatio || 1;
    const key = `${this.cssW}x${this.cssH}@${this.zoom}/${this.dpr}`;
    if (key === this.drawnKey || !this.look || this.cssW <= 0 || this.cssH <= 0) return;
    this.drawnKey = key;
    const pw = Math.max(1, Math.round(this.cssW * this.dpr));
    const ph = Math.max(1, Math.round(this.cssH * this.dpr));
    if (this.canvas.width !== pw) this.canvas.width = pw;
    if (this.canvas.height !== ph) this.canvas.height = ph;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const scale = this.dpr * this.zoom;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    renderChart(ctx, this.cssW / this.zoom, this.cssH / this.zoom, this.look, this.data ?? EMPTY, this.options);
  }
}

/** Renders a chart off-screen to PNG (for "Copiar como imagen"). */
export function renderChartPng(look: ChartLook, data: ChartData, width: number, height: number, scale = 2): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  renderChart(ctx, width, height, look, data);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}
