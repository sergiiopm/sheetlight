/** A DPR-aware canvas whose backing store matches its CSS size in device pixels. */
export class CanvasLayer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  cssW = 0;
  cssH = 0;
  dpr = 1;

  constructor(parent: HTMLElement, opaque: boolean, className: string) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = className;
    const s = this.canvas.style;
    s.position = "absolute";
    s.left = "0";
    s.top = "0";
    s.pointerEvents = "none";
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d", { alpha: !opaque });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
  }

  get deviceW(): number {
    return this.canvas.width;
  }

  get deviceH(): number {
    return this.canvas.height;
  }

  /** Returns true when the backing store was resized (content lost). */
  resize(cssW: number, cssH: number, dpr: number): boolean {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${w / dpr}px`;
    this.canvas.style.height = `${h / dpr}px`;
    return true;
  }

  dispose(): void {
    this.canvas.remove();
  }
}
