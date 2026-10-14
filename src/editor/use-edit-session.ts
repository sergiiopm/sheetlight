import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CellDetails } from "@/engine/contract";
import type { CellAddress, SheetId } from "@/engine/types";
import { EditSession, type EditSessionOptions, type EditState } from "@/editor/session";

/** Subscribes a component to the edit session state. */
export function useEditState(session: EditSession): EditState {
  return useSyncExternalStore(session.subscribe, session.getState, session.getState);
}

/**
 * Creates one `EditSession` per document and disposes it on unmount or when
 * the engine/document changes. Callback options (`onCommit`, `getGrid`,
 * `getSheets`, `onNavigateSheet`, `now`) may change on every render: the
 * session always calls the latest ones.
 */
export function useEditSession(options: EditSessionOptions): EditSession {
  const latest = useRef(options);
  latest.current = options;
  const { engine, doc, selection, locale, valueAutoComplete } = options;
  const [session, setSession] = useState(() => createBound(latest));
  const sessionRef = useRef(session);

  useEffect(() => {
    const current = sessionRef.current;
    const o = current.options;
    if (o.engine === engine && o.doc === doc && o.selection === selection && o.locale === locale && o.valueAutoComplete === valueAutoComplete && !current.disposed) {
      return () => {
        current.session.dispose();
        current.disposed = true;
      };
    }
    const next = createBound(latest);
    sessionRef.current = next;
    setSession(next);
    return () => {
      next.session.dispose();
      next.disposed = true;
    };
  }, [engine, doc, selection, locale, valueAutoComplete]);

  return session.session;
}

interface BoundSession {
  readonly session: EditSession;
  readonly options: EditSessionOptions;
  disposed: boolean;
}

function createBound(latest: { readonly current: EditSessionOptions }): BoundSession {
  const o = latest.current;
  const session = new EditSession({
    engine: o.engine,
    doc: o.doc,
    selection: o.selection,
    locale: o.locale,
    valueAutoComplete: o.valueAutoComplete,
    getGrid: () => latest.current.getGrid(),
    onCommit: (ops, move) => latest.current.onCommit(ops, move),
    getSheets: () => latest.current.getSheets?.() ?? [],
    onNavigateSheet: (sheet, range) => latest.current.onNavigateSheet?.(sheet, range),
    now: () => latest.current.now?.() ?? new Date(),
  });
  return { session, options: o, disposed: false };
}

/**
 * Details of the active cell (formula bar idle text), refetched when the
 * selection moves or the engine invalidates the cell. Null while loading.
 */
export function useActiveCellDetails(session: EditSession): CellDetails | null {
  const store = session.selection;
  const active = useSyncExternalStore(store.subscribe, store.get, store.get);
  const sheet = active.sheet;
  const { row, col } = active.active;
  const [details, setDetails] = useState<CellDetails | null>(null);

  useEffect(() => {
    let alive = true;
    const cell: CellAddress = { row, col };
    const load = (target: SheetId) => {
      const cached = session.cache.peek(target, cell);
      if (cached) {
        setDetails(cached);
        return;
      }
      session.cache.get(target, cell).then(
        (d) => {
          if (alive) setDetails(d);
        },
        () => {
          if (alive) setDetails(null);
        },
      );
    };
    load(sheet);
    const unsubscribe = session.cache.subscribe(() => load(sheet));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [session, sheet, row, col]);

  return details !== null && details.sheet === sheet && details.row === row && details.col === col ? details : null;
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
