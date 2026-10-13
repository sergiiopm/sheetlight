import { Plus } from "lucide-react";

interface SheetTabsProps {
  sheets: string[];
  activeIndex: number;
}

/**
 * Sheet tabs of the active workbook. Static for now; add / rename / delete /
 * duplicate / reorder arrive with the workbook model.
 */
export function SheetTabs({ sheets, activeIndex }: SheetTabsProps) {
  return (
    <div className="flex h-8 shrink-0 items-start border-t border-border bg-workspace pl-2">
      <div role="tablist" aria-label="Hojas" className="flex min-w-0 items-start overflow-x-auto [scrollbar-width:none]">
        {sheets.map((name, index) => {
          const active = index === activeIndex;
          return (
            <div
              key={name}
              role="tab"
              aria-selected={active}
              className={
                active
                  ? "-mt-px flex h-7 shrink-0 cursor-default select-none items-center rounded-b-md border border-t-0 border-border border-b-2 border-b-brand bg-background px-4 text-xs font-medium text-brand"
                  : "flex h-7 shrink-0 cursor-default select-none items-center px-4 text-xs text-muted-foreground hover:text-foreground"
              }
            >
              {name}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="Nueva hoja"
        title="Nueva hoja (pendiente)"
        disabled
        className="ml-1 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
