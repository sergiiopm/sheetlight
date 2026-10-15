import { useMemo, useState, type ReactNode } from "react";
import { ColorPalette } from "@/components/ColorPalette";
import { useController } from "@/components/controller-context";
import { FONT_FAMILIES } from "@/components/fonts";
import { Check, Choice, Field, OkCancel, ShellDialog, textInputClass } from "@/components/dialogs/parts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BorderPreset, BorderStyle, HAlign, VAlign } from "@/engine/contract";
import { activeIsMerged } from "@/hooks/actions/format-actions";
import type { FormatCellsTab } from "@/hooks/app-controller";
import {
  clampDecimals,
  formatCellsOps,
  formatDraft,
  numberCode,
  type FormatDraft,
  type NumberDraft,
} from "@/hooks/format-cells";
import { FONT_SIZES } from "@/hooks/selection-ops";
import { useStore } from "@/hooks/store";
import { useSettings } from "@/hooks/use-settings";
import {
  CATEGORY_LABELS,
  CURRENCY_SYMBOLS,
  CUSTOM_CODES,
  DATE_CODES,
  FRACTION_CODES,
  NEGATIVE_STYLES,
  TIME_CODES,
  delocalizeCode,
  formatPreview,
  localizeCode,
  type NumberCategory,
} from "@/lib/number-formats";
import { cn } from "@/lib/utils";

const CATEGORIES = Object.keys(CATEGORY_LABELS) as NumberCategory[];

const H_ALIGNS: ReadonlyArray<{ value: HAlign; label: string }> = [
  { value: "general", label: "General" },
  { value: "left", label: "Izquierda (sangría)" },
  { value: "center", label: "Centrar" },
  { value: "right", label: "Derecha (sangría)" },
  { value: "fill", label: "Rellenar" },
  { value: "justify", label: "Justificar" },
  { value: "centerContinuous", label: "Centrar en la selección" },
];

const V_ALIGNS: ReadonlyArray<{ value: VAlign; label: string }> = [
  { value: "top", label: "Superior" },
  { value: "middle", label: "Centrar" },
  { value: "bottom", label: "Inferior" },
];

const LINE_STYLES: ReadonlyArray<{ value: BorderStyle; label: string }> = [
  { value: "thin", label: "Fina" },
  { value: "hair", label: "Muy fina" },
  { value: "dotted", label: "Punteada" },
  { value: "dashed", label: "Discontinua" },
  { value: "medium", label: "Media" },
  { value: "thick", label: "Gruesa" },
  { value: "double", label: "Doble" },
];

const BORDER_BUTTONS: ReadonlyArray<{ preset: BorderPreset; label: string }> = [
  { preset: "none", label: "Ninguno" },
  { preset: "outer", label: "Contorno" },
  { preset: "inner", label: "Interior" },
  { preset: "all", label: "Todos" },
  { preset: "top", label: "Superior" },
  { preset: "bottom", label: "Inferior" },
  { preset: "left", label: "Izquierdo" },
  { preset: "right", label: "Derecho" },
  { preset: "innerHorizontal", label: "Horizontal interior" },
  { preset: "innerVertical", label: "Vertical interior" },
];

/** "Formato de celdas" (Ctrl+1): Número, Alineación, Fuente, Bordes, Relleno. */
export function FormatCellsDialog({ tab, onClose }: { tab: FormatCellsTab; onClose: () => void }) {
  const controller = useController();
  const settings = useSettings();
  const cell = useStore(controller.activeCell);
  const initial = useMemo(
    () => formatDraft(cell?.format ?? null, settings.defaultFont, activeIsMerged(controller)),
    // The dialog edits a snapshot taken when it opens.
    [],
  );
  const [draft, setDraft] = useState<FormatDraft>(initial);
  const [current, setCurrent] = useState<FormatCellsTab>(tab);
  const sample = cell?.value.type === "number" ? cell.value.value : cell?.value.type === "text" ? cell.value.value : 1234.5678;

  const submit = () => {
    const selection = controller.selection;
    onClose();
    if (!selection) return;
    const ops = formatCellsOps(selection.sheet, selection.ranges, initial, draft);
    if (ops.length > 0) void controller.apply(ops);
  };

  return (
    <ShellDialog title="Formato de celdas" className="max-w-xl" onClose={onClose} onSubmit={submit} footer={<OkCancel onCancel={onClose} />}>
      <Tabs value={current} onValueChange={(value) => setCurrent(value as FormatCellsTab)}>
        <TabsList>
          <TabsTrigger value="number">Número</TabsTrigger>
          <TabsTrigger value="alignment">Alineación</TabsTrigger>
          <TabsTrigger value="font">Fuente</TabsTrigger>
          <TabsTrigger value="border">Bordes</TabsTrigger>
          <TabsTrigger value="fill">Relleno</TabsTrigger>
        </TabsList>
        <div className="h-[19rem] overflow-y-auto">
          <TabsContent value="number">
            <NumberTab draft={draft.number} sample={sample} onChange={(number) => setDraft({ ...draft, number })} />
          </TabsContent>
          <TabsContent value="alignment">
            <AlignmentTab draft={draft} onChange={setDraft} />
          </TabsContent>
          <TabsContent value="font">
            <FontTab draft={draft} onChange={setDraft} />
          </TabsContent>
          <TabsContent value="border">
            <BorderTab draft={draft} onChange={setDraft} />
          </TabsContent>
          <TabsContent value="fill">
            <FillTab draft={draft} onChange={setDraft} />
          </TabsContent>
        </div>
      </Tabs>
    </ShellDialog>
  );
}

// ---------------------------------------------------------------------------
// Número
// ---------------------------------------------------------------------------

function NumberTab({ draft, sample, onChange }: { draft: NumberDraft; sample: number | string; onChange: (draft: NumberDraft) => void }) {
  const code = numberCode(draft);
  const preview = formatPreview(sample, code);
  const set = (patch: Partial<NumberDraft>) => onChange({ ...draft, ...patch });
  const decimalsField = (
    <Field label="Posiciones decimales" className="w-36">
      <input
        type="number"
        min={0}
        max={30}
        className={textInputClass}
        value={draft.decimals}
        onChange={(event) => set({ decimals: clampDecimals(Number(event.target.value)) })}
      />
    </Field>
  );
  const symbolField = (
    <Field label="Símbolo" className="w-44">
      <Choice
        ariaLabel="Símbolo"
        value={draft.symbol || "none"}
        onChange={(value) => set({ symbol: value === "none" ? "" : value })}
        options={CURRENCY_SYMBOLS.map((s) => ({ value: s.id || "none", label: s.label }))}
      />
    </Field>
  );
  const negativeField = (
    <Field label="Números negativos" group>
      <div className="flex flex-col rounded-md border border-border p-1">
        {NEGATIVE_STYLES.map((style) => (
          <button
            key={style.id}
            type="button"
            className={cn(
              "rounded-sm px-2 py-0.5 text-left text-[13px] hover:bg-accent",
              (style.id === "red" || style.id === "redParens") && "text-red-600",
              draft.negative === style.id && "bg-accent font-medium",
            )}
            onClick={() => set({ negative: style.id })}
          >
            {style.label}
          </button>
        ))}
      </div>
    </Field>
  );

  const codeList = (codes: ReadonlyArray<{ code: string; label: string }>, value: string, onPick: (code: string) => void) => (
    <div className="flex max-h-44 flex-col overflow-y-auto rounded-md border border-border p-1">
      {codes.map((item) => (
        <button
          key={item.code}
          type="button"
          className={cn("rounded-sm px-2 py-0.5 text-left text-[13px] hover:bg-accent", value === item.code && "bg-accent font-medium")}
          onClick={() => onPick(item.code)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
  const withPreview = (codes: ReadonlyArray<string>) => codes.map((c) => ({ code: c, label: formatPreview(typeof sample === "number" ? sample : 45658.5, c).text }));

  return (
    <div className="grid grid-cols-[9rem_1fr] gap-4">
      <div className="flex flex-col rounded-md border border-border p-1" role="listbox" aria-label="Categoría">
        {CATEGORIES.map((category) => (
          <button
            key={category}
            type="button"
            role="option"
            aria-selected={draft.category === category}
            className={cn("rounded-sm px-2 py-0.5 text-left text-[13px] hover:bg-accent", draft.category === category && "bg-accent font-medium")}
            onClick={() => set({ category, customCode: category === "custom" ? draft.customCode : numberCode({ ...draft, category }) })}
          >
            {CATEGORY_LABELS[category]}
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <Field label="Muestra">
          <div className="h-8 truncate rounded-md border border-border bg-workspace px-2.5 leading-8" style={{ color: preview.color ?? undefined }}>
            {preview.text || " "}
          </div>
        </Field>
        {draft.category === "general" ? <p className="text-xs text-muted-foreground">Las celdas con formato General no tienen un formato de número específico.</p> : null}
        {draft.category === "text" ? <p className="text-xs text-muted-foreground">Las celdas con formato de texto se tratan como texto aunque contengan un número.</p> : null}
        {draft.category === "number" ? (
          <>
            {decimalsField}
            <Check checked={draft.thousands} onChange={(thousands) => set({ thousands })}>
              Usar separador de miles (.)
            </Check>
            {negativeField}
          </>
        ) : null}
        {draft.category === "currency" ? (
          <>
            <div className="flex gap-3">
              {decimalsField}
              {symbolField}
            </div>
            {negativeField}
          </>
        ) : null}
        {draft.category === "accounting" ? (
          <div className="flex gap-3">
            {decimalsField}
            {symbolField}
          </div>
        ) : null}
        {draft.category === "percent" || draft.category === "scientific" ? decimalsField : null}
        {draft.category === "date" ? <Field label="Tipo" group>{codeList(withPreview(DATE_CODES), draft.dateCode, (dateCode) => set({ dateCode }))}</Field> : null}
        {draft.category === "time" ? <Field label="Tipo" group>{codeList(withPreview(TIME_CODES), draft.timeCode, (timeCode) => set({ timeCode }))}</Field> : null}
        {draft.category === "fraction" ? <Field label="Tipo" group>{codeList(FRACTION_CODES, draft.fractionCode, (fractionCode) => set({ fractionCode }))}</Field> : null}
        {draft.category === "custom" ? (
          <>
            <Field label="Tipo">
              <input
                className={cn(textInputClass, "font-mono")}
                value={localizeCode(draft.customCode)}
                onChange={(event) => set({ customCode: delocalizeCode(event.target.value) })}
              />
            </Field>
            {codeList(
              CUSTOM_CODES.map((c) => ({ code: c, label: localizeCode(c) })),
              draft.customCode,
              (customCode) => set({ customCode }),
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alineación
// ---------------------------------------------------------------------------

function AlignmentTab({ draft, onChange }: { draft: FormatDraft; onChange: (draft: FormatDraft) => void }) {
  const a = draft.alignment;
  const set = (patch: Partial<FormatDraft["alignment"]>) => onChange({ ...draft, alignment: { ...a, ...patch } });
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="flex flex-col gap-3">
        <Field label="Horizontal">
          <Choice ariaLabel="Alineación horizontal" value={a.hAlign} onChange={(hAlign) => set({ hAlign: hAlign as HAlign })} options={H_ALIGNS} />
        </Field>
        <Field label="Vertical">
          <Choice ariaLabel="Alineación vertical" value={a.vAlign} onChange={(vAlign) => set({ vAlign: vAlign as VAlign })} options={V_ALIGNS} />
        </Field>
        <Field label="Sangría" className="w-28">
          <input type="number" min={0} max={15} className={textInputClass} value={a.indent} onChange={(event) => set({ indent: Number(event.target.value) || 0 })} />
        </Field>
      </div>
      <div className="flex flex-col gap-3">
        <div className="text-xs text-muted-foreground">Control del texto</div>
        <Check checked={a.wrap} onChange={(wrap) => set({ wrap })}>
          Ajustar texto
        </Check>
        <Check checked={a.shrinkToFit} onChange={(shrinkToFit) => set({ shrinkToFit })}>
          Reducir hasta ajustar
        </Check>
        <Check checked={a.merge} onChange={(merge) => set({ merge })}>
          Combinar celdas
        </Check>
        <Field label="Orientación (grados)" className="w-36">
          <input
            type="number"
            min={-90}
            max={90}
            className={textInputClass}
            value={a.rotation === 255 ? 0 : a.rotation}
            onChange={(event) => set({ rotation: Number(event.target.value) || 0 })}
          />
        </Field>
        <Check checked={a.rotation === 255} onChange={(vertical) => set({ rotation: vertical ? 255 : 0 })}>
          Texto vertical
        </Check>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fuente
// ---------------------------------------------------------------------------

function ColorField({ label, value, noneLabel, onChange }: { label: string; value: string | null; noneLabel: string; onChange: (color: string | null) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Field label={label}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 text-[13px]">
            <span className="h-4 w-8 rounded-sm border border-border" style={{ backgroundColor: value ?? "transparent" }} />
            {value ?? noneLabel}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start">
          <ColorPalette
            noneLabel={noneLabel}
            value={value}
            onPick={(color) => {
              setOpen(false);
              onChange(color);
            }}
          />
        </PopoverContent>
      </Popover>
    </Field>
  );
}

function FontTab({ draft, onChange }: { draft: FormatDraft; onChange: (draft: FormatDraft) => void }) {
  const f = draft.font;
  const set = (patch: Partial<FormatDraft["font"]>) => onChange({ ...draft, font: { ...f, ...patch } });
  const families = FONT_FAMILIES.includes(f.family) ? FONT_FAMILIES : [f.family, ...FONT_FAMILIES];
  const sizes = FONT_SIZES.includes(f.size) ? FONT_SIZES : [...FONT_SIZES, f.size].sort((x, y) => x - y);
  const style = f.bold ? (f.italic ? "boldItalic" : "bold") : f.italic ? "italic" : "regular";
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[1fr_9rem_6rem] gap-3">
        <Field label="Fuente">
          <Choice ariaLabel="Fuente" value={f.family} onChange={(family) => set({ family })} options={families.map((name) => ({ value: name, label: name }))} />
        </Field>
        <Field label="Estilo">
          <Choice
            ariaLabel="Estilo de fuente"
            value={style}
            onChange={(value) => set({ bold: value === "bold" || value === "boldItalic", italic: value === "italic" || value === "boldItalic" })}
            options={[
              { value: "regular", label: "Normal" },
              { value: "italic", label: "Cursiva" },
              { value: "bold", label: "Negrita" },
              { value: "boldItalic", label: "Negrita cursiva" },
            ]}
          />
        </Field>
        <Field label="Tamaño">
          <Choice ariaLabel="Tamaño" value={String(f.size)} onChange={(size) => set({ size: Number(size) })} options={sizes.map((n) => ({ value: String(n), label: String(n) }))} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Subrayado">
          <Choice
            ariaLabel="Subrayado"
            value={f.underline}
            onChange={(underline) => set({ underline: underline as FormatDraft["font"]["underline"] })}
            options={[
              { value: "none", label: "Ninguno" },
              { value: "single", label: "Simple" },
              { value: "double", label: "Doble" },
            ]}
          />
        </Field>
        <ColorField label="Color" value={f.color} noneLabel="Automático" onChange={(color) => set({ color })} />
      </div>
      <Check checked={f.strike} onChange={(strike) => set({ strike })}>
        Tachado
      </Check>
      <Preview>
        <span
          style={{
            fontFamily: f.family,
            fontSize: `${Math.min(f.size, 28)}pt`,
            fontWeight: f.bold ? 700 : 400,
            fontStyle: f.italic ? "italic" : "normal",
            textDecoration: [f.underline !== "none" ? "underline" : "", f.strike ? "line-through" : ""].join(" ").trim() || "none",
            textDecorationStyle: f.underline === "double" ? "double" : "solid",
            color: f.color ?? undefined,
            backgroundColor: draft.fill ?? undefined,
          }}
        >
          AaBbCcYyZz
        </span>
      </Preview>
    </div>
  );
}

function Preview({ children }: { children: ReactNode }) {
  return (
    <Field label="Vista previa" group>
      <div className="flex h-16 items-center justify-center overflow-hidden rounded-md border border-border bg-white text-black">{children}</div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Bordes
// ---------------------------------------------------------------------------

function BorderTab({ draft, onChange }: { draft: FormatDraft; onChange: (draft: FormatDraft) => void }) {
  const [style, setStyle] = useState<BorderStyle>("thin");
  const [color, setColor] = useState("#000000");
  const add = (preset: BorderPreset) => onChange({ ...draft, borders: [...draft.borders, { preset, style, color }] });
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-4">
      <div className="flex flex-col gap-3">
        <Field label="Estilo de línea">
          <Choice ariaLabel="Estilo de línea" value={style} onChange={(value) => setStyle(value as BorderStyle)} options={LINE_STYLES} />
        </Field>
        <ColorField label="Color" value={color} noneLabel="Automático" onChange={(value) => setColor(value ?? "#000000")} />
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-xs text-muted-foreground">Haz clic en un borde para aplicarlo con el estilo y el color elegidos.</div>
        <div className="grid grid-cols-2 gap-1.5">
          {BORDER_BUTTONS.map((button) => (
            <button key={button.preset} type="button" className="h-8 rounded-md border border-input px-2 text-left text-[13px] hover:bg-accent" onClick={() => add(button.preset)}>
              {button.label}
            </button>
          ))}
        </div>
        {draft.borders.length > 0 ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Se aplicará: {draft.borders.map((b) => BORDER_BUTTONS.find((x) => x.preset === b.preset)?.label.toLowerCase()).join(", ")}
            </span>
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => onChange({ ...draft, borders: [] })}>
              Deshacer
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relleno
// ---------------------------------------------------------------------------

function FillTab({ draft, onChange }: { draft: FormatDraft; onChange: (draft: FormatDraft) => void }) {
  return (
    <div className="grid grid-cols-[14rem_1fr] gap-4">
      <div role="group" aria-label="Color de fondo" className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Color de fondo</span>
        <ColorPalette noneLabel="Sin color" value={draft.fill} onPick={(fill) => onChange({ ...draft, fill })} />
      </div>
      <Preview>
        <div className="h-full w-full" style={{ backgroundColor: draft.fill ?? "transparent" }} />
      </Preview>
    </div>
  );
}
