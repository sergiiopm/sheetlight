export interface FontMetrics {
  /** Ascent / descent in device px (fontBoundingBox). */
  readonly ascent: number;
  readonly descent: number;
  /** Upper bound of a single glyph advance, used to skip measuring short strings. */
  readonly maxCharW: number;
  readonly hashW: number;
}

/**
 * Cached text measurement. Widths are cached per exact CSS font string (which
 * already includes the device-pixel size), so a zoom/DPR change naturally
 * starts a new cache; the old ones are dropped by `clear()`.
 */
export class TextMeasurer {
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly widths = new Map<string, Map<string, number>>();
  private readonly metrics = new Map<string, FontMetrics>();
  /** font -> max width (device px) -> text -> lines. Nested maps: no key strings per lookup. */
  private readonly wraps = new Map<string, Map<number, Map<string, string[]>>>();
  private wrapEntries = 0;
  private entries = 0;
  private currentFont = "";
  hits = 0;
  misses = 0;

  constructor(private readonly maxEntries = 200_000) {
    const ctx = new OffscreenCanvas(1, 1).getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
  }

  private setFont(font: string): void {
    if (this.currentFont !== font) {
      this.ctx.font = font;
      this.currentFont = font;
    }
  }

  measure(font: string, text: string): number {
    let m = this.widths.get(font);
    if (!m) this.widths.set(font, (m = new Map()));
    const w = m.get(text);
    if (w !== undefined) {
      this.hits++;
      return w;
    }
    this.misses++;
    if (this.entries >= this.maxEntries) this.clear();
    this.setFont(font);
    const width = this.ctx.measureText(text).width;
    m.set(text, width);
    this.entries++;
    return width;
  }

  fontMetrics(font: string): FontMetrics {
    let fm = this.metrics.get(font);
    if (fm) return fm;
    this.setFont(font);
    const tm = this.ctx.measureText("Hgjy");
    let maxCharW = 0;
    for (const ch of ["W", "M", "@", "%", "m", "—"]) maxCharW = Math.max(maxCharW, this.ctx.measureText(ch).width);
    fm = {
      ascent: tm.fontBoundingBoxAscent,
      descent: tm.fontBoundingBoxDescent,
      maxCharW,
      hashW: this.ctx.measureText("#").width,
    };
    this.metrics.set(font, fm);
    return fm;
  }

  /** Greedy word wrap into lines no wider than `maxWidth` (device px). Cached. */
  wrap(font: string, text: string, maxWidth: number): string[] {
    const w = Math.round(maxWidth);
    let byWidth = this.wraps.get(font);
    if (!byWidth) this.wraps.set(font, (byWidth = new Map()));
    let byText = byWidth.get(w);
    if (!byText) byWidth.set(w, (byText = new Map()));
    const cached = byText.get(text);
    if (cached) return cached;
    const lines: string[] = [];
    for (const para of text.split("\n")) {
      const words = para.split(" ");
      let line = "";
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && this.measure(font, candidate) > maxWidth) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    if (++this.wrapEntries > 5000) {
      this.wraps.clear();
      this.wrapEntries = 0;
    }
    let fresh = this.wraps.get(font);
    if (!fresh) this.wraps.set(font, (fresh = new Map()));
    let fw = fresh.get(w);
    if (!fw) fresh.set(w, (fw = new Map()));
    fw.set(text, lines);
    return lines;
  }

  clear(): void {
    this.widths.clear();
    this.wraps.clear();
    this.wrapEntries = 0;
    this.entries = 0;
  }

  get size(): number {
    return this.entries;
  }
}
