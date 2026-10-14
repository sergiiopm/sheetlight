import type { ChartContext2D } from "@/charts/render";

export interface DrawCall {
  readonly op: string;
  readonly args: ReadonlyArray<unknown>;
  readonly fillStyle: string;
  readonly strokeStyle: string;
  readonly font: string;
  readonly textAlign: string;
}

/**
 * Minimal recording 2D context for headless renderer tests. Text width is
 * approximated as 0.5 em per character, which is close to Calibri's average.
 */
export class FakeContext implements ChartContext2D {
  calls: DrawCall[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = "#000000";
  strokeStyle: string | CanvasGradient | CanvasPattern = "#000000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign: CanvasTextAlign = "start";
  textBaseline: CanvasTextBaseline = "alphabetic";
  lineJoin: CanvasLineJoin = "miter";
  lineCap: CanvasLineCap = "butt";
  private stack: Array<Pick<FakeContext, "fillStyle" | "strokeStyle" | "lineWidth" | "font" | "textAlign" | "textBaseline">> = [];

  private record(op: string, args: unknown[]) {
    this.calls.push({
      op,
      args,
      fillStyle: String(this.fillStyle),
      strokeStyle: String(this.strokeStyle),
      font: this.font,
      textAlign: this.textAlign,
    });
  }

  fontSize(): number {
    const m = /([\d.]+)px/.exec(this.font);
    return m ? Number(m[1]) : 10;
  }

  save() {
    this.stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
    });
  }
  restore() {
    const s = this.stack.pop();
    if (s) Object.assign(this, s);
  }
  beginPath() {
    this.record("beginPath", []);
  }
  closePath() {}
  moveTo(x: number, y: number) {
    this.record("moveTo", [x, y]);
  }
  lineTo(x: number, y: number) {
    this.record("lineTo", [x, y]);
  }
  arc(...args: number[]) {
    this.record("arc", args);
  }
  rect(...args: number[]) {
    this.record("rect", args);
  }
  fill() {
    this.record("fill", []);
  }
  stroke() {
    this.record("stroke", []);
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.record("fillRect", [x, y, w, h]);
  }
  strokeRect(x: number, y: number, w: number, h: number) {
    this.record("strokeRect", [x, y, w, h]);
  }
  fillText(text: string, x: number, y: number) {
    this.record("fillText", [text, x, y]);
  }
  measureText(text: string): TextMetrics {
    return { width: text.length * this.fontSize() * 0.5 } as TextMetrics;
  }
  translate(x: number, y: number) {
    this.record("translate", [x, y]);
  }
  rotate(a: number) {
    this.record("rotate", [a]);
  }
  clip() {}
  setLineDash() {}

  texts(): string[] {
    return this.calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
  }

  rects(color?: string): Array<[number, number, number, number]> {
    return this.calls
      .filter((c) => c.op === "fillRect" && (!color || c.fillStyle === color))
      .map((c) => c.args as [number, number, number, number]);
  }
}
