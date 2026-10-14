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
