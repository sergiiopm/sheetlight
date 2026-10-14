import type { WorkbookEngine } from "@/engine/contract";
import { isTauri } from "@/lib/is-tauri";

let engine: Promise<WorkbookEngine> | null = null;

/**
 * The app-wide engine: native (`TauriEngine`) inside the desktop app, the
 * in-memory fake in a plain browser (`npm run dev`, UI work without Rust).
 */
export function getEngine(): Promise<WorkbookEngine> {
  engine ??= isTauri()
    ? import("@/engine/tauri-engine").then(({ TauriEngine }) => new TauriEngine())
    : import("@/engine/memory-engine").then(({ MemoryEngine }) => new MemoryEngine());
  return engine;
}
