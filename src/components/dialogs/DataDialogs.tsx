import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useController } from "@/components/controller-context";
import { Check, Choice, Field, OkCancel, ShellDialog } from "@/components/dialogs/parts";
import { Button } from "@/components/ui/button";
import type { CsvOptions, SortKey } from "@/engine/contract";
import { colName, rangeName } from "@/engine/types";
import { AUTO_LABEL, CSV_DECIMALS, CSV_DELIMITERS, CSV_ENCODINGS, describeCsvOptions } from "@/files/csv";
import { prepareSort, sortRange, type SortSetup } from "@/hooks/actions/data-actions";
import { useSettings } from "@/hooks/use-settings";
import { getSettingsStore, type ThemePreference } from "@/lib/settings";
import { FONT_FAMILIES } from "@/components/fonts";

interface CloseProps {
  readonly onClose: () => void;
}

const AUTO = "auto";

/** "\t" is not a nice Radix value; map the delimiter to tokens and back. */
const toToken = (value: string | null): string => (value === null ? AUTO : value === "\t" ? "tab" : value);
const fromToken = <T extends string>(token: string): T | null => (token === AUTO ? null : ((token === "tab" ? "\t" : token) as T));

function choices<T extends string>(list: ReadonlyArray<{ value: T; label: string }>, withAuto = true) {
  const options = list.map((item) => ({ value: toToken(item.value), label: item.label }));
  return withAuto ? [{ value: AUTO, label: AUTO_LABEL }, ...options] : options;
}

// ---------------------------------------------------------------------------
// Ordenar (custom sort)
// ---------------------------------------------------------------------------

export function SortDialog({ onClose }: CloseProps) {
  const controller = useController();
  const [setup, setSetup] = useState<SortSetup | null | undefined>(undefined);
  const [hasHeader, setHasHeader] = useState(false);
  const [levels, setLevels] = useState<SortKey[]>([]);

  useEffect(() => {
    let cancelled = false;
    void prepareSort(controller).then((result) => {
      if (cancelled) return;
      if (!result) {
        onClose();
        return;
      }
      setSetup(result);
      setHasHeader(result.hasHeader);
      setLevels([{ col: result.activeCol, ascending: true }]);
    });
    return () => {
      cancelled = true;
    };
  }, [controller, onClose]);

  if (setup === undefined || setup === null) return null;
  const options = setup.columns.map((column) => {
    const header = hasHeader ? setup.headerLabels[column.col - setup.range.c0] : "";
    return { value: String(column.col), label: header ? header : `Columna ${colName(column.col)}` };
  });
  const update = (index: number, patch: Partial<SortKey>) =>
    setLevels((current) => current.map((level, i) => (i === index ? { ...level, ...patch } : level)));

  return (
    <ShellDialog
      title="Ordenar"
      description={`Rango: ${rangeName(setup.range)}`}
      className="max-w-lg"
      onClose={onClose}
      onSubmit={() => {
        onClose();
        void sortRange(controller, setup.range, levels, hasHeader);
      }}
      footer={<OkCancel onCancel={onClose} disabled={levels.length === 0} />}
    >
      <div className="flex items-center justify-between">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={levels.length >= 64}
          onClick={() => setLevels((current) => [...current, { col: setup.range.c0, ascending: true }])}
        >
          <Plus /> Agregar nivel
        </Button>
        <Check checked={hasHeader} onChange={setHasHeader}>
          Mis datos tienen encabezados
        </Check>
      </div>
      <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
        {levels.map((level, index) => (
          <div key={index} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">{index === 0 ? "Ordenar por" : "Luego por"}</span>
            <Choice ariaLabel="Columna" value={String(level.col)} onChange={(value) => update(index, { col: Number(value) })} options={options} />
            <Choice
              ariaLabel="Criterio de ordenación"
              className="w-40 shrink-0"
              value={level.ascending ? "asc" : "desc"}
              onChange={(value) => update(index, { ascending: value === "asc" })}
              options={[
                { value: "asc", label: "De A a Z" },
                { value: "desc", label: "De Z a A" },
              ]}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Eliminar nivel"
              disabled={levels.length === 1}
              onClick={() => setLevels((current) => current.filter((_, i) => i !== index))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
    </ShellDialog>
  );
}

// ---------------------------------------------------------------------------
// CSV import options (re-open the CSV with other options)
// ---------------------------------------------------------------------------

export function CsvOptionsDialog({ sessionId, onClose }: CloseProps & { sessionId: string }) {
  const controller = useController();
  const session = controller.manager.byId(sessionId);
  const detected = session?.info.csv ?? null;
  const [delimiter, setDelimiter] = useState(toToken(detected?.delimiter ?? null));
  const [encoding, setEncoding] = useState(toToken(detected?.encoding ?? null));
  const [decimal, setDecimal] = useState(toToken(detected?.decimal ?? null));
  if (!session) return null;
  const dirty = session.info.dirty;
  return (
    <ShellDialog
      title="Opciones de importación CSV"
      description={detected ? `Detectado: ${describeCsvOptions(detected)}` : undefined}
      className="max-w-md"
      onClose={onClose}
      onSubmit={() => {
        onClose();
        const csv: Partial<CsvOptions> = {
          delimiter: fromToken<NonNullable<CsvOptions["delimiter"]>>(delimiter),
          encoding: fromToken<NonNullable<CsvOptions["encoding"]>>(encoding),
          decimal: fromToken<NonNullable<CsvOptions["decimal"]>>(decimal),
        };
        void controller.manager.reopenCsv(session, csv);
      }}
      footer={<OkCancel onCancel={onClose} okLabel="Volver a abrir" />}
    >
      <Field label="Delimitador">
        <Choice ariaLabel="Delimitador" value={delimiter} onChange={setDelimiter} options={choices(CSV_DELIMITERS)} />
      </Field>
      <Field label="Codificación">
        <Choice ariaLabel="Codificación" value={encoding} onChange={setEncoding} options={choices(CSV_ENCODINGS)} />
      </Field>
      <Field label="Separador decimal">
        <Choice ariaLabel="Separador decimal" value={decimal} onChange={setDecimal} options={choices(CSV_DECIMALS)} />
      </Field>
      {dirty ? <p className="text-xs text-destructive">Se perderán los cambios que no hayas guardado en este archivo.</p> : null}
    </ShellDialog>
  );
}

// ---------------------------------------------------------------------------
// Opciones (settings)
// ---------------------------------------------------------------------------

export function OptionsDialog({ onClose }: CloseProps) {
  const settings = useSettings();
  const store = getSettingsStore();
  const sizes = [8, 9, 10, 11, 12, 14, 16];
  return (
    <ShellDialog
      title="Opciones"
      className="max-w-md"
      onClose={onClose}
      onSubmit={onClose}
      footer={
        <Button type="submit" size="sm">
          Cerrar
        </Button>
      }
    >
      <Field label="Tema">
        <Choice
          ariaLabel="Tema"
          value={settings.theme}
          onChange={(theme) => store.update({ theme: theme as ThemePreference })}
          options={[
            { value: "light", label: "Claro" },
            { value: "dark", label: "Oscuro" },
            { value: "system", label: "Según el sistema" },
          ]}
        />
      </Field>
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <Field label="Fuente predeterminada">
          <Choice
            ariaLabel="Fuente predeterminada"
            value={settings.defaultFont.family}
            onChange={(family) => store.update((s) => ({ defaultFont: { ...s.defaultFont, family } }))}
            options={(FONT_FAMILIES.includes(settings.defaultFont.family) ? FONT_FAMILIES : [settings.defaultFont.family, ...FONT_FAMILIES]).map((f) => ({ value: f, label: f }))}
          />
        </Field>
        <Field label="Tamaño">
          <Choice
            ariaLabel="Tamaño de fuente predeterminado"
            value={String(settings.defaultFont.size)}
            onChange={(size) => store.update((s) => ({ defaultFont: { ...s.defaultFont, size: Number(size) } }))}
            options={(sizes.includes(settings.defaultFont.size) ? sizes : [settings.defaultFont.size, ...sizes]).map((n) => ({ value: String(n), label: String(n) }))}
          />
        </Field>
      </div>
      <p className="text-[11px] text-muted-foreground">La fuente predeterminada se usa al editar celdas sin formato.</p>
      <div className="mt-1 text-xs font-medium">Archivos CSV</div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Delimitador al abrir">
          <Choice
            ariaLabel="Delimitador al abrir"
            value={toToken(settings.csv.delimiter)}
            onChange={(token) => store.update((s) => ({ csv: { ...s.csv, delimiter: fromToken(token) } }))}
            options={choices(CSV_DELIMITERS)}
          />
        </Field>
        <Field label="Codificación al abrir">
          <Choice
            ariaLabel="Codificación al abrir"
            value={toToken(settings.csv.encoding)}
            onChange={(token) => store.update((s) => ({ csv: { ...s.csv, encoding: fromToken(token) } }))}
            options={choices(CSV_ENCODINGS)}
          />
        </Field>
        <Field label="Separador decimal al abrir">
          <Choice
            ariaLabel="Separador decimal al abrir"
            value={toToken(settings.csv.decimal)}
            onChange={(token) => store.update((s) => ({ csv: { ...s.csv, decimal: fromToken(token) } }))}
            options={choices(CSV_DECIMALS)}
          />
        </Field>
        <Field label="Delimitador al guardar">
          <Choice
            ariaLabel="Delimitador al guardar"
            value={toToken(settings.csv.saveDelimiter)}
            onChange={(token) => store.update((s) => ({ csv: { ...s.csv, saveDelimiter: fromToken(token) ?? ";" } }))}
            options={choices(CSV_DELIMITERS, false)}
          />
        </Field>
      </div>
    </ShellDialog>
  );
}
