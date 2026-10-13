import { useEffect, useRef, type PointerEvent } from "react";
import { Plus, X } from "lucide-react";
import { tabFileName, type WorkbookTab } from "@/hooks/use-workbook-tabs";
import { cn } from "@/lib/utils";

interface TabBarProps {
  tabs: WorkbookTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (id: string, overId: string) => void;
  onNew: () => void;
}

export function TabBar({ tabs, activeId, onSelect, onClose, onMove, onNew }: TabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<string | null>(null);

  useEffect(() => {
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  function onPointerMove(event: PointerEvent) {
    const dragged = draggingRef.current;
    if (!dragged) return;
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-tab-id]");
    const overId = target?.dataset.tabId;
    if (!target || !overId || overId === dragged) return;

    // Only swap once the pointer crosses the middle of the neighbour, so tabs of
    // different widths don't bounce back and forth.
    const rect = target.getBoundingClientRect();
    const middle = rect.left + rect.width / 2;
    const draggedIndex = tabs.findIndex((tab) => tab.id === dragged);
    const overIndex = tabs.findIndex((tab) => tab.id === overId);
    if (overIndex > draggedIndex ? event.clientX > middle : event.clientX < middle) {
      onMove(dragged, overId);
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
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const name = tabFileName(tab);
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              role="tab"
              aria-selected={active}
              title={tab.path ?? name}
              className={cn(
                "group relative flex h-7 max-w-52 min-w-24 shrink-0 cursor-default select-none items-center gap-1 rounded-t-md border border-b-0 pl-3 pr-1 text-xs",
                active
                  ? "z-10 -mb-px h-[calc(1.75rem+1px)] border-border bg-workspace text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                onSelect(tab.id);
                draggingRef.current = tab.id;
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={onPointerMove}
              onPointerUp={() => {
                draggingRef.current = null;
              }}
              onPointerCancel={() => {
                draggingRef.current = null;
              }}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                onClose(tab.id);
              }}
            >
              <span className="truncate">{name}</span>
              <button
                type="button"
                aria-label={`Cerrar ${name}`}
                title="Cerrar (Ctrl+W)"
                className={cn(
                  "relative flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-accent hover:text-foreground",
                  !active && !tab.dirty && "opacity-0 group-hover:opacity-100",
                )}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onClose(tab.id)}
              >
                {tab.dirty ? (
                  <span className="h-2 w-2 rounded-full bg-current group-hover:hidden" aria-hidden />
                ) : null}
                <X className={cn("h-3.5 w-3.5", tab.dirty && "hidden group-hover:block")} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="Nuevo libro"
        title="Nuevo libro (Ctrl+N)"
        className="mb-0.5 ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onNew}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
