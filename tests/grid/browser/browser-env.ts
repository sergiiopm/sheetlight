import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import type { ViteDevServer } from "vite";

/**
 * Headless Chromium + Vite dev server for the grid browser tests. Tests are
 * skipped (not failed) when no Chromium build is available: never run
 * `playwright install` for them; set `PLAYWRIGHT_BROWSERS_PATH` or
 * `SHEETLIGHT_CHROMIUM` instead.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");

function candidates(): string[] {
  const out: string[] = [];
  const explicit = process.env.SHEETLIGHT_CHROMIUM;
  if (explicit) out.push(explicit);
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter((r): r is string => !!r);
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries.sort().reverse()) {
      if (e.startsWith("chromium_headless_shell-")) {
        out.push(path.join(root, e, "chrome-linux", "headless_shell"), path.join(root, e, "chrome-win", "headless_shell.exe"));
      } else if (e.startsWith("chromium-")) {
        out.push(path.join(root, e, "chrome-linux", "chrome"), path.join(root, e, "chrome-win", "chrome.exe"));
      }
    }
  }
  return out;
}

export function findChromium(): string | null {
  for (const c of candidates()) if (fs.existsSync(c)) return c;
  return null;
}

export const chromiumPath = findChromium();

export interface BrowserEnv {
  readonly browser: Browser;
  readonly baseUrl: string;
  close(): Promise<void>;
}

export async function startBrowserEnv(executablePath: string): Promise<BrowserEnv> {
  const { createServer } = await import("vite");
  const { chromium } = await import("playwright");
  const server: ViteDevServer = await createServer({
    configFile: false,
    root: here,
    logLevel: "error",
    resolve: { alias: { "@": path.join(repo, "src") } },
    server: { port: 0, host: "127.0.0.1", strictPort: false, fs: { allow: [repo] }, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  const addr = server.httpServer?.address();
  if (!addr || typeof addr === "string") throw new Error("vite server has no port");
  // Software raster: GPU text rasterization is not bit-stable across repaints
  // (Windows/Edge), which would make the blit pixel test flaky.
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--font-render-hinting=none", "--disable-lcd-text", "--disable-gpu"] });
  return {
    browser,
    baseUrl: `http://127.0.0.1:${addr.port}/index.html`,
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

/** New page at the given device scale factor with the harness loaded. */
export async function openHarness(env: BrowserEnv, deviceScaleFactor = 1, size = { width: 900, height: 600 }): Promise<Page> {
  const context = await env.browser.newContext({ deviceScaleFactor, viewport: size });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(env.baseUrl);
  await page.waitForFunction(() => document.title === "ready", undefined, { timeout: 30_000 });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return page;
}
