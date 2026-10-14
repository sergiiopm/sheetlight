import { useSyncExternalStore } from "react";
import type { EditSession, EditState } from "@/editor/session";

/** Subscribes a component to the edit session state. */
export function useEditState(session: EditSession): EditState {
  return useSyncExternalStore(session.subscribe, session.getState, session.getState);
}

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Width in px of a single line of text in a CSS font (canvas measurement, no layout). */
export function measureTextWidth(text: string, font: string): number {
  if (measureCtx === undefined) {
    measureCtx = typeof document !== "undefined" ? (document.createElement("canvas").getContext("2d") ?? null) : null;
  }
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}
