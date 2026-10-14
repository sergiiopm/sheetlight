import { useState, type ReactNode } from "react";
import {
  AArrowDown,
  AArrowUp,
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDownAZ,
  ArrowDownZA,
  ArrowUpDown,
  Baseline,
  BetweenHorizontalStart,
  BetweenVerticalStart,
  Bold,
  ChartColumnBig,
  ChevronDown,
  ClipboardPaste,
  Columns3,
  Copy,
  DecimalsArrowLeft,
  DecimalsArrowRight,
  Eraser,
  Filter,
  FilterX,
  Grid2x2,
  Grid3x3,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Monitor,
  Moon,
  MoveHorizontal,
  MoveVertical,
  Navigation,
  PaintBucket,
  Paintbrush,
  Percent,
  Plus,
  Redo2,
  Replace,
  Rows3,
  Save,
  Scissors,
  Search,
  Snowflake,
  Strikethrough,
  Sun,
  TableCellsMerge,
  Trash2,
  Underline,
  Undo2,
  WrapText,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { ColorPalette } from "@/components/ColorPalette";
import { CommandButton } from "@/components/CommandButton";
import { CommandMenuItem } from "@/components/CommandMenuItem";
import { FileMenu } from "@/components/FileMenu";
import { FONT_FAMILIES } from "@/components/fonts";
import { SplitButton } from "@/components/SplitButton";
import { useController } from "@/components/controller-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import type { BorderStyle } from "@/engine/contract";
import { BORDER_PRESETS } from "@/hooks/app-commands";
import * as fmt from "@/hooks/actions/format-actions";
import { FONT_SIZES } from "@/hooks/selection-ops";
import { useStore } from "@/hooks/store";
import { useCommand, useRegistryVersion } from "@/hooks/use-commands";
import { useSettings } from "@/hooks/use-settings";
import { NUMBER_FORMAT_PRESETS } from "@/lib/number-formats";
import { getSettingsStore, type ThemePreference } from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * Ribbon-lite: a tab strip (Archivo menu, Inicio, Insertar, Formato, Datos,
 * Vista) over one row of grouped commands. Every button is a registry
 * command, so state, shortcuts and tooltips match the keyboard and menus.
 */

type RibbonTab = "home" | "insert" | "format" | "data" | "view";

const TABS: ReadonlyArray<{ id: RibbonTab; label: string }> = [
  { id: "home", label: "Inicio" },
  { id: "insert", label: "Insertar" },
  { id: "format", label: "Formato" },
  { id: "data", label: "Datos" },
  { id: "view", label: "Vista" },
];

const BORDER_STYLES: ReadonlyArray<{ style: BorderStyle; label: string }> = [
  { style: "thin", label: "Fina" },
  { style: "medium", label: "Media" },
  { style: "thick", label: "Gruesa" },
  { style: "dashed", label: "Discontinua" },
  { style: "dotted", label: "Punteada" },
  { style: "double", label: "Doble" },
  { style: "hair", label: "Muy fina" },
];

function Group({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="group" aria-label={label} title={label} className={cn("flex shrink-0 items-center gap-0.5", className)}>
      {children}
    </div>
  );
}

function Divider() {
  return <Separator className="mx-1 h-6" />;
}

/** Text button with a label (ribbon commands that read better with words). */
function TextCommand({ command, icon, label }: { command: string; icon: ReactNode; label?: string }) {
  const controller = useController();
  const view = useCommand(controller.registry, command);
  if (!view.exists) return null;
  return (
    <button
      type="button"
      disabled={!view.enabled}
      aria-pressed={view.active}
      title={view.shortcut ? `${view.label} · ${view.shortcut}` : view.label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void controller.runCommand(command, "toolbar")}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4",
        view.active && "bg-accent ring-1 ring-border",
      )}
    >
      {icon}
      {label ?? view.label}
    </button>
  );
}

function ColorBar({ color }: { color: string | null | undefined }) {
  return <span className="absolute bottom-1 left-1.5 right-1.5 h-[3px] rounded-[1px]" style={{ backgroundColor: color ?? "transparent" }} />;
}

// ---------------------------------------------------------------------------
// Font group
// ---------------------------------------------------------------------------

function FontControls() {
  const controller = useController();
  const cell = useStore(controller.activeCell);
  const settings = useSettings();
  useRegistryVersion(controller.registry);
  const enabled = controller.session !== null;
  const family = cell?.format.style.fontFamily ?? settings.defaultFont.family;
  const size = cell?.format.style.fontSize ?? settings.defaultFont.size;
  const [sizeText, setSizeText] = useState<string | null>(null);

  const applySize = (text: string) => {
    setSizeText(null);
    const value = Number(text.replace(",", "."));
    if (!Number.isFinite(value) || value < 1 || value > 409) {
      controller.notify("El tamaño de fuente debe estar entre 1 y 409.", "error");
      return;
    }
    void fmt.setStyle(controller, { fontSize: Math.round(value * 2) / 2 });
    controller.focusGrid();
  };

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={!enabled}
            title="Fuente"
            onMouseDown={(event) => event.preventDefault()}
            className="flex h-7 w-32 items-center justify-between rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50"
          >
            <span className="truncate" style={{ fontFamily: family }}>
              {family}
            </span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {FONT_FAMILIES.map((name) => (
            <DropdownMenuItem key={name} onSelect={() => void fmt.setStyle(controller, { fontFamily: name })} style={{ fontFamily: name }}>
              {name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="relative flex h-7 items-center">
        <input
          aria-label="Tamaño de fuente"
          title="Tamaño de fuente"
          disabled={!enabled}
          list="sheetlight-font-sizes"
          value={sizeText ?? String(size).replace(".", ",")}
          onChange={(event) => setSizeText(event.target.value)}
          onFocus={(event) => event.target.select()}
          onBlur={() => sizeText !== null && applySize(sizeText)}
          onKeyDown={(event) => {
            if (event.key === "Enter") applySize(event.currentTarget.value);
            if (event.key === "Escape") {
              setSizeText(null);
              controller.focusGrid();
            }
          }}
          className="h-7 w-12 rounded-md border border-input bg-background px-1.5 text-xs disabled:opacity-50"
        />
        <datalist id="sheetlight-font-sizes">
          {FONT_SIZES.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </div>
      <CommandButton command="format.fontGrow">
        <AArrowUp />
      </CommandButton>
      <CommandButton command="format.fontShrink">
        <AArrowDown />
      </CommandButton>
    </>
  );
}

function FontColorButton() {
  const controller = useController();
  const color = useStore(controller.lastFontColor);
  const view = useCommand(controller.registry, "format.fontColor");
  return (
    <SplitButton
      label="Color de fuente"
      kind="popover"
      disabled={!view.enabled}
      icon={
        <span className="relative flex h-full w-full items-center justify-center">
          <Baseline className="-mt-1" />
          <ColorBar color={color} />
        </span>
      }
      onClick={() => void controller.runCommand("format.fontColor")}
    >
      {(close) => (
        <ColorPalette
          noneLabel="Automático"
          value={color}
          onPick={(picked) => {
            close();
            if (picked) controller.lastFontColor.set(picked);
            void fmt.setStyle(controller, { color: picked });
          }}
        />
      )}
    </SplitButton>
  );
}

function FillColorButton() {
  const controller = useController();
  const color = useStore(controller.lastFill);
  const view = useCommand(controller.registry, "format.fill");
  return (
    <SplitButton
      label="Color de relleno"
      kind="popover"
      disabled={!view.enabled}
      icon={
        <span className="relative flex h-full w-full items-center justify-center">
          <PaintBucket className="-mt-1" />
          <ColorBar color={color} />
        </span>
      }
      onClick={() => void controller.runCommand("format.fill")}
    >
      {(close) => (
        <ColorPalette
          noneLabel="Sin relleno"
          value={color}
          onPick={(picked) => {
            close();
            if (picked) controller.lastFill.set(picked);
            void fmt.setStyle(controller, { fill: picked });
          }}
        />
      )}
    </SplitButton>
  );
}

function BordersButton() {
  const controller = useController();
  const last = useStore(controller.lastBorder);
  const view = useCommand(controller.registry, "format.borders");
  const current = BORDER_PRESETS.find((b) => b.preset === last.preset);
  return (
    <SplitButton
      label={current?.label ?? "Bordes"}
      disabled={!view.enabled}
      icon={<Grid2x2 />}
      onClick={() => void controller.runCommand("format.borders")}
      menuLabel="Bordes"
    >
      <DropdownMenuLabel className="text-[11px] text-muted-foreground">Bordes</DropdownMenuLabel>
      {BORDER_PRESETS.map((border) => (
        <CommandMenuItem key={border.preset} command={`format.borders.${border.preset}`} />
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Estilo de línea</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={last.style}
            onValueChange={(style) => controller.lastBorder.set({ ...last, style: style as BorderStyle })}
          >
            {BORDER_STYLES.map((item) => (
              <DropdownMenuRadioItem key={item.style} value={item.style}>
                {item.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="h-3 w-3 rounded-sm border" style={{ backgroundColor: last.color }} />
          Color de línea
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="p-2">
          <ColorPalette value={last.color} onPick={(color) => controller.lastBorder.set({ ...last, color: color ?? "#000000" })} />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => controller.openDialog({ kind: "formatCells", tab: "border" })}>
        <span className="size-4" aria-hidden />
        Más bordes…
      </DropdownMenuItem>
    </SplitButton>
  );
}

// ---------------------------------------------------------------------------
// Number group
// ---------------------------------------------------------------------------

function NumberFormatPicker() {
  const controller = useController();
  const cell = useStore(controller.activeCell);
  useRegistryVersion(controller.registry);
  const code = cell?.format.numFmt ?? "General";
  const preset = NUMBER_FORMAT_PRESETS.find((p) => p.code === code);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={controller.session === null}
          title="Formato de número"
          onMouseDown={(event) => event.preventDefault()}
          className="flex h-7 w-28 items-center justify-between rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50"
        >
          <span className="truncate">{preset?.label ?? (code === "General" ? "General" : "Personalizado")}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {NUMBER_FORMAT_PRESETS.map((item) => (
          <CommandMenuItem key={item.id} command={item.command} />
        ))}
        <DropdownMenuSeparator />
        <CommandMenuItem command="format.cells" label="Más formatos de número…" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function HomeTab() {
  const controller = useController();
  return (
    <>
      <Group label="Portapapeles">
        <SplitButton
          label="Pegar"
          shortcut="Ctrl+V"
          icon={<ClipboardPaste />}
          disabled={!controller.session}
          onClick={() => void controller.runCommand("edit.paste")}
        >
          <CommandMenuItem command="edit.paste" />
          <CommandMenuItem command="edit.pasteValues" />
          <CommandMenuItem command="edit.pasteSpecial" />
        </SplitButton>
        <CommandButton command="edit.cut">
          <Scissors />
        </CommandButton>
        <CommandButton command="edit.copy">
          <Copy />
        </CommandButton>
        <CommandButton
          command="edit.formatPainter"
          label="Copiar formato (doble clic para varias veces)"
          onDoubleClick={() => {
            controller.stopFormatPainter();
            controller.startFormatPainter(true);
          }}
        >
          <Paintbrush />
        </CommandButton>
      </Group>
      <Divider />
      <Group label="Fuente">
        <FontControls />
        <CommandButton command="format.bold">
          <Bold />
        </CommandButton>
        <CommandButton command="format.italic">
          <Italic />
        </CommandButton>
        <SplitButton label="Subrayado" shortcut="Ctrl+U" icon={<Underline />} disabled={!controller.session} onClick={() => void controller.runCommand("format.underline")}>
          <CommandMenuItem command="format.underline" toggle />
          <CommandMenuItem command="format.underlineDouble" toggle />
        </SplitButton>
        <CommandButton command="format.strike">
          <Strikethrough />
        </CommandButton>
        <BordersButton />
        <FillColorButton />
        <FontColorButton />
      </Group>
      <Divider />
      <Group label="Alineación">
        <CommandButton command="format.alignTop">
          <AlignVerticalJustifyStart />
        </CommandButton>
        <CommandButton command="format.alignMiddle">
          <AlignVerticalJustifyCenter />
        </CommandButton>
        <CommandButton command="format.alignBottom">
          <AlignVerticalJustifyEnd />
        </CommandButton>
        <CommandButton command="format.alignLeft">
          <AlignLeft />
        </CommandButton>
        <CommandButton command="format.alignCenter">
          <AlignCenter />
        </CommandButton>
        <CommandButton command="format.alignRight">
          <AlignRight />
        </CommandButton>
        <CommandButton command="format.indentDecrease">
          <IndentDecrease />
        </CommandButton>
        <CommandButton command="format.indentIncrease">
          <IndentIncrease />
        </CommandButton>
        <CommandButton command="format.wrap">
          <WrapText />
        </CommandButton>
        <SplitButton label="Combinar y centrar" icon={<TableCellsMerge />} disabled={!controller.session} onClick={() => void controller.runCommand("format.mergeCenter")}>
          <CommandMenuItem command="format.mergeCenter" />
          <CommandMenuItem command="format.mergeAcross" />
          <CommandMenuItem command="format.merge" />
          <CommandMenuItem command="format.unmerge" />
        </SplitButton>
      </Group>
      <Divider />
      <Group label="Número">
        <NumberFormatPicker />
        <CommandButton command="format.numFmt.percentInteger">
          <Percent />
        </CommandButton>
        <CommandButton command="format.numFmt.thousands">
          <span className="text-[11px] font-semibold">000</span>
        </CommandButton>
        <CommandButton command="format.decimals.increase">
          <DecimalsArrowRight />
        </CommandButton>
        <CommandButton command="format.decimals.decrease">
          <DecimalsArrowLeft />
        </CommandButton>
      </Group>
      <Divider />
      <Group label="Edición">
        <SplitButton label="Borrar" icon={<Eraser />} disabled={!controller.session}>
          <CommandMenuItem command="edit.clearAll" />
          <CommandMenuItem command="edit.clearFormats" />
          <CommandMenuItem command="edit.clearContents" />
        </SplitButton>
        <SplitButton label="Ordenar y filtrar" icon={<ArrowUpDown />} disabled={!controller.session}>
          <CommandMenuItem command="data.sortAsc" icon={<ArrowDownAZ />} />
          <CommandMenuItem command="data.sortDesc" icon={<ArrowDownZA />} />
          <CommandMenuItem command="data.sortCustom" />
          <DropdownMenuSeparator />
          <CommandMenuItem command="data.filter" icon={<Filter />} />
          <CommandMenuItem command="data.clearFilters" icon={<FilterX />} />
        </SplitButton>
        <SplitButton label="Buscar y seleccionar" icon={<Search />} disabled={!controller.session}>
          <CommandMenuItem command="edit.find" icon={<Search />} />
          <CommandMenuItem command="edit.replace" icon={<Replace />} />
          <CommandMenuItem command="edit.goTo" icon={<Navigation />} />
        </SplitButton>
      </Group>
    </>
  );
}

function InsertTab() {
  return (
    <>
      <Group label="Celdas">
        <TextCommand command="insert.rows" icon={<BetweenHorizontalStart />} label="Filas" />
        <TextCommand command="insert.cols" icon={<BetweenVerticalStart />} label="Columnas" />
        <TextCommand command="insert.cells" icon={<Plus />} label="Celdas…" />
        <TextCommand command="sheet.new" icon={<Plus />} label="Hoja" />
      </Group>
      <Divider />
      <Group label="Eliminar">
        <TextCommand command="delete.rows" icon={<Rows3 />} label="Eliminar filas" />
        <TextCommand command="delete.cols" icon={<Columns3 />} label="Eliminar columnas" />
        <TextCommand command="delete.cells" icon={<Trash2 />} label="Eliminar celdas…" />
      </Group>
      <Divider />
      {/* Charts (WS6): enabled once `controller.charts.setInsertHandler` is called. */}
      <Group label="Gráficos">
        <TextCommand command="insert.chart" icon={<ChartColumnBig />} label="Gráfico" />
      </Group>
    </>
  );
}

function FormatTab() {
  return (
    <>
      <Group label="Celdas">
        <TextCommand command="format.cells" icon={<Grid3x3 />} label="Formato de celdas…" />
      </Group>
      <Divider />
      <Group label="Tamaño">
        <TextCommand command="format.rowHeight" icon={<MoveVertical />} label="Alto de fila…" />
        <TextCommand command="format.colWidth" icon={<MoveHorizontal />} label="Ancho de columna…" />
        <TextCommand command="format.autofitCols" icon={<MoveHorizontal />} label="Autoajustar" />
      </Group>
      <Divider />
      <Group label="Visibilidad">
        <SplitButton label="Ocultar y mostrar" icon={<Rows3 />}>
          <CommandMenuItem command="format.hideRows" />
          <CommandMenuItem command="format.hideCols" />
          <CommandMenuItem command="sheet.hide" />
          <DropdownMenuSeparator />
          <CommandMenuItem command="format.unhideRows" />
          <CommandMenuItem command="format.unhideCols" />
          <CommandMenuItem command="sheet.unhide" />
        </SplitButton>
      </Group>
      <Divider />
      <Group label="Hoja">
        <TextCommand command="sheet.rename" icon={<span className="text-[11px]">Aa</span>} label="Cambiar nombre" />
        <TextCommand command="sheet.duplicate" icon={<Copy />} label="Duplicar" />
      </Group>
      <Divider />
      <Group label="Borrar">
        <TextCommand command="edit.clearFormats" icon={<Eraser />} />
      </Group>
    </>
  );
}

function DataTab() {
  return (
    <>
      <Group label="Ordenar y filtrar">
        <CommandButton command="data.sortAsc">
          <ArrowDownAZ />
        </CommandButton>
        <CommandButton command="data.sortDesc">
          <ArrowDownZA />
        </CommandButton>
        <TextCommand command="data.sortCustom" icon={<ArrowUpDown />} label="Ordenar…" />
        <TextCommand command="data.filter" icon={<Filter />} />
        <TextCommand command="data.clearFilters" icon={<FilterX />} label="Borrar" />
      </Group>
      <Divider />
      <Group label="Buscar">
        <TextCommand command="edit.find" icon={<Search />} label="Buscar" />
        <TextCommand command="edit.replace" icon={<Replace />} label="Reemplazar" />
        <TextCommand command="edit.goTo" icon={<Navigation />} label="Ir a" />
      </Group>
      <Divider />
      <Group label="CSV">
        <TextCommand command="file.csvOptions" icon={<Grid3x3 />} label="Opciones CSV…" />
      </Group>
    </>
  );
}

function ThemeMenu() {
  const settings = useSettings();
  const icon = settings.theme === "dark" ? <Moon /> : settings.theme === "light" ? <Sun /> : <Monitor />;
  return (
    <SplitButton label="Tema" icon={icon}>
      <DropdownMenuRadioGroup value={settings.theme} onValueChange={(theme) => getSettingsStore().update({ theme: theme as ThemePreference })}>
        <DropdownMenuRadioItem value="light">Claro</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="dark">Oscuro</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="system">Según el sistema</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </SplitButton>
  );
}

function ViewTab() {
  return (
    <>
      <Group label="Inmovilizar">
        <SplitButton label="Inmovilizar" icon={<Snowflake />}>
          <CommandMenuItem command="view.freezePanes" toggle />
          <CommandMenuItem command="view.freezeTopRow" />
          <CommandMenuItem command="view.freezeFirstCol" />
          <CommandMenuItem command="view.unfreeze" />
        </SplitButton>
        <TextCommand command="view.gridLines" icon={<Grid3x3 />} />
      </Group>
      <Divider />
      <Group label="Zoom">
        <CommandButton command="view.zoomOut">
          <ZoomOut />
        </CommandButton>
        <TextCommand command="view.zoom100" icon={null} label="100 %" />
        <CommandButton command="view.zoomIn">
          <ZoomIn />
        </CommandButton>
      </Group>
      <Divider />
      <Group label="Tema">
        <ThemeMenu />
      </Group>
    </>
  );
}

export function Toolbar() {
  const [tab, setTab] = useState<RibbonTab>("home");
  return (
    <header className="shrink-0 border-b border-border bg-background">
      <div className="flex h-8 items-center gap-1 px-2" role="tablist" aria-label="Cinta de opciones">
        <FileMenu />
        <CommandButton command="file.save">
          <Save />
        </CommandButton>
        <CommandButton command="edit.undo">
          <Undo2 />
        </CommandButton>
        <CommandButton command="edit.redo">
          <Redo2 />
        </CommandButton>
        <Separator className="mx-1 h-5" />
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setTab(item.id)}
            className={cn(
              "h-7 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
              tab === item.id && "font-medium text-brand shadow-[inset_0_-2px_0_var(--brand)]",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="flex h-9 items-center gap-0.5 overflow-x-auto px-2 [scrollbar-width:thin]">
        {tab === "home" ? <HomeTab /> : null}
        {tab === "insert" ? <InsertTab /> : null}
        {tab === "format" ? <FormatTab /> : null}
        {tab === "data" ? <DataTab /> : null}
        {tab === "view" ? <ViewTab /> : null}
      </div>
    </header>
  );
}
