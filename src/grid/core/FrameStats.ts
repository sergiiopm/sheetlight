export interface FrameSample {
  /** rAF timestamp. */
  readonly t: number;
  /** Main-thread time spent in the grid's frame callback (ms). */
  readonly totalMs: number;
  readonly baseMs: number;
  readonly overlayMs: number;
  /** Visible blocks not loaded yet when the frame was drawn. */
  readonly missingBlocks: number;
  readonly texts: number;
  readonly baseDrawn: boolean;
}

/** Rolling frame statistics for the HUD plus an optional full recording for benchmarks. */
export class FrameStats {
  private ring: FrameSample[] = [];
  private recording: FrameSample[] | null = null;
  private readonly ringSize = 120;

  record(s: FrameSample): void {
    if (this.ring.length >= this.ringSize) this.ring.shift();
    this.ring.push(s);
    this.recording?.push(s);
  }

  startRecording(): void {
    this.recording = [];
  }

  stopRecording(): FrameSample[] {
    const r = this.recording ?? [];
    this.recording = null;
    return r;
  }

  /** Average / max grid frame cost over the last ~120 rendered frames. */
  summary(): { avgMs: number; maxMs: number; frames: number } {
    const n = this.ring.length;
    if (n === 0) return { avgMs: 0, maxMs: 0, frames: 0 };
    let sum = 0;
    let max = 0;
    for (const s of this.ring) {
      sum += s.totalMs;
      if (s.totalMs > max) max = s.totalMs;
    }
    return { avgMs: sum / n, maxMs: max, frames: n };
  }
}
