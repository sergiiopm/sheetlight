import type { PasteMode, PasteSource } from "@/engine/contract";
import type { CellRange, DocumentId, SheetId } from "@/engine/types";
import { createStore, type Store } from "@/hooks/store";

/**
 * Clipboard flow (Excel semantics):
 * - copy/cut: `engine.copy` -> text + HTML to the system clipboard; the clip
 *   id and range are remembered for the marching-ants marquee and for cut;
 * - paste: if the system clipboard still holds our last copy, paste the
 *   internal clip (keeps formulas and formats), else HTML (Excel, Google
 *   Sheets, LibreOffice tables), else plain text;
 * - a cut is consumed by its first paste; Esc clears the marquee.
 */

export interface ClipboardContents {
  readonly text: string | null;
  readonly html: string | null;
}

export interface SystemClipboard {
  write(text: string, html: string): Promise<void>;
  /** Throws or returns nulls when reading is not permitted. */
  read(): Promise<ClipboardContents>;
}

export interface InternalClip {
  readonly sessionId: string;
  readonly doc: DocumentId;
  readonly sheet: SheetId;
  readonly range: CellRange;
  readonly clipId: number;
  readonly cut: boolean;
  /** Text we put on the system clipboard, to recognise our own copy later. */
  readonly text: string;
}

/** Line endings and the trailing newline differ between apps; compare without them. */
export function normalizeClipText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/** Decides what a paste uses. `contents` null = system clipboard unreadable. */
export function choosePasteSource(clip: InternalClip | null, contents: ClipboardContents | null): PasteSource | null {
  const text = contents?.text ?? null;
  const html = contents?.html ?? null;
  const ours = clip && (text === null ? html === null : normalizeClipText(text) === normalizeClipText(clip.text));
  if (clip && ours) return { kind: "internal", clipId: clip.clipId, cut: clip.cut };
  if (html && /<table/i.test(html)) return { kind: "html", html };
  if (text !== null && text !== "") return { kind: "text", text };
  if (html) return { kind: "html", html };
  return null;
}

/** Modes that only make sense with our own clip (formats/formulas come from the engine). */
export function pasteModeNeedsInternal(mode: PasteMode): boolean {
  return mode === "formats" || mode === "formulas";
}

export class ClipboardState {
  readonly clip: Store<InternalClip | null> = createStore<InternalClip | null>(null);

  constructor(readonly system: SystemClipboard) {}

  remember(clip: InternalClip): void {
    this.clip.set(clip);
  }

  clear(): void {
    this.clip.set(null);
  }

  /** Marquee range for a given session/sheet, or null. */
  marqueeFor(sessionId: string, sheet: SheetId): CellRange | null {
    const clip = this.clip.get();
    return clip && clip.sessionId === sessionId && clip.sheet === sheet ? clip.range : null;
  }
}

/** System clipboard through the async Clipboard API (WebView2 / Chromium). */
export const browserClipboard: SystemClipboard = {
  async write(text, html) {
    const clipboard = navigator.clipboard;
    if (clipboard && typeof ClipboardItem !== "undefined" && clipboard.write) {
      try {
        await clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
        return;
      } catch {
        // Fall back to plain text below.
      }
    }
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return;
    }
    legacyCopy(text);
  },
  async read() {
    const clipboard = navigator.clipboard;
    if (clipboard?.read) {
      try {
        const items = await clipboard.read();
        let text: string | null = null;
        let html: string | null = null;
        for (const item of items) {
          if (html === null && item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
          if (text === null && item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
        }
        return { text, html };
      } catch {
        // Permission denied or unsupported: try text only.
      }
    }
    if (clipboard?.readText) return { text: await clipboard.readText(), html: null };
    throw new Error("No se puede leer el portapapeles.");
  },
};

function legacyCopy(text: string): void {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

/** Clipboard contents of a DOM `paste` event (no permission prompt needed). */
export function contentsFromDataTransfer(data: DataTransfer | null): ClipboardContents | null {
  if (!data) return null;
  const html = data.getData("text/html");
  const text = data.getData("text/plain");
  return { text: text || null, html: html || null };
}
