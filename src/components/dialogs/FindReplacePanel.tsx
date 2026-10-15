import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useController } from "@/components/controller-context";
import { Check, Choice, textInputClass } from "@/components/dialogs/parts";
import { Button } from "@/components/ui/button";
import type { FindMatch } from "@/engine/contract";
import { cellName } from "@/engine/types";
import {
  DEFAULT_FIND_OPTIONS,
  findAll,
  findNext,
  replaceAll,
  replaceOne,
  revealMatch,
  type FindOptions,
} from "@/hooks/actions/find-actions";
import { cn } from "@/lib/utils";

/** Options survive closing the panel (Excel remembers them during the session). */
let rememberedOptions: FindOptions = DEFAULT_FIND_OPTIONS;
let rememberedReplacement = "";

/**
 * "Buscar y reemplazar" (Ctrl+F / Ctrl+H). Non-modal like Excel's dialog: the
 * grid stays usable while it is open. Esc or ✕ closes it.
 */
export function FindReplacePanel({ tab: initialTab, onClose }: { tab: "find" | "replace"; onClose: () => void }) {
  const controller = useController();
  const [tab, setTab] = useState(initialTab);
  const [options, setOptionsState] = useState<FindOptions>(rememberedOptions);
  const [replacement, setReplacementState] = useState(rememberedReplacement);
  const [results, setResults] = useState<FindMatch[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setTab(initialTab), [initialTab]);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [tab]);

  const setOptions = (patch: Partial<FindOptions>) => {
    setOptionsState((current) => {
      const next = { ...current, ...patch };
      rememberedOptions = next;
      return next;
    });
    setResults(null);
  };
  const setReplacement = (value: string) => {
    rememberedReplacement = value;
    setReplacementState(value);
  };
  const run = async (fn: () => Promise<unknown>) => {
    if (busy || !options.text) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const sheetName = (id: number) => controller.session?.info.sheets.find((s) => s.id === id)?.name ?? "";

  return (
    <div
      role="dialog"
      aria-label="Buscar y reemplazar"
      className="fixed right-4 top-28 z-40 w-[26rem] rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="mb-2 flex items-center gap-1">
        {(["find", "replace"] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "border-b-2 border-transparent px-2 py-1 text-[13px] text-muted-foreground",
              tab === id && "border-brand font-medium text-foreground",
            )}
          >
            {id === "find" ? "Buscar" : "Reemplazar"}
          </button>
        ))}
        <button type="button" aria-label="Cerrar" className="ml-auto rounded-sm p-1 hover:bg-accent" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => findNext(controller, options));
        }}
      >
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-24 shrink-0">Buscar:</span>
          <input ref={inputRef} className={textInputClass} value={options.text} onChange={(event) => setOptions({ text: event.target.value })} />
        </label>
        {tab === "replace" ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="w-24 shrink-0">Reemplazar con:</span>
            <input className={textInputClass} value={replacement} onChange={(event) => setReplacement(event.target.value)} />
          </label>
        ) : null}
        <button type="button" className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground" onClick={() => setExpanded((v) => !v)}>
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Opciones
        </button>
        {expanded ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-border p-2">
            <Choice
              ariaLabel="Dentro de"
              value={options.scope}
              onChange={(scope) => setOptions({ scope: scope as FindOptions["scope"] })}
              options={[
                { value: "sheet", label: "Dentro de: Hoja" },
                { value: "workbook", label: "Dentro de: Libro" },
              ]}
            />
            <Check checked={options.matchCase} onChange={(matchCase) => setOptions({ matchCase })}>
              Coincidir mayúsculas
            </Check>
            <Choice
              ariaLabel="Buscar"
              value={options.byColumns ? "cols" : "rows"}
              onChange={(value) => setOptions({ byColumns: value === "cols" })}
              options={[
                { value: "rows", label: "Por filas" },
                { value: "cols", label: "Por columnas" },
              ]}
            />
            <Check checked={options.wholeCell} onChange={(wholeCell) => setOptions({ wholeCell })}>
              Celda completa
            </Check>
            <Choice
              ariaLabel="Buscar en"
              value={options.lookIn}
              onChange={(lookIn) => setOptions({ lookIn: lookIn as FindOptions["lookIn"] })}
              options={[
                { value: "formulas", label: "Buscar en: Fórmulas" },
                { value: "values", label: "Buscar en: Valores" },
              ]}
              disabled={tab === "replace"}
            />
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-1.5 pt-1">
          {tab === "replace" ? (
            <>
              <Button type="button" size="sm" variant="outline" disabled={!options.text || busy} onClick={() => void run(() => replaceAll(controller, { ...options, lookIn: "formulas" }, replacement))}>
                Reemplazar todos
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={!options.text || busy} onClick={() => void run(() => replaceOne(controller, { ...options, lookIn: "formulas" }, replacement))}>
                Reemplazar
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!options.text || busy}
            onClick={() => void run(async () => setResults(await findAll(controller, options)))}
          >
            Buscar todos
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={!options.text || busy} onClick={() => void run(() => findNext(controller, options, true))}>
            Anterior
          </Button>
          <Button type="submit" size="sm" disabled={!options.text || busy}>
            Buscar siguiente
          </Button>
        </div>
      </form>
      {results ? (
        <div className="mt-2 border-t border-border pt-2">
          <div className="mb-1 text-xs text-muted-foreground">
            {results.length === 0 ? "No se ha encontrado nada." : `${results.length.toLocaleString("es-ES")} celda${results.length === 1 ? "" : "s"} encontrada${results.length === 1 ? "" : "s"}`}
          </div>
          <div className="max-h-48 overflow-y-auto text-xs">
            {results.map((match) => (
              <button
                key={`${match.sheet}:${match.row}:${match.col}`}
                type="button"
                className="grid w-full grid-cols-[6rem_4rem_1fr] gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-accent"
                onClick={() => void revealMatch(controller, match)}
              >
                <span className="truncate text-muted-foreground">{sheetName(match.sheet)}</span>
                <span className="tabular-nums">{cellName(match)}</span>
                <span className="truncate">{match.display}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
