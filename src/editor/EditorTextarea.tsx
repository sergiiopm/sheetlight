import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { EditState, EditSession, EditSurface } from "@/editor/session";
import { cn } from "@/lib/utils";

/**
 * A textarea bound to the edit session. For formulas it renders the text
 * twice: a "mirror" layer with colored reference tokens under a textarea with
 * transparent text (the caret and the selection stay native), so colors
 * never fight IME, undo or accessibility.
 */
export interface EditorTextareaProps {
  readonly session: EditSession;
  readonly state: EditState;
  readonly surface: EditSurface;
  /** Text shown when the session is idle (formula bar shows the active cell). */
  readonly idleText?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  /** Soft wrap long lines (wrap-text cells, formula bar). */
  readonly wrap: boolean;
  readonly ariaLabel: string;
  readonly rows?: number;
  /** Idle-only focus (formula bar starts editing on focus). */
  readonly onIdleFocus?: () => void;
  readonly readOnly?: boolean;
}

export interface EditorTextareaHandle {
  readonly element: HTMLTextAreaElement | null;
}

export const EditorTextarea = forwardRef<EditorTextareaHandle, EditorTextareaProps>(function EditorTextarea(props, ref) {
  const { session, state, surface, idleText = "", className, style, wrap, ariaLabel, rows, onIdleFocus, readOnly = false } = props;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const composing = useRef(false);
  useImperativeHandle(ref, () => ({ get element() { return textareaRef.current; } }), []);

  const editing = state.status === "editing";
  const value = editing ? state.text + state.suggestion : idleText;
  const isActive = editing && state.surface === surface;
  const colored = editing && state.isFormula && state.suggestion === "";

  // Focus requests (start of editing, after a grid pick, after the error dialog).
  useEffect(() => {
    if (!isActive) return;
    const el = textareaRef.current;
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }, [isActive, state.focusRequest]);

  // Keep the DOM caret in sync with the session (programmatic edits: picks, F4, completion).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || !isActive || composing.current || document.activeElement !== el) return;
    if (el.selectionStart !== state.selStart || el.selectionEnd !== state.selEnd) {
      el.setSelectionRange(state.selStart, state.selEnd);
    }
  });

  const syncScroll = useCallback(() => {
    const el = textareaRef.current;
    const mirror = mirrorRef.current;
    if (el && mirror) {
      mirror.scrollTop = el.scrollTop;
      mirror.scrollLeft = el.scrollLeft;
    }
  }, []);
  useLayoutEffect(syncScroll);

  const mirror = useMemo<ReactNode>(() => (colored ? renderTokens(state) : null), [colored, state]);

  const textStyle: CSSProperties = {
    whiteSpace: wrap ? "pre-wrap" : "pre",
    overflowWrap: wrap ? "break-word" : "normal",
  };

  return (
    <div className={cn("relative min-w-0", className)} style={style} data-sheetlight-editor="">
      {colored && (
        <div
          ref={mirrorRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{ ...textStyle, padding: "inherit", font: "inherit", lineHeight: "inherit", textAlign: "inherit", letterSpacing: "inherit" }}
        >
          {mirror}
        </div>
      )}
      <textarea
        ref={textareaRef}
        aria-label={ariaLabel}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        rows={rows ?? 1}
        readOnly={readOnly || (!editing && onIdleFocus === undefined)}
        value={value}
        className="relative block h-full w-full resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
        style={{
          ...textStyle,
          font: "inherit",
          lineHeight: "inherit",
          textAlign: "inherit",
          color: colored ? "transparent" : "inherit",
          caretColor: "currentColor",
          WebkitTextFillColor: colored ? "transparent" : undefined,
        }}
        onFocus={() => {
          if (!editing) onIdleFocus?.();
        }}
        onPointerDown={() => {
          if (editing) session.setSurface(surface);
        }}
        onChange={(e) => {
          if (!editing) return;
          const native = e.nativeEvent as InputEvent;
          session.setText(e.target.value, e.target.selectionStart, e.target.selectionEnd, native.inputType);
        }}
        onSelect={(e) => {
          if (!isActive || composing.current) return;
          const el = e.currentTarget;
          session.setSelection(el.selectionStart, el.selectionEnd);
        }}
        onScroll={syncScroll}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          const el = e.currentTarget;
          if (editing) session.setText(el.value, el.selectionStart, el.selectionEnd, "insertCompositionText");
        }}
        onKeyDown={(e) => {
          if (!editing) return;
          const handled = session.handleKey({
            key: e.key,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            isComposing: e.nativeEvent.isComposing || composing.current,
            keyCode: e.keyCode,
          });
          if (handled) e.preventDefault();
          // Keys typed in the editor never reach the grid or global shortcuts.
          e.stopPropagation();
        }}
      />
    </div>
  );
});

function renderTokens(state: EditState): ReactNode[] {
  const colorAt = new Map<number, string>();
  for (const r of state.refs) colorAt.set(r.start, r.color);
  const out: ReactNode[] = [];
  for (const t of state.tokens) {
    const color = t.type === "ref" ? colorAt.get(t.start) : undefined;
    if (color) {
      out.push(
        <span key={t.start} style={{ color }}>
          {t.text}
        </span>,
      );
    } else if (t.type === "string") {
      out.push(
        <span key={t.start} className="text-[#a3480f] dark:text-[#e8a06b]">
          {t.text}
        </span>,
      );
    } else {
      out.push(t.text);
    }
  }
  // A trailing newline needs content to take up a line in the mirror.
  if (state.text.endsWith("\n")) out.push("​");
  return out;
}
