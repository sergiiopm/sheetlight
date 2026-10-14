import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { EditorPopups } from "@/editor/EditorPopups";
import { EditorTextarea, type EditorTextareaHandle } from "@/editor/EditorTextarea";
import { NameBox } from "@/editor/NameBox";
import type { EditSession } from "@/editor/session";
import { useActiveCellDetails, useEditState } from "@/editor/use-edit-session";
import { toEditText } from "@/lib/locale";
import { cn } from "@/lib/utils";

export interface FormulaBarProps {
  readonly session: EditSession;
  readonly className?: string;
  /** Read-only documents: the bar shows the content but cannot start editing. */
  readonly readOnly?: boolean;
}

/**
 * Formula bar: name box, ✕ / ✓ / fx buttons and a second view of the edit
 * session (typing here and in the in-cell editor edits the same text). While
 * idle it shows the active cell's input in the user's locale; focusing it
 * starts editing in Edit mode, like Excel.
 */
export function FormulaBar({ session, className, readOnly = false }: FormulaBarProps) {
  const state = useEditState(session);
  const details = useActiveCellDetails(session);
  const editing = state.status === "editing";
  const [expanded, setExpanded] = useState(false);
  const textareaRef = useRef<EditorTextareaHandle | null>(null);
  const idleText = details ? toEditText(details, session.locale) : "";

  // Popups anchor under the bar's text box when the bar owns the caret.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const next = editing && state.surface === "bar" ? (boxRef.current?.getBoundingClientRect() ?? null) : null;
    setAnchor((prev) => (sameRect(prev, next) ? prev : next));
  });

  const multiLine = expanded || (editing ? state.text : idleText).includes("\n");
  const rows = expanded ? 4 : 1;

  return (
    <div className={cn("flex shrink-0 items-start gap-1 border-b border-border bg-workspace px-2 py-1", className)}>
      <NameBox session={session} />
      <div className="flex h-7 shrink-0 items-center" aria-hidden={!editing}>
        <BarButton label="Cancelar" disabled={!editing} onClick={() => session.cancel()}>
          <X />
        </BarButton>
        <BarButton label="Introducir" disabled={!editing} onClick={() => session.commit("none", "button")}>
          <Check />
        </BarButton>
        <BarButton label="Insertar función" disabled={readOnly} onClick={() => session.openFunctionList()}>
          <span className="font-serif text-sm italic">fx</span>
        </BarButton>
      </div>
      <div
        ref={boxRef}
        className={cn(
          "min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs leading-5",
          editing && state.surface === "bar" && "ring-1 ring-ring",
        )}
        style={{ height: expanded ? rows * 20 + 10 : 28 }}
      >
        <EditorTextarea
          ref={textareaRef}
          session={session}
          state={state}
          surface="bar"
          idleText={idleText}
          wrap={multiLine}
          rows={rows}
          ariaLabel="Barra de fórmulas"
          className="h-full w-full"
          readOnly={readOnly}
          onIdleFocus={() => {
            if (!readOnly) session.startInBar();
          }}
        />
      </div>
      <BarButton label={expanded ? "Contraer barra de fórmulas" : "Expandir barra de fórmulas"} onClick={() => setExpanded((v) => !v)}>
        {expanded ? <ChevronUp /> : <ChevronDown />}
      </BarButton>
      {state.surface === "bar" && <EditorPopups session={session} state={state} anchor={anchor} />}
    </div>
  );
}

function BarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      // Keep focus (and the caret) in the editor while clicking the buttons.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}
