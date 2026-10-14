import type { DocumentInfo, OpenOptions } from "@/engine/contract";
import { MemoryEngine } from "@/engine/memory-engine";
import type { FileGateway, PickedFile } from "@/hooks/file-gateway";
import { SessionManager, type SessionManagerHooks } from "@/hooks/session-manager";

/** MemoryEngine that can "open" paths: `.csv` paths get the given contents. */
export class PathMemoryEngine extends MemoryEngine {
  readonly files = new Map<string, string>();
  readonly opened: Array<{ path: string; options?: OpenOptions }> = [];
  readonly saved: Array<{ path: string; format: string }> = [];

  override async openDocument(path: string, options?: OpenOptions): Promise<DocumentInfo> {
    this.opened.push({ path, options });
    const text = this.files.get(path) ?? "";
    const info = await this.openBytes(path.replace(/\.xlsx?$/i, ".csv"), new TextEncoder().encode(text));
    return { ...info, path, sourceFormat: path.toLowerCase().endsWith(".xls") ? "xls" : info.sourceFormat };
  }

  override async saveDocument(...args: Parameters<MemoryEngine["saveDocument"]>) {
    this.saved.push({ path: args[1], format: args[2].format });
    return super.saveDocument(...args);
  }
}

export interface TestGateway extends FileGateway {
  openPaths: string[];
  savePath: string | null;
  browserFiles: PickedFile[];
}

export function testGateway(native = true): TestGateway {
  const gateway: TestGateway = {
    native,
    openPaths: [],
    savePath: null,
    browserFiles: [],
    pickOpenPaths: async () => gateway.openPaths,
    pickBrowserFiles: async () => gateway.browserFiles,
    pickSavePath: async () => gateway.savePath,
  };
  return gateway;
}

export interface TestHooks extends SessionManagerHooks {
  errors: string[];
  infos: string[];
  used: string[];
  destroyed: number;
}

export function testHooks(): TestHooks {
  const hooks: TestHooks = {
    errors: [],
    infos: [],
    used: [],
    destroyed: 0,
    onError: (message) => hooks.errors.push(message),
    onInfo: (message) => hooks.infos.push(message),
    onPathUsed: (path) => hooks.used.push(path),
    destroyWindow: async () => {
      hooks.destroyed += 1;
    },
  };
  return hooks;
}

export async function setup(native = true) {
  const engine = new PathMemoryEngine();
  const files = testGateway(native);
  const hooks = testHooks();
  const manager = new SessionManager(engine, files, hooks);
  await manager.ensureOne();
  return { engine, files, hooks, manager };
}

// ---------------------------------------------------------------------------
// Controller harness
// ---------------------------------------------------------------------------

import type { ApplyResult, EngineOp } from "@/engine/contract";
import type { DocumentId } from "@/engine/types";
import { AppController } from "@/hooks/app-controller";
import { registerShellCommands } from "@/hooks/app-commands";
import type { ClipboardContents, SystemClipboard } from "@/hooks/clipboard";
import { createSettingsStore } from "@/lib/settings";

/** Op types the memory fake cannot run: recorded and acknowledged with a synthetic result. */
const FAKED = new Set(["sort", "paste", "setAutoFilter", "filterColumn", "replace", "copyFormat", "setBorders", "insertCells", "deleteCells"]);

export class RecordingEngine extends PathMemoryEngine {
  readonly batches: EngineOp[][] = [];
  nextResult: Partial<ApplyResult> = {};

  override async apply(doc: DocumentId, ops: ReadonlyArray<EngineOp>): Promise<ApplyResult> {
    this.batches.push([...ops]);
    const extra = this.nextResult;
    this.nextResult = {};
    if (ops.some((op) => FAKED.has(op.type))) {
      return { dirty: true, canUndo: true, canRedo: false, selection: null, created: [], affected: 3, elapsedMs: 0, ...extra };
    }
    return { ...(await super.apply(doc, ops)), ...extra };
  }

  lastOps(): EngineOp[] {
    return this.batches[this.batches.length - 1] ?? [];
  }
}

export function stubClipboard(): SystemClipboard & { written: Array<{ text: string; html: string }>; contents: ClipboardContents | null } {
  const stub = {
    written: [] as Array<{ text: string; html: string }>,
    contents: null as ClipboardContents | null,
    async write(text: string, html: string) {
      stub.written.push({ text, html });
      stub.contents = { text, html };
    },
    async read() {
      if (!stub.contents) throw new Error("denied");
      return stub.contents;
    },
  };
  return stub;
}

export async function controllerSetup() {
  const engine = new RecordingEngine();
  const clipboard = stubClipboard();
  const memory = new Map<string, string>();
  const settings = createSettingsStore({ getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v) });
  const files = testGateway(true);
  const controller = new AppController({ engine, files, clipboard, settings, refreshDelayMs: 0, pasteFallbackMs: 0 });
  registerShellCommands(controller);
  await controller.manager.ensureOne();
  await controller.refresh();
  const session = controller.session!;
  return { engine, clipboard, settings, files, controller, session };
}
