import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from "react";
import { Plus } from "lucide-react";
import { AnchoredMenu } from "@/components/AnchoredMenu";
import { ColorPalette } from "@/components/ColorPalette";
import { CommandMenuItem } from "@/components/CommandMenuItem";
import { useController } from "@/components/controller-context";
import {
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import type { SheetMeta } from "@/engine/contract";
import type { SheetId } from "@/engine/types";
import * as sheetActions from "@/hooks/actions/sheet-actions";
import { useStore } from "@/hooks/store";
import type { WorkbookSession } from "@/hooks/workbook-session";
import { cn } from "@/lib/utils";

/**
 * Sheet tabs of the active workbook (Excel's bottom strip): click to switch,
 * double click to rename inline, drag to reorder, right click for the sheet
 * menu (insert, delete, rename, duplicate, tab color, hide/unhide).
 */
export function SheetTabs({ session }: { session: WorkbookSession }) {
  const controller = useController();
  const meta = useStore(session.meta);
  const renaming = useStore(controller.renamingSheet);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ sheet: SheetId; target: number; moved: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { sheets, activeSheet } = meta.info;
  const visible = sheets.filter((s) => !s.hidden);

  useEffect(() => {
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-sheet-id="${activeSheet}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeSheet, sheets.length]);

  /** Index in the full sheet list where a tab dropped at clientX lands. */
  const dropIndex = (clientX: number): number => {
    const tabs = scrollRef.current?.querySelectorAll<HTMLElement>("[data-sheet-id]") ?? [];
    let visibleIndex = visible.length;
    for (let i = 0; i < tabs.length; i += 1) {
      const rect = tabs[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        visibleIndex = i;
        break;
      }
    }
    // Map to the full list (hidden sheets keep their places).
    if (visibleIndex >= visible.length) return sheets.length;
    return sheets.findIndex((s) => s.id === visible[visibleIndex].id);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag) return;
    const target = dropIndex(event.clientX);
    if (target !== drag.target || !drag.moved) setDrag({ ...drag, target, moved: true });
  };

  const finishDrag = () => {
    if (!drag) return;
    setDrag(null);
    if (!drag.moved) return;
    const from = sheets.findIndex((s) => s.id === drag.sheet);
    // Removing the tab first shifts later targets left by one.
    const index = drag.target > from ? drag.target - 1 : drag.target;
    if (index !== from) void sheetActions.moveSheet(controller, drag.sheet, index);
  };

  const markerLeft = (() => {
    if (!drag?.moved || !scrollRef.current) return null;
    const tabs = scrollRef.current.querySelectorAll<HTMLElement>("[data-sheet-id]");
    const host = scrollRef.current.getBoundingClientRect();
    const targetSheet = sheets[drag.target];
    const index = targetSheet ? visible.findIndex((s) => s.id === targetSheet.id) : visible.length;
    if (index < 0) return null;
    const tab = tabs[Math.min(index, tabs.length - 1)];
    if (!tab) return null;
    const rect = tab.getBoundingClientRect();
    return (index >= tabs.length ? rect.right : rect.left) - host.left + scrollRef.current.scrollLeft;
  })();

  return (
    <div className="flex h-8 shrink-0 items-start border-t border-border bg-workspace pl-2">
      <div
        ref={scrollRef}
        role="tablist"
        aria-label="Hojas"
        className="relative flex min-w-0 items-start overflow-x-auto [scrollbar-width:none]"
        onWheel={(event) => {
          if (scrollRef.current) scrollRef.current.scrollLeft += event.deltaY || event.deltaX;
        }}
      >
        {visible.map((sheet) => (
          <SheetTab
            key={sheet.id}
            sheet={sheet}
            active={sheet.id === activeSheet}
            renaming={renaming === sheet.id}
            dragging={drag?.moved === true && drag.sheet === sheet.id}
            onPointerDown={(event) => {
              if (event.button !== 0 || renaming === sheet.id) return;
              void sheetActions.activateSheet(controller, sheet.id);
              setDrag({ sheet: sheet.id, target: sheets.findIndex((s) => s.id === sheet.id), moved: false });
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={onPointerMove}
            onPointerUp={finishDrag}
            onContextMenu={(event) => {
              event.preventDefault();
              if (sheet.id !== activeSheet) void sheetActions.activateSheet(controller, sheet.id);
              setMenuAt({ x: event.clientX, y: event.clientY });
            }}
            onRename={(name) => {
              controller.renamingSheet.set(null);
              if (name !== null) void sheetActions.renameSheet(controller, sheet.id, name);
              controller.focusGrid();
            }}
            onStartRename={() => controller.renamingSheet.set(sheet.id)}
          />
        ))}
        {markerLeft !== null ? (
          <span className="pointer-events-none absolute top-0 h-7 w-0.5 bg-brand" style={{ left: markerLeft - 1 }} aria-hidden />
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Nueva hoja"
        title="Nueva hoja (Mayús+F11)"
        className="ml-1 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => void controller.runCommand("sheet.new")}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <AnchoredMenu
        label="Menú de hoja"
        at={menuAt}
        onClose={() => {
          setMenuAt(null);
        }}
      >
        <CommandMenuItem command="sheet.new" label="Insertar hoja" source="contextMenu" />
        <CommandMenuItem command="sheet.delete" label="Eliminar" source="contextMenu" />
        <CommandMenuItem command="sheet.rename" label="Cambiar nombre" source="contextMenu" />
        <CommandMenuItem command="sheet.duplicate" label="Duplicar" source="contextMenu" />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="size-4" aria-hidden />
            Color de pestaña
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="p-2">
            <ColorPalette
              noneLabel="Sin color"
              value={sheets.find((s) => s.id === activeSheet)?.color ?? null}
              onPick={(color) => {
                setMenuAt(null);
                void sheetActions.setSheetColor(controller, session.activeSheet, color);
              }}
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <CommandMenuItem command="sheet.hide" label="Ocultar" source="contextMenu" />
        <CommandMenuItem command="sheet.unhide" label="Mostrar…" source="contextMenu" />
      </AnchoredMenu>
    </div>
  );
}

interface SheetTabProps {
  readonly sheet: SheetMeta;
  readonly active: boolean;
  readonly renaming: boolean;
  readonly dragging: boolean;
  readonly onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: PointerEvent) => void;
  readonly onPointerUp: () => void;
  readonly onContextMenu: (event: React.MouseEvent) => void;
  readonly onStartRename: () => void;
  /** null = cancelled. */
  readonly onRename: (name: string | null) => void;
}

function SheetTab({ sheet, active, renaming, dragging, onPointerDown, onPointerMove, onPointerUp, onContextMenu, onStartRename, onRename }: SheetTabProps) {
  return (
    <div
      data-sheet-id={sheet.id}
      role="tab"
      aria-selected={active}
      title={sheet.name}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onStartRename}
      onContextMenu={onContextMenu}
      className={cn(
        "relative flex h-7 max-w-48 shrink-0 cursor-default select-none items-center px-4 text-xs",
        active
          ? "-mt-px rounded-b-md border border-t-0 border-border bg-background font-medium text-brand after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:bg-brand"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        dragging && "opacity-60",
      )}
    >
      {sheet.color ? (
        <span className="absolute inset-x-2 bottom-0.5 h-[3px] rounded-full" style={{ backgroundColor: sheet.color }} aria-hidden />
      ) : null}
      {renaming ? <RenameInput initial={sheet.name} onDone={onRename} /> : <span className="truncate">{sheet.name}</span>}
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      ref={ref}
      aria-label="Nombre de la hoja"
      defaultValue={initial}
      maxLength={31}
      size={Math.max(4, initial.length + 1)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(event.currentTarget.value);
        if (event.key === "Escape") finish(null);
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
      className="h-5 rounded-sm border border-brand bg-background px-1 text-xs text-foreground outline-none"
    />
  );
}
