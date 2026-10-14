import type { SaveFormat } from "@/engine/contract";
import { isTauri } from "@/lib/is-tauri";

/**
 * File pickers the session manager needs, behind an interface so tests can
 * stub them. File bytes never cross into the webview in the desktop app: the
 * engine opens and saves by path.
 */
export interface PickedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface FileGateway {
  /** True in the desktop app (paths), false in a plain browser (bytes). */
  readonly native: boolean;
  pickOpenPaths(): Promise<string[]>;
  pickBrowserFiles(): Promise<PickedFile[]>;
  pickSavePath(suggestedName: string, format: SaveFormat): Promise<string | null>;
}

export function createFileGateway(): FileGateway {
  const native = isTauri();
  return {
    native,
    async pickOpenPaths() {
      const { pickOpenPaths } = await import("@/files/native");
      return pickOpenPaths();
    },
    async pickBrowserFiles() {
      const { pickBrowserFiles } = await import("@/files/native");
      const files = await pickBrowserFiles();
      return Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
    },
    async pickSavePath(suggestedName) {
      const { pickSavePath } = await import("@/files/native");
      return pickSavePath(suggestedName);
    },
  };
}
