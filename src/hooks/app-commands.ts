import type { BorderPreset } from "@/engine/contract";
import type { Command, CommandContext } from "@/model/commands";
import { NUMBER_FORMAT_PRESETS, THOUSANDS_STYLE } from "@/lib/number-formats";
import type { AppController } from "@/hooks/app-controller";
import * as data from "@/hooks/actions/data-actions";
import * as fmt from "@/hooks/actions/format-actions";
import * as sheets from "@/hooks/actions/sheet-actions";
import * as view from "@/hooks/actions/view-actions";

/**
 * Every shell action as a `Command` with a stable id and its Excel shortcut.
 * Toolbar buttons, menus, context menus and the keyboard all go through
 * these. Ids are a public contract for other modules. Charts (WS6) plug in
 * through `controller.charts` (see chart-integration.ts): `insert.chart` is
 * enabled once an insert handler is set.
 */

type Run = (context: CommandContext) => void | Promise<void>;

interface Def {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly shortcut?: string;
  readonly enabled?: () => boolean;
  readonly active?: () => boolean;
  readonly run: Run;
}

export const BORDER_PRESETS: ReadonlyArray<{ preset: BorderPreset; label: string; shortcut?: string }> = [
  { preset: "bottom", label: "Borde inferior" },
  { preset: "top", label: "Borde superior" },
  { preset: "left", label: "Borde izquierdo" },
  { preset: "right", label: "Borde derecho" },
  { preset: "none", label: "Sin borde", shortcut: "Mod+Shift+_" },
  { preset: "all", label: "Todos los bordes" },
  { preset: "outer", label: "Bordes externos", shortcut: "Mod+Shift+&" },
  { preset: "thickOuter", label: "Borde de cuadro grueso" },
  { preset: "doubleBottom", label: "Borde doble inferior" },
  { preset: "inner", label: "Bordes internos" },
  { preset: "innerHorizontal", label: "Bordes horizontales internos" },
  { preset: "innerVertical", label: "Bordes verticales internos" },
];

const NUMBER_SHORTCUTS: Record<string, string> = {
  general: "Mod+Shift+~",
  number: "Mod+Shift+!",
  currency: "Mod+Shift+$",
  shortDate: "Mod+Shift+#",
  time: "Mod+Shift+@",
  scientific: "Mod+Shift+^",
};

export function shellCommandDefs(c: AppController): Def[] {
  const has = () => c.session !== null;
  const style = () => c.activeCell.get()?.format.style ?? {};
  const info = () => c.session?.info;
  const run = (fn: () => unknown): Run => async () => {
    await fn();
  };

  const defs: Def[] = [
    // ----- Archivo
    { id: "file.new", label: "Nuevo libro", group: "Archivo", shortcut: "Mod+N", run: run(() => c.manager.newWorkbook()) },
    { id: "file.open", label: "Abrir…", group: "Archivo", shortcut: "Mod+O", run: run(() => c.manager.open()) },
    {
      id: "file.save",
      label: "Guardar",
      group: "Archivo",
      shortcut: "Mod+S",
      enabled: has,
      run: run(() => c.session && c.manager.save(c.session)),
    },
    {
      id: "file.saveAs",
      label: "Guardar como…",
      group: "Archivo",
      shortcut: "Mod+Shift+S",
      enabled: has,
      run: run(() => c.session && c.manager.saveAs(c.session)),
    },
    {
      id: "file.close",
      label: "Cerrar libro",
      group: "Archivo",
      shortcut: "Mod+W",
      enabled: has,
      run: run(() => c.session && c.manager.requestClose(c.session.id)),
    },
    {
      id: "file.csvOptions",
      label: "Opciones de importación CSV…",
      group: "Archivo",
      enabled: () => {
        const source = c.session?.source;
        return Boolean(source && source.kind !== "new" && info()?.csv);
      },
      run: run(() => c.session && c.openDialog({ kind: "csvOptions", sessionId: c.session.id })),
    },
    { id: "app.options", label: "Opciones…", group: "Archivo", run: run(() => c.openDialog({ kind: "options" })) },
    { id: "app.about", label: "Acerca de Sheetlight", group: "Archivo", run: run(() => c.openDialog({ kind: "about" })) },
    {
      id: "view.toggleTheme",
      label: "Cambiar tema claro/oscuro",
      group: "Vista",
      run: run(() => {
        const dark = document.documentElement.classList.contains("dark");
        c.settings.update({ theme: dark ? "light" : "dark" });
      }),
    },

    // ----- Libros y hojas
    { id: "workbook.next", label: "Libro siguiente", group: "Ventana", shortcut: "Mod+Tab", run: run(() => c.manager.cycle(1)) },
    { id: "workbook.previous", label: "Libro anterior", group: "Ventana", shortcut: "Mod+Shift+Tab", run: run(() => c.manager.cycle(-1)) },
    { id: "sheet.new", label: "Insertar hoja", group: "Hojas", shortcut: "Shift+F11", enabled: has, run: run(() => sheets.addSheet(c)) },
    { id: "sheet.next", label: "Hoja siguiente", group: "Hojas", shortcut: "Mod+PageDown", enabled: has, run: run(() => sheets.cycleSheet(c, 1)) },
    { id: "sheet.previous", label: "Hoja anterior", group: "Hojas", shortcut: "Mod+PageUp", enabled: has, run: run(() => sheets.cycleSheet(c, -1)) },
    {
      id: "sheet.rename",
      label: "Cambiar nombre de hoja",
      group: "Hojas",
      enabled: has,
      run: run(() => c.session && c.renamingSheet.set(c.session.activeSheet)),
    },
    {
      id: "sheet.delete",
      label: "Eliminar hoja",
      group: "Hojas",
      enabled: has,
      run: run(() => c.session && sheets.requestDeleteSheet(c, c.session.activeSheet)),
    },
    {
      id: "sheet.duplicate",
      label: "Duplicar hoja",
      group: "Hojas",
      enabled: has,
      run: run(() => c.session && sheets.duplicateSheet(c, c.session.activeSheet)),
    },
    {
      id: "sheet.hide",
      label: "Ocultar hoja",
      group: "Hojas",
      enabled: has,
      run: run(() => c.session && sheets.setSheetHidden(c, c.session.activeSheet, true)),
    },
    {
      id: "sheet.unhide",
      label: "Mostrar hojas…",
      group: "Hojas",
      enabled: () => Boolean(info()?.sheets.some((s) => s.hidden)),
      run: run(() => c.openDialog({ kind: "unhideSheets" })),
    },

    // ----- Edición
    {
      id: "edit.undo",
      label: "Deshacer",
      group: "Edición",
      shortcut: "Mod+Z",
      enabled: () => Boolean(info()?.canUndo),
      run: run(() => c.session && c.manager.undo(c.session)),
    },
    {
      id: "edit.redo",
      label: "Rehacer",
      group: "Edición",
      shortcut: "Mod+Y",
      enabled: () => Boolean(info()?.canRedo),
      run: run(() => c.session && c.manager.redo(c.session)),
    },
    { id: "edit.cut", label: "Cortar", group: "Portapapeles", shortcut: "Mod+X", enabled: has, run: run(() => c.copy(true)) },
    { id: "edit.copy", label: "Copiar", group: "Portapapeles", shortcut: "Mod+C", enabled: has, run: run(() => c.copy(false)) },
    { id: "edit.paste", label: "Pegar", group: "Portapapeles", shortcut: "Mod+V", enabled: has, run: run(() => c.paste("all")) },
    {
      id: "edit.pasteSpecial",
      label: "Pegado especial…",
      group: "Portapapeles",
      shortcut: "Mod+Alt+V",
      enabled: has,
      run: run(() => c.openDialog({ kind: "pasteSpecial" })),
    },
    { id: "edit.pasteValues", label: "Pegar valores", group: "Portapapeles", shortcut: "Mod+Shift+V", enabled: has, run: run(() => c.paste("values")) },
    {
      id: "edit.formatPainter",
      label: "Copiar formato",
      group: "Portapapeles",
      enabled: has,
      active: () => c.painter.get() !== null,
      run: run(() => c.startFormatPainter(false)),
    },
    {
      id: "edit.cancel",
      label: "Cancelar copia",
      group: "Portapapeles",
      shortcut: "Escape",
      enabled: () => c.clipboard.clip.get() !== null || c.painter.get() !== null,
      run: run(() => c.clearMarquee()),
    },
    { id: "edit.clearContents", label: "Borrar contenido", group: "Edición", shortcut: "Delete", enabled: has, run: run(() => fmt.clear(c, "contents")) },
    { id: "edit.clearFormats", label: "Borrar formatos", group: "Edición", enabled: has, run: run(() => fmt.clear(c, "formats")) },
    { id: "edit.clearAll", label: "Borrar todo", group: "Edición", enabled: has, run: run(() => fmt.clear(c, "all")) },
    { id: "edit.find", label: "Buscar…", group: "Edición", shortcut: "Mod+F", enabled: has, run: run(() => c.openDialog({ kind: "find", tab: "find" })) },
    {
      id: "edit.replace",
      label: "Reemplazar…",
      group: "Edición",
      shortcut: "Mod+H",
      enabled: has,
      run: run(() => c.openDialog({ kind: "find", tab: "replace" })),
    },
    { id: "edit.goTo", label: "Ir a…", group: "Edición", shortcut: "Mod+G", enabled: has, run: run(() => c.openDialog({ kind: "goTo" })) },

    // ----- Fuente
    { id: "format.bold", label: "Negrita", group: "Fuente", shortcut: "Mod+B", enabled: has, active: () => style().bold === true, run: run(() => fmt.toggleStyle(c, "bold")) },
    { id: "format.italic", label: "Cursiva", group: "Fuente", shortcut: "Mod+I", enabled: has, active: () => style().italic === true, run: run(() => fmt.toggleStyle(c, "italic")) },
    {
      id: "format.underline",
      label: "Subrayado",
      group: "Fuente",
      shortcut: "Mod+U",
      enabled: has,
      active: () => Boolean(style().underline),
      run: run(() => fmt.toggleUnderline(c, true)),
    },
    {
      id: "format.underlineDouble",
      label: "Subrayado doble",
      group: "Fuente",
      enabled: has,
      active: () => style().underline === "double",
      run: run(() => fmt.toggleUnderline(c, "double")),
    },
    { id: "format.strike", label: "Tachado", group: "Fuente", shortcut: "Mod+5", enabled: has, active: () => style().strike === true, run: run(() => fmt.toggleStyle(c, "strike")) },
    { id: "format.fontGrow", label: "Aumentar tamaño de fuente", group: "Fuente", enabled: has, run: run(() => fmt.stepFontSize(c, 1)) },
    { id: "format.fontShrink", label: "Disminuir tamaño de fuente", group: "Fuente", enabled: has, run: run(() => fmt.stepFontSize(c, -1)) },
    { id: "format.fontColor", label: "Color de fuente", group: "Fuente", enabled: has, run: run(() => fmt.setStyle(c, { color: c.lastFontColor.get() })) },
    { id: "format.fill", label: "Color de relleno", group: "Fuente", enabled: has, run: run(() => fmt.setStyle(c, { fill: c.lastFill.get() })) },
    { id: "format.noFill", label: "Sin relleno", group: "Fuente", enabled: has, run: run(() => fmt.setStyle(c, { fill: null })) },
    {
      id: "format.borders",
      label: "Bordes",
      group: "Fuente",
      enabled: has,
      run: run(() => fmt.setBorders(c, c.lastBorder.get())),
    },
    { id: "format.cells", label: "Formato de celdas…", group: "Formato", shortcut: "Mod+1", enabled: has, run: run(() => c.openDialog({ kind: "formatCells", tab: "number" })) },
    {
      id: "format.cells.font",
      label: "Fuente…",
      group: "Formato",
      shortcut: "Mod+Shift+F",
      enabled: has,
      run: run(() => c.openDialog({ kind: "formatCells", tab: "font" })),
    },

    // ----- Alineación
    { id: "format.alignLeft", label: "Alinear a la izquierda", group: "Alineación", enabled: has, active: () => style().hAlign === "left", run: run(() => fmt.toggleHAlign(c, "left")) },
    { id: "format.alignCenter", label: "Centrar", group: "Alineación", enabled: has, active: () => style().hAlign === "center", run: run(() => fmt.toggleHAlign(c, "center")) },
    { id: "format.alignRight", label: "Alinear a la derecha", group: "Alineación", enabled: has, active: () => style().hAlign === "right", run: run(() => fmt.toggleHAlign(c, "right")) },
    { id: "format.alignTop", label: "Alinear en la parte superior", group: "Alineación", enabled: has, active: () => style().vAlign === "top", run: run(() => fmt.toggleVAlign(c, "top")) },
    { id: "format.alignMiddle", label: "Alinear en el medio", group: "Alineación", enabled: has, active: () => style().vAlign === "middle", run: run(() => fmt.toggleVAlign(c, "middle")) },
    {
      id: "format.alignBottom",
      label: "Alinear en la parte inferior",
      group: "Alineación",
      enabled: has,
      active: () => c.activeCell.get() !== null && (style().vAlign ?? "bottom") === "bottom",
      run: run(() => fmt.toggleVAlign(c, "bottom")),
    },
    { id: "format.wrap", label: "Ajustar texto", group: "Alineación", enabled: has, active: () => style().wrap === true, run: run(() => fmt.toggleStyle(c, "wrap")) },
    { id: "format.mergeCenter", label: "Combinar y centrar", group: "Alineación", enabled: has, active: () => fmt.activeIsMerged(c), run: run(() => fmt.toggleMergeCenter(c)) },
    { id: "format.mergeAcross", label: "Combinar horizontalmente", group: "Alineación", enabled: has, run: run(() => fmt.merge(c, "mergeAcross")) },
    { id: "format.merge", label: "Combinar celdas", group: "Alineación", enabled: has, run: run(() => fmt.merge(c, "merge")) },
    { id: "format.unmerge", label: "Separar celdas", group: "Alineación", enabled: has, run: run(() => fmt.unmerge(c)) },
    { id: "format.indentIncrease", label: "Aumentar sangría", group: "Alineación", enabled: has, run: run(() => fmt.stepIndent(c, 1)) },
    { id: "format.indentDecrease", label: "Disminuir sangría", group: "Alineación", enabled: has, run: run(() => fmt.stepIndent(c, -1)) },

    // ----- Número
    {
      id: "format.numFmt.percentInteger",
      label: "Estilo porcentual",
      group: "Número",
      shortcut: "Mod+Shift+%",
      enabled: has,
      run: run(() => fmt.setNumFmt(c, "0%")),
    },
    { id: "format.numFmt.thousands", label: "Estilo millares", group: "Número", enabled: has, run: run(() => fmt.setNumFmt(c, THOUSANDS_STYLE)) },
    { id: "format.decimals.increase", label: "Aumentar decimales", group: "Número", enabled: has, run: run(() => fmt.stepDecimals(c, 1)) },
    { id: "format.decimals.decrease", label: "Disminuir decimales", group: "Número", enabled: has, run: run(() => fmt.stepDecimals(c, -1)) },

    // ----- Celdas
    { id: "insert.rows", label: "Insertar filas de hoja", group: "Celdas", enabled: has, run: run(() => data.insertRows(c)) },
    { id: "insert.cols", label: "Insertar columnas de hoja", group: "Celdas", enabled: has, run: run(() => data.insertCols(c)) },
    { id: "insert.cells", label: "Insertar celdas…", group: "Celdas", enabled: has, run: run(() => c.openDialog({ kind: "insertCells" })) },
    { id: "insert.smart", label: "Insertar", group: "Celdas", shortcut: "Mod+Plus", enabled: has, run: run(() => data.insertOrDeleteSmart(c, true)) },
    { id: "delete.rows", label: "Eliminar filas de hoja", group: "Celdas", enabled: has, run: run(() => data.deleteRows(c)) },
    { id: "delete.cols", label: "Eliminar columnas de hoja", group: "Celdas", enabled: has, run: run(() => data.deleteCols(c)) },
    { id: "delete.cells", label: "Eliminar celdas…", group: "Celdas", enabled: has, run: run(() => c.openDialog({ kind: "deleteCells" })) },
    { id: "delete.smart", label: "Eliminar", group: "Celdas", shortcut: "Mod+Minus", enabled: has, run: run(() => data.insertOrDeleteSmart(c, false)) },
    { id: "format.rowHeight", label: "Alto de fila…", group: "Celdas", enabled: has, run: run(() => c.openDialog({ kind: "rowHeight" })) },
    { id: "format.colWidth", label: "Ancho de columna…", group: "Celdas", enabled: has, run: run(() => c.openDialog({ kind: "colWidth" })) },
    {
      id: "format.autofitCols",
      label: "Autoajustar ancho de columna",
      group: "Celdas",
      enabled: () => Boolean(c.session?.grid),
      run: run(() => data.autofitColumns(c)),
    },
    { id: "format.hideRows", label: "Ocultar filas", group: "Celdas", shortcut: "Mod+9", enabled: has, run: run(() => data.setHidden(c, "row", true)) },
    { id: "format.unhideRows", label: "Mostrar filas", group: "Celdas", shortcut: "Mod+Shift+(", enabled: has, run: run(() => data.setHidden(c, "row", false)) },
    { id: "format.hideCols", label: "Ocultar columnas", group: "Celdas", shortcut: "Mod+0", enabled: has, run: run(() => data.setHidden(c, "col", true)) },
    { id: "format.unhideCols", label: "Mostrar columnas", group: "Celdas", enabled: has, run: run(() => data.setHidden(c, "col", false)) },

    {
      id: "insert.chart",
      label: "Gráfico",
      group: "Insertar",
      shortcut: "Alt+F1",
      enabled: () => has() && c.charts.insertHandler.get() !== null,
      run: run(() => c.insertChart()),
    },

    // ----- Datos
    { id: "data.sortAsc", label: "Ordenar de A a Z", group: "Datos", enabled: has, run: run(() => data.sortQuick(c, true)) },
    { id: "data.sortDesc", label: "Ordenar de Z a A", group: "Datos", enabled: has, run: run(() => data.sortQuick(c, false)) },
    { id: "data.sortCustom", label: "Orden personalizado…", group: "Datos", enabled: has, run: run(() => c.openDialog({ kind: "sortCustom" })) },
    {
      id: "data.filter",
      label: "Filtro",
      group: "Datos",
      shortcut: "Mod+Shift+L",
      enabled: has,
      active: () => Boolean(c.sheetInfo.get()?.autoFilter),
      run: run(() => data.toggleAutoFilter(c)),
    },
    {
      id: "data.clearFilters",
      label: "Borrar filtros",
      group: "Datos",
      enabled: () => (c.sheetInfo.get()?.autoFilter?.filteredCols.length ?? 0) > 0,
      run: run(() => data.clearAllFilters(c)),
    },

    // ----- Vista
    {
      id: "view.freezePanes",
      label: "Inmovilizar paneles",
      group: "Vista",
      enabled: has,
      active: () => view.isFrozen(c.sheetInfo.get()),
      run: run(() => view.toggleFreezePanes(c)),
    },
    { id: "view.freezeTopRow", label: "Inmovilizar fila superior", group: "Vista", enabled: has, run: run(() => view.freeze(c, 1, 0)) },
    { id: "view.freezeFirstCol", label: "Inmovilizar primera columna", group: "Vista", enabled: has, run: run(() => view.freeze(c, 0, 1)) },
    { id: "view.unfreeze", label: "Movilizar paneles", group: "Vista", enabled: () => view.isFrozen(c.sheetInfo.get()), run: run(() => view.freeze(c, 0, 0)) },
    {
      id: "view.gridLines",
      label: "Líneas de cuadrícula",
      group: "Vista",
      enabled: has,
      active: () => c.sheetInfo.get()?.showGridLines !== false,
      run: run(() => view.toggleGridLines(c)),
    },
    { id: "view.zoomIn", label: "Acercar", group: "Vista", enabled: has, run: run(() => view.stepZoom(c, 1)) },
    { id: "view.zoomOut", label: "Alejar", group: "Vista", enabled: has, run: run(() => view.stepZoom(c, -1)) },
    { id: "view.zoom100", label: "Zoom al 100 %", group: "Vista", enabled: has, run: run(() => view.setZoom(c, 1)) },
  ];

  for (const preset of NUMBER_FORMAT_PRESETS) {
    defs.push({
      id: preset.command,
      label: preset.label,
      group: "Número",
      shortcut: NUMBER_SHORTCUTS[preset.id],
      enabled: has,
      active: () => c.activeCell.get()?.format.numFmt === preset.code,
      run: run(() => fmt.setNumFmt(c, preset.code)),
    });
  }

  for (const border of BORDER_PRESETS) {
    defs.push({
      id: `format.borders.${border.preset}`,
      label: border.label,
      group: "Bordes",
      shortcut: border.shortcut,
      enabled: has,
      run: run(async () => {
        const last = c.lastBorder.get();
        const style = border.preset === "thickOuter" ? "thick" : border.preset === "doubleBottom" ? "double" : last.style;
        await fmt.setBorders(c, { preset: border.preset, style, color: last.color });
        // The split button repeats this preset with the chosen line style.
        c.lastBorder.set({ preset: border.preset, style: last.style, color: last.color });
      }),
    });
  }

  return defs;
}

function toCommand(def: Def): Command {
  return {
    id: def.id,
    label: def.label,
    group: def.group,
    shortcut: def.shortcut,
    isEnabled: def.enabled,
    isActive: def.active,
    run: def.run,
  };
}

/** Registers every shell command; returns the unregister function. */
export function registerShellCommands(c: AppController): () => void {
  return c.registry.register(...shellCommandDefs(c).map(toCommand));
}
