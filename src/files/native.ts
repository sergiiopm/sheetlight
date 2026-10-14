import { OPEN_FILTERS, SAVE_FILTERS } from "@/files/types";

// File bytes cross the Tauri IPC boundary as raw binary (no base64): reads come
// back as an ArrayBuffer (`tauri::ipc::Response`), writes send the bytes as the
// raw request body with the target path in a header. Workbooks themselves are
// opened and saved by path inside the engine; these helpers are for small
// side files (imports, exports, previews).

export async function readPathBytes(path: string): Promise<Uint8Array> {
  const { invoke } = await import("@tauri-apps/api/core");
  const buffer = await invoke<ArrayBuffer>("read_file_bytes", { path });
  return new Uint8Array(buffer);
}

/** Writes atomically (temp file + rename); the original survives a failed write. */
export async function writePathBytes(path: string, bytes: Uint8Array): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_file_bytes", bytes, { headers: { path: encodeURIComponent(path) } });
}

export async function pickOpenPaths(): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: "Abrir libros",
    multiple: true,
    filters: OPEN_FILTERS,
  });

  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export async function pickSavePath(defaultPath: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const selected = await save({
    title: "Guardar libro",
    defaultPath,
    filters: SAVE_FILTERS,
  });

  return selected ?? null;
}

export function downloadBytes(fileName: string, bytes: Uint8Array) {
  const blob = new Blob([bytes.slice().buffer]);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function pickBrowserFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".xlsx,.xlsm,.xls,.csv,text/csv";
    input.addEventListener("change", () => {
      resolve(Array.from(input.files ?? []));
    }, { once: true });
    input.click();
  });
}
