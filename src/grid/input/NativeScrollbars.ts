/**
 * Native scrollbars over a canvas grid. A transparent scroller element with a
 * spacer child provides OS scrollbars; the grid's scroll position (in zoomed
 * CSS px, "virtual") is the source of truth and is mapped onto the scroller.
 *
 * Chromium caps layout sizes at ~33.5M CSS px (LayoutUnit). An Excel sheet at
 * 200% zoom is ~42M px tall, so the native range is linearly scaled when the
 * virtual range exceeds CAP. Rendering never uses the native value directly,
 * so it stays pixel-exact; only thumb-drag granularity becomes ~ratio px.
 */
export const NATIVE_SCROLL_CAP = 30_000_000;

export class NativeScrollbars {
  private vMaxX = 0;
  private vMaxY = 0;
  private nMaxX = 0;
  private nMaxY = 0;
  private expectX = -1;
  private expectY = -1;
  private spacerW = -1;
  private spacerH = -1;

  constructor(
    private readonly scroller: HTMLElement,
    private readonly spacer: HTMLElement,
  ) {}

  /** Inner size (excluding scrollbars) of the scroller. */
  get clientWidth(): number {
    return this.scroller.clientWidth;
  }

  get clientHeight(): number {
    return this.scroller.clientHeight;
  }

  get ratioY(): number {
    return this.nMaxY > 0 ? this.vMaxY / this.nMaxY : 1;
  }

  /** Set the virtual scroll ranges (zoomed px). */
  setRange(vMaxX: number, vMaxY: number): void {
    const cw = this.scroller.clientWidth;
    const ch = this.scroller.clientHeight;
    this.vMaxX = vMaxX;
    this.vMaxY = vMaxY;
    this.nMaxX = Math.min(vMaxX, NATIVE_SCROLL_CAP);
    this.nMaxY = Math.min(vMaxY, NATIVE_SCROLL_CAP);
    // Compare numbers, not style strings: CSS serializes 3e7px in exponent form.
    const w = Math.ceil(cw + this.nMaxX);
    const h = Math.ceil(ch + this.nMaxY);
    if (w !== this.spacerW) {
      this.spacer.style.width = `${w}px`;
      this.spacerW = w;
    }
    if (h !== this.spacerH) {
      this.spacer.style.height = `${h}px`;
      this.spacerH = h;
    }
  }

  /** Push a virtual position to the native scroller (no-op if unchanged). */
  sync(vx: number, vy: number): void {
    const nx = this.vMaxX > 0 ? (vx * this.nMaxX) / this.vMaxX : 0;
    const ny = this.vMaxY > 0 ? (vy * this.nMaxY) / this.vMaxY : 0;
    if (Math.abs(this.scroller.scrollLeft - nx) >= 1) this.scroller.scrollLeft = nx;
    if (Math.abs(this.scroller.scrollTop - ny) >= 1) this.scroller.scrollTop = ny;
    // Record what the scroller shows now, including browser-side clamping after
    // a range change, so the resulting scroll event isn't mistaken for user input.
    this.expectX = this.scroller.scrollLeft;
    this.expectY = this.scroller.scrollTop;
  }

  /**
   * Called from the scroll event. Returns the virtual position if the user
   * moved the scrollbar, or null if this event is the echo of our own sync.
   */
  read(): { vx: number; vy: number; movedX: boolean; movedY: boolean } | null {
    const sl = this.scroller.scrollLeft;
    const st = this.scroller.scrollTop;
    const movedX = Math.abs(sl - this.expectX) >= 1;
    const movedY = Math.abs(st - this.expectY) >= 1;
    if (!movedX && !movedY) return null;
    this.expectX = sl;
    this.expectY = st;
    return {
      vx: this.nMaxX > 0 ? (sl * this.vMaxX) / this.nMaxX : 0,
      vy: this.nMaxY > 0 ? (st * this.vMaxY) / this.nMaxY : 0,
      movedX,
      movedY,
    };
  }
}
