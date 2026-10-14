import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromiumPath, openHarness, startBrowserEnv, type BrowserEnv } from "./browser-env";

/**
 * Smoke benchmark of the scroll path on a 1M-row sheet in headless Chromium
 * (software raster, so absolute numbers are pessimistic compared with
 * WebView2 on a GPU). Guards against regressions that make scroll frames
 * blow the 60 fps budget or show placeholders during smooth scrolling.
 */
describe.skipIf(!chromiumPath)("grid scroll performance (headless Chromium)", () => {
  let env: BrowserEnv;
  let page: Page;

  beforeAll(async () => {
    env = await startBrowserEnv(chromiumPath as string);
    page = await openHarness(env, 1, { width: 1600, height: 900 });
  }, 60_000);

  afterAll(async () => {
    await env?.close();
  });

  async function run(incremental: boolean, dx: number, dy: number) {
    return page.evaluate(
      async ({ incremental, dx, dy }) => {
        await window.SL.mount({ width: 1580, height: 880, rows: 1_000_000, cols: 30, latencyMs: 2, incremental });
        const g = window.SL.grid;
        if (!g) throw new Error("no grid");
        g.scheduler.stats.startRecording();
        for (let i = 0; i < 240; i++) {
          const s = g.viewport.getScroll();
          g.viewport.setScroll(s.x + dx, s.y + dy);
          await new Promise((res) => requestAnimationFrame(res));
        }
        const rec = g.scheduler.stats.stopRecording().filter((f) => f.baseDrawn);
        const ms = rec.map((f) => f.totalMs).sort((a, b) => a - b);
        return {
          frames: rec.length,
          avg: ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length),
          p95: ms[Math.floor(ms.length * 0.95)] ?? 0,
          placeholders: rec.filter((f) => f.missingBlocks > 0).length,
        };
      },
      { incremental, dx, dy },
    );
  }

  it("vertical smooth scroll: incremental frames are cheap and fully loaded", async () => {
    const inc = await run(true, 0, 37);
    const full = await run(false, 0, 37);
    process.stderr.write(`[grid perf] vertical incremental ${JSON.stringify(inc)} full ${JSON.stringify(full)}\n`);
    expect(inc.frames).toBeGreaterThan(200);
    expect(inc.avg).toBeLessThan(full.avg);
    expect(inc.p95).toBeLessThan(16);
    // Prefetch keeps one screen ahead: at most the first frames wait for data.
    expect(inc.placeholders).toBeLessThan(5);
  }, 120_000);

  it("diagonal scroll stays within budget", async () => {
    const inc = await run(true, 9, 23);
    process.stderr.write(`[grid perf] diagonal incremental ${JSON.stringify(inc)}\n`);
    // Two blits per frame; software raster in CI is slow at this, so allow two frames.
    expect(inc.p95).toBeLessThan(33);
  }, 120_000);
});
