import { useEffect, useRef, type PointerEvent } from "react";
import { Plus, X } from "lucide-react";
import { useController } from "@/components/controller-context";
import { useStore } from "@/hooks/store";
import { sessionFileName, type WorkbookSession } from "@/hooks/workbook-session";
import { cn } from "@/lib/utils";

/** Open workbooks (document tabs), ported from Doclight: drag to reorder, middle click closes. */
export function TabBar() {
  const controller = useController();
  const { sessions, activeId } = useStore(controller.manager.state);
  const scrollRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<string | null>(null);

  useEffect(() => {
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, sessions.length]);

  function onPointerMove(event: PointerEvent) {
    const dragged = draggingRef.current;
    if (!dragged) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-tab-id]");
    const overId = target?.dataset.tabId;
    if (!target || !overId || overId === dragged) return;
    // Swap only once the pointer crosses the neighbour's middle so tabs of
    // different widths don't bounce back and forth.
    const rect = target.getBoundingClientRect();
    const middle = rect.left + rect.width / 2;
    const draggedIndex = sessions.findIndex((s) => s.id === dragged);
    const overIndex = sessions.findIndex((s) => s.id === overId);
    if (overIndex > draggedIndex ? event.clientX > middle : event.clientX < middle) {
      controller.manager.move(dragged, overId);
    }
  }

  return (
    <div className="flex h-8 shrink-0 items-end border-b border-border bg-background pl-1">
      <div
        ref={scrollRef}
        role="tablist"
        aria-label="Libros abiertos"
        className="flex min-w-0 items-end overflow-x-auto [scrollbar-width:none]"
        onWheel={(event) => {
          if (event.ctrlKey || event.metaKey || !scrollRef.current) return;
          scrollRef.current.scrollLeft += event.deltaY || event.deltaX;
        }}
      >
        {sessions.map((session) => (
          <DocumentTab
            key={session.id}
            session={session}
            active={session.id === activeId}
            onPointerDown={() => {
              draggingRef.current = session.id;
            }}
            onPointerMove={onPointerMove}
            onPointerEnd={() => {
              draggingRef.current = null;
            }}
          />
        ))}
      </div>
      <button
        type="button"
        aria-label="Nuevo libro"
        title="Nuevo libro (Ctrl+N)"
        className="mb-0.5 ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => void controller.runCommand("file.new")}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface DocumentTabProps {
  readonly session: WorkbookSession;
  readonly active: boolean;
  readonly onPointerDown: () => void;
  readonly onPointerMove: (event: PointerEvent) => void;
  readonly onPointerEnd: () => void;
}

function DocumentTab({ session, active, onPointerDown, onPointerMove, onPointerEnd }: DocumentTabProps) {
  const controller = useController();
  const meta = useStore(session.meta);
  const name = sessionFileName(meta);
  const dirty = meta.info.dirty;
  const close = () => controller.manager.requestClose(session.id);
  return (
    <div
      data-tab-id={session.id}
      role="tab"
      aria-selected={active}
      title={meta.info.path ?? name}
      className={cn(
        "group relative flex h-7 max-w-52 min-w-24 shrink-0 cursor-default select-none items-center gap-1 rounded-t-md border border-b-0 pl-3 pr-1 text-xs",
        active
          ? "z-10 -mb-px h-[calc(1.75rem+1px)] border-border bg-workspace text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        controller.manager.activate(session.id);
        onPointerDown();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        close();
      }}
    >
      <span className="truncate">{name}</span>
      {meta.info.loading ? <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand" aria-label="Cargando" /> : null}
      <button
        type="button"
        aria-label={`Cerrar ${name}`}
        title="Cerrar (Ctrl+W)"
        className={cn(
          "relative flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-accent hover:text-foreground",
          !active && !dirty && "opacity-0 group-hover:opacity-100",
        )}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={close}
      >
        {dirty ? <span className="h-2 w-2 rounded-full bg-current group-hover:hidden" aria-hidden /> : null}
        <X className={cn("h-3.5 w-3.5", dirty && "hidden group-hover:block")} />
      </button>
    </div>
  );
}
