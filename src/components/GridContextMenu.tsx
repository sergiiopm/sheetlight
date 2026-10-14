import { ArrowDownAZ, ArrowDownZA, ChartColumnBig, ClipboardPaste, Copy, Filter, Grid3x3, Scissors } from "lucide-react";
import { AnchoredMenu } from "@/components/AnchoredMenu";
import { CommandMenuItem } from "@/components/CommandMenuItem";
import { useController } from "@/components/controller-context";
import {
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useStore } from "@/hooks/store";

/** Right-click menu of the grid: cells, row headers, column headers and the corner. */
export function GridContextMenu() {
  const controller = useController();
  const menu = useStore(controller.contextMenu);
  const region = menu?.region ?? "cell";
  const item = (command: string, label?: string, icon?: React.ReactNode) => (
    <CommandMenuItem command={command} label={label} icon={icon} source="contextMenu" />
  );

  return (
    <AnchoredMenu
      label="Menú contextual"
      at={menu ? { x: menu.x, y: menu.y } : null}
      onClose={() => {
        controller.contextMenu.set(null);
        controller.focusGrid();
      }}
    >
      {item("edit.cut", undefined, <Scissors />)}
      {item("edit.copy", undefined, <Copy />)}
      {item("edit.paste", undefined, <ClipboardPaste />)}
      {item("edit.pasteValues")}
      {item("edit.pasteSpecial")}
      <DropdownMenuSeparator />
      {region === "rowHeader" ? (
        <>
          {item("insert.rows", "Insertar")}
          {item("delete.rows", "Eliminar")}
        </>
      ) : region === "colHeader" ? (
        <>
          {item("insert.cols", "Insertar")}
          {item("delete.cols", "Eliminar")}
        </>
      ) : (
        <>
          {item("insert.cells", "Insertar…")}
          {item("delete.cells", "Eliminar…")}
        </>
      )}
      {item("edit.clearContents")}
      <DropdownMenuSeparator />
      {region === "cell" || region === "corner" ? (
        <>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Filter />
              Filtrar y ordenar
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {item("data.sortAsc", undefined, <ArrowDownAZ />)}
              {item("data.sortDesc", undefined, <ArrowDownZA />)}
              {item("data.sortCustom")}
              <DropdownMenuSeparator />
              {item("data.filter")}
              {item("data.clearFilters")}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {item("insert.chart", "Insertar gráfico…", <ChartColumnBig />)}
          <DropdownMenuSeparator />
        </>
      ) : null}
      {item("format.cells", undefined, <Grid3x3 />)}
      {region === "rowHeader" ? (
        <>
          {item("format.rowHeight")}
          {item("format.hideRows", "Ocultar")}
          {item("format.unhideRows", "Mostrar")}
        </>
      ) : null}
      {region === "colHeader" ? (
        <>
          {item("format.colWidth")}
          {item("format.autofitCols")}
          {item("format.hideCols", "Ocultar")}
          {item("format.unhideCols", "Mostrar")}
        </>
      ) : null}
    </AnchoredMenu>
  );
}
