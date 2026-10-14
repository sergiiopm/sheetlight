import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromiumPath, openHarness, startBrowserEnv, type BrowserEnv } from "./browser-env";

/**
 * Pixel-exactness guard of the incremental renderer: after a sequence of
 * scrolls (blit + exposed strips + rows of late-arriving blocks), the cell
 * layer must be bit-identical to a full redraw of the same state, at several
 * device pixel ratios, zoom levels and with/without frozen panes.
 */
describe.skipIf(!chromiumPath)("grid blit (headless Chromium)", () => {
  let env: BrowserEnv;
  const pages = new Map<number, Page>();

  beforeAll(async () => {
    env = await startBrowserEnv(chromiumPath as string);
  }, 60_000);

  afterAll(async () => {
    await env?.close();
  });

  async function page(dpr: number): Promise<Page> {
    let p = pages.get(dpr);
    if (!p) {
      p = await openHarness(env, dpr);
      pages.set(dpr, p);
    }
    return p;
  }

  const STEPS: ReadonlyArray<readonly [number, number]> = [
    [0, 7],
    [0, 13],
    [0, -5],
    [11, 0],
    [-3, 0],
    [9, 21],
    [0, 3.3],
    [17.7, -2.2],
    [0, 900],
    [400, 0],
    [-1, -1],
  ];

  for (const dpr of [1, 1.5, 2]) {
    for (const zoom of [0.5, 1, 1.25]) {
      for (const frozen of [false, true]) {
        it(`dpr ${dpr}, zoom ${zoom * 100}%, frozen ${frozen ? "on" : "off"}`, async () => {
          const p = await page(dpr);
          await p.evaluate(
            async ({ zoom, frozen }) => {
              await window.SL.mount({ width: 760, height: 460, zoom, frozenRows: frozen ? 2 : 0, frozenCols: frozen ? 1 : 0, latencyMs: 4 });
            },
            { zoom, frozen },
          );
          for (const [dx, dy] of STEPS) {
            await p.evaluate(([dx, dy]) => window.SL.scrollBy(dx, dy), [dx, dy] as const);
          }
          const r = await p.evaluate(() => window.SL.diffAgainstFullRedraw());
          expect(r.incremental).toBeGreaterThan(0);
          expect(r.box).toBeNull();
          expect(r.differing).toBe(0);
        }, 60_000);
      }
    }
  }

  it("detects a deliberate off-by-one (the comparison is not vacuous)", async () => {
    const p = await page(1);
    await p.evaluate(() => window.SL.mount({ width: 600, height: 400 }));
    const differing = await p.evaluate(async () => {
      const canvas = document.querySelector<HTMLCanvasElement>("canvas.sl-grid-base");
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return -1;
      // Shift the whole cell layer one device pixel: what a rounding bug would do.
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 1, canvas.width, canvas.height);
      return (await window.SL.diffAgainstFullRedraw()).differing;
    });
    expect(differing).toBeGreaterThan(1000);
  }, 60_000);
});
