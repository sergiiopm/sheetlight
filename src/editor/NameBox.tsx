import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cellName } from "@/engine/types";
import type { EditSession } from "@/editor/session";
import { cn } from "@/lib/utils";

export interface NameBoxProps {
  readonly session: EditSession;
  readonly className?: string;
}

/**
 * Excel's name box: shows the active cell (`B7`) and, on Enter, goes to what
 * was typed (`C10`, `A1:D20`, `B:B`, `3:5`, `Hoja2!A1`). Invalid input keeps
 * the box focused with the text selected and a Spanish error below it.
 */
export function NameBox({ session, className }: NameBoxProps) {
  const store = session.selection;
  const selection = useSyncExternalStore(store.subscribe, store.get, store.get);
  const label = cellName(selection.active);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setError(null);
  }, [label]);

  const reset = () => {
    setDraft(null);
    setError(null);
  };

  return (
    <div className={cn("relative shrink-0", className)} data-sheetlight-editor="">
      <input
        ref={inputRef}
        aria-label="Cuadro de nombres"
        aria-invalid={error !== null}
        spellCheck={false}
        autoComplete="off"
        value={draft ?? label}
        className={cn(
          "h-7 w-24 rounded-md border border-input bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
          error !== null && "border-destructive",
        )}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onBlur={reset}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            reset();
            session.focusGrid();
          } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            const message = session.navigateTo(draft ?? label);
            if (message === null) {
              setDraft(null);
              setError(null);
            } else {
              setError(message);
              inputRef.current?.select();
            }
          }
        }}
      />
      {error !== null && (
        <div role="alert" className="absolute left-0 top-full z-50 mt-1 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md">
          {error}
        </div>
      )}
    </div>
  );
}
