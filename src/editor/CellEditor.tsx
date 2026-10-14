import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { CellStyle } from "@/engine/contract";
import type { GridHandle } from "@/grid/api";
import { EditErrorDialog, EditorPopups } from "@/editor/EditorPopups";
import { EditorTextarea, type EditorTextareaHandle } from "@/editor/EditorTextarea";
import type { EditSession } from "@/editor/session";
import { measureTextWidth, useEditState } from "@/editor/use-edit-session";

/** Grid default font (keep in sync with the grid renderer's default style). */
export const DEFAULT_CELL_FONT_FAMILY = 'Calibri, Carlito, "Segoe UI", sans-serif';
export const DEFAULT_CELL_FONT_SIZE_PT = 11;

export interface CellEditorProps {
  readonly session: EditSession;
  readonly grid: GridHandle | null;
  readonly defaultFontFamily?: string;
  readonly defaultFontSizePt?: number;
}

const PAD_X = 3;
const PAD_Y = 1;

/**
 * In-cell editor: a textarea overlay on top of the edited cell, matching
 * its font, alignment and zoom. It grows to the right (or left/both ways for
 * right/center aligned cells) as the text gets longer, and downwards for
 * wrapped text or Alt+Enter line breaks. Follows the grid on scroll/zoom.
 * Rendered in a portal with fixed positioning (`GridHandle.getCellRect`
 * returns client coordinates).
 */
export function CellEditor({ session, grid, defaultFontFamily = DEFAULT_CELL_FONT_FAMILY, defaultFontSizePt = DEFAULT_CELL_FONT_SIZE_PT }: CellEditorProps) {
  const state = useEditState(session);
  const editing = state.status === "editing" && state.cell !== null;
  const textareaRef = useRef<EditorTextareaHandle | null>(null);
  const [viewTick, setViewTick] = useState(0);

  useEffect(() => {
    if (!editing || !grid) return;
    return grid.subscribeViewport(() => setViewTick((t) => t + 1));
  }, [editing, grid]);

  useEffect(() => {
    if (!editing) return;
    const onResize = () => setViewTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [editing]);

  const cell = state.cell;
  const merge = state.details?.merge ?? null;
  const cellRect = useMemo(() => {
    if (!editing || !grid || !cell) return null;
    const first = grid.getCellRect(merge ? { row: merge.r0, col: merge.c0 } : cell);
    if (!first) return null;
    if (!merge || (merge.r0 === merge.r1 && merge.c0 === merge.c1)) return first;
    const last = grid.getCellRect({ row: merge.r1, col: merge.c1 });
    if (!last) return first;
    return new DOMRect(first.left, first.top, last.right - first.left, last.bottom - first.top);
    // viewTick: recompute after scroll/zoom/resize
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, grid, cell, merge, viewTick]);

  // Typing into a cell scrolled out of view brings it back (Excel).
  const textForScroll = state.text;
  useEffect(() => {
    if (editing && !cellRect && grid && cell && state.surface === "cell") grid.scrollIntoView(cell);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textForScroll]);

  const style: CellStyle = state.details?.format.style ?? {};
  const zoom = grid?.getViewport().zoom ?? 1;
  const fontSizePx = ((style.fontSize ?? defaultFontSizePt) * 96) / 72 * zoom;
  const fontFamily = style.fontFamily ? `"${style.fontFamily}", ${defaultFontFamily}` : defaultFontFamily;
  const font = `${style.italic ? "italic " : ""}${style.bold ? "700 " : "400 "}${fontSizePx}px ${fontFamily}`;
  const lineHeight = Math.round(fontSizePx * 1.25);
  const wrap = style.wrap === true;

  const layout = useMemo(() => {
    if (!cellRect) return null;
    const lines = (state.text + state.suggestion).split("\n");
    const viewportW = typeof window !== "undefined" ? window.innerWidth : 4000;
    const viewportH = typeof window !== "undefined" ? window.innerHeight : 4000;
    let width = cellRect.width;
    if (!wrap) {
      const textW = Math.max(...lines.map((l) => measureTextWidth(l, font))) + PAD_X * 2 + fontSizePx;
      width = Math.max(cellRect.width, Math.ceil(textW));
    }
    const align = style.hAlign;
    let left = cellRect.left;
    if (!wrap && width > cellRect.width) {
      if (align === "right") left = cellRect.right - width;
      else if (align === "center" || align === "centerContinuous") left = cellRect.left - (width - cellRect.width) / 2;
    }
    left = Math.max(0, left);
    width = Math.min(width, Math.max(cellRect.width, viewportW - left - 2));
    let lineCount = lines.length;
    if (wrap) {
      const inner = width - PAD_X * 2;
      lineCount = lines.reduce((n, l) => n + Math.max(1, Math.ceil(measureTextWidth(l, font) / Math.max(1, inner))), 0);
    }
    const height = Math.min(Math.max(cellRect.height, lineCount * lineHeight + PAD_Y * 2), Math.max(cellRect.height, viewportH - cellRect.top - 2));
    return { left, top: cellRect.top, width, height };
  }, [cellRect, state.text, state.suggestion, wrap, font, fontSizePx, lineHeight, style.hAlign]);

  // Anchor for the popups: below the editor box.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const next = boxRef.current?.getBoundingClientRect() ?? null;
    setAnchor((prev) => (sameRect(prev, next) ? prev : next));
  });

  if (!editing || typeof document === "undefined") return null;

  const textAlign: CSSProperties["textAlign"] =
    style.hAlign === "right" ? "right" : style.hAlign === "center" || style.hAlign === "centerContinuous" ? "center" : "left";
  const boxStyle: CSSProperties = layout
    ? { position: "fixed", left: layout.left, top: layout.top, width: layout.width, height: layout.height }
    : // Not visible: keep the textarea focused off-screen so typing continues.
      { position: "fixed", left: -10_000, top: 0, width: 200, height: 24, opacity: 0 };

  const decoration = [style.underline ? "underline" : "", style.strike ? "line-through" : ""].filter(Boolean).join(" ");

  return createPortal(
    <>
      <div
        ref={boxRef}
        className="z-40 overflow-hidden border-2 border-[#217346] shadow-sm"
        style={{
          ...boxStyle,
          background: style.fill ?? "var(--background)",
          color: style.color ?? "var(--foreground)",
          font,
          lineHeight: `${lineHeight}px`,
          textAlign,
          textDecoration: decoration || undefined,
          boxSizing: "border-box",
        }}
        data-sheetlight-editor=""
      >
        <EditorTextarea
          ref={textareaRef}
          session={session}
          state={state}
          surface="cell"
          wrap={wrap}
          ariaLabel="Editor de celda"
          className="h-full w-full"
          style={{ padding: `${PAD_Y}px ${PAD_X - 2}px` }}
        />
      </div>
      {state.surface === "cell" && <EditorPopups session={session} state={state} anchor={layout ? anchor : null} />}
      <EditErrorDialog session={session} state={state} />
    </>,
    document.body,
  );
}

function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}
