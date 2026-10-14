/**
 * Wheel / trackpad scrolling. Mouse-wheel notches (large integer deltas) are
 * animated toward a target with an exponential ease (~150 ms to settle, like
 * Chromium's own smooth scrolling); precise trackpad deltas are applied
 * immediately since the OS already delivers them smoothly.
 */
export interface ScrollTarget {
  getScroll(): { x: number; y: number };
  /** Set scroll in sheet units; returns the clamped value actually applied. */
  setScroll(x: number, y: number): { x: number; y: number };
  clampScroll(x: number, y: number): { x: number; y: number };
  readonly zoom: number;
  readonly lineHeight: number;
  readonly pageHeight: number;
}

const TAU_MS = 45;

export class SmoothScroller {
  private tx = 0;
  private ty = 0;
  private animating = false;
  private lastT = 0;

  constructor(private readonly target: ScrollTarget) {}

  get isAnimating(): boolean {
    return this.animating;
  }

  /** Forget any target (another input source moved the scroll position). */
  cancel(): void {
    this.animating = false;
  }

  /** Handle a wheel event (already preventDefault-ed by the caller). */
  onWheel(e: WheelEvent, now: number): void {
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= this.target.lineHeight;
      dy *= this.target.lineHeight;
    } else if (e.deltaMode === 2) {
      dx *= this.target.pageHeight;
      dy *= this.target.pageHeight;
    }
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    const z = this.target.zoom;
    const discrete =
      e.deltaMode !== 0 ||
      (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50) ||
      (Number.isInteger(e.deltaX) && Math.abs(e.deltaX) >= 50);
    if (!this.animating) {
      const cur = this.target.getScroll();
      this.tx = cur.x;
      this.ty = cur.y;
    }
    const t = this.target.clampScroll(this.tx + dx / z, this.ty + dy / z);
    this.tx = t.x;
    this.ty = t.y;
    if (discrete || this.animating) {
      if (!this.animating) this.lastT = now;
      this.animating = true;
    } else {
      this.target.setScroll(this.tx, this.ty);
    }
  }

  /** Advance the animation; returns true while still animating. */
  step(now: number): boolean {
    if (!this.animating) return false;
    const dt = Math.max(0, Math.min(64, now - this.lastT));
    this.lastT = now;
    const cur = this.target.getScroll();
    const k = 1 - Math.exp(-dt / TAU_MS);
    let nx = cur.x + (this.tx - cur.x) * k;
    let ny = cur.y + (this.ty - cur.y) * k;
    const eps = 0.5 / this.target.zoom;
    if (Math.abs(this.tx - nx) < eps) nx = this.tx;
    if (Math.abs(this.ty - ny) < eps) ny = this.ty;
    const applied = this.target.setScroll(nx, ny);
    // If clamped at an edge, collapse the target there.
    if (applied.x !== nx) this.tx = applied.x;
    if (applied.y !== ny) this.ty = applied.y;
    if (applied.x === this.tx && applied.y === this.ty) this.animating = false;
    return this.animating;
  }
}
