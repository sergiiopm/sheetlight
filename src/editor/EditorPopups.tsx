import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { argForIndex, argLabel, CATEGORY_LABELS } from "@/editor/functions";
import type { EditSession, EditState } from "@/editor/session";

/**
 * Floating UI of the active editor view: function autocomplete list and
 * signature help, anchored under the view (fixed positioning in a portal so
 * they escape grid/formula bar clipping).
 */
export function EditorPopups({ session, state, anchor }: { session: EditSession; state: EditState; anchor: DOMRect | null }) {
  if (state.status !== "editing" || !anchor || typeof document === "undefined") return null;
  const left = Math.max(0, anchor.left);
  const top = anchor.bottom + 2;
  return createPortal(
    <div className="pointer-events-none fixed z-50 flex flex-col gap-1" style={{ left, top }} data-sheetlight-editor="">
      {state.completion ? (
        <CompletionList session={session} state={state} />
      ) : state.signature ? (
        <SignatureHelp state={state} />
      ) : null}
    </div>,
    document.body,
  );
}

function CompletionList({ session, state }: { session: EditSession; state: EditState }) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const completion = state.completion;
  const index = completion?.index ?? 0;
  useEffect(() => {
    const el = listRef.current?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [index]);
  if (!completion) return null;
  const selected = completion.items[index];
  return (
    <div className="pointer-events-auto flex items-start gap-1">
      <ul
        ref={listRef}
        role="listbox"
        aria-label="Funciones"
        className="max-h-56 w-56 overflow-y-auto rounded-md border border-border bg-popover py-1 text-xs text-popover-foreground shadow-lg"
      >
        {completion.items.map((fn, k) => (
          <li
            key={fn.name}
            role="option"
            aria-selected={k === index}
            className={
              "flex cursor-default items-center justify-between gap-2 px-2 py-0.5 font-mono " +
              (k === index ? "bg-primary text-primary-foreground" : "hover:bg-accent")
            }
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => session.setCompletionIndex(k)}
            onClick={() => session.acceptCompletion(k)}
          >
            <span>{fn.name}</span>
            {fn.es !== "" && fn.es !== fn.name && <span className="truncate font-sans opacity-60">{fn.es}</span>}
          </li>
        ))}
      </ul>
      {selected && selected.description !== "" && (
        <div className="w-64 rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-lg">
          <div className="font-mono font-semibold">{selected.name}</div>
          <div className="mt-0.5 text-muted-foreground">{CATEGORY_LABELS[selected.category]}</div>
          <div className="mt-1">{selected.description}</div>
        </div>
      )}
    </div>
  );
}

function SignatureHelp({ state }: { state: EditState }) {
  const sig = state.signature;
  if (!sig) return null;
  const { fn, argIndex } = sig;
  const current = argForIndex(fn, argIndex);
  return (
    <div
      role="tooltip"
      className="max-w-md rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
    >
      <div className="font-mono">
        {fn.name}(
        {fn.args.map((arg, k) => (
          <span key={arg.name}>
            {k > 0 && ", "}
            <span className={current && current.position === k ? "font-bold underline" : undefined}>{argLabel(arg)}</span>
          </span>
        ))}
        )
      </div>
      {current && current.arg.description !== "" && (
        <div className="mt-0.5 text-muted-foreground">
          <span className="font-semibold text-popover-foreground">{current.arg.name}</span>: {current.arg.description}
        </div>
      )}
    </div>
  );
}

/** Excel-like modal for formula errors; Aceptar returns to the editor. */
export function EditErrorDialog({ session, state }: { session: EditSession; state: EditState }) {
  const [first, ...rest] = (state.error ?? "").split("\n\n");
  return (
    <Dialog open={state.error !== null} onOpenChange={(open) => !open && session.dismissError()}>
      <DialogContent onCloseAutoFocus={(e) => e.preventDefault()} data-sheetlight-editor="">
        <DialogTitle>Sheetlight</DialogTitle>
        <DialogDescription className="whitespace-pre-line text-sm">{first}</DialogDescription>
        {rest.length > 0 && <p className="whitespace-pre-line text-sm text-muted-foreground">{rest.join("\n\n")}</p>}
        <DialogFooter>
          <Button autoFocus onClick={() => session.dismissError()}>
            Aceptar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
