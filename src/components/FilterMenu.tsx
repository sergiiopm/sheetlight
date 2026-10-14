import { useEffect, useMemo, useState } from "react";
import { ArrowDownAZ, ArrowDownZA, FilterX, Search } from "lucide-react";
import { useController } from "@/components/controller-context";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import type { FilterValue } from "@/engine/contract";
import { colName } from "@/engine/types";
import { filterColumn, sortFilterColumn } from "@/hooks/actions/data-actions";
import type { FilterMenuState } from "@/hooks/app-controller";
import { useStore } from "@/hooks/store";

const VALUE_LIMIT = 10_000;

/** Autofilter dropdown of a header cell: sort, search and the value checklist. */
export function FilterMenu() {
  const controller = useController();
  const state = useStore(controller.filterMenu);
  const close = () => {
    controller.filterMenu.set(null);
    controller.focusGrid();
  };
  return (
    <Popover open={state !== null} onOpenChange={(open) => !open && close()}>
      <PopoverAnchor asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed"
          style={state ? { left: state.anchor.x, top: state.anchor.y, width: state.anchor.width, height: state.anchor.height } : { left: 0, top: 0 }}
        />
      </PopoverAnchor>
      <PopoverContent align="start" className="w-64 p-0" onCloseAutoFocus={(event) => event.preventDefault()}>
        {state ? <FilterMenuBody key={`${state.sessionId}:${state.sheet}:${state.col}`} state={state} onClose={close} /> : null}
      </PopoverContent>
    </Popover>
  );
}

function FilterMenuBody({ state, onClose }: { state: FilterMenuState; onClose: () => void }) {
  const controller = useController();
  const [values, setValues] = useState<FilterValue[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const session = controller.manager.byId(state.sessionId);
  const filtered = useStore(controller.sheetInfo)?.autoFilter?.filteredCols.includes(state.col) ?? false;

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    controller.engine
      .getFilterValues(session.doc, state.sheet, state.col, VALUE_LIMIT)
      .then((list) => {
        if (cancelled) return;
        setValues(list);
        setChecked(new Set(list.filter((v) => v.selected).map((v) => v.value)));
      })
      .catch(() => !cancelled && setValues([]));
    return () => {
      cancelled = true;
    };
  }, [controller, session, state.sheet, state.col]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (values ?? []).filter((v) => !needle || v.value.toLowerCase().includes(needle));
  }, [values, query]);
  const allShownChecked = shown.length > 0 && shown.every((v) => checked.has(v.value));

  const toggle = (value: string) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const accept = () => {
    const all = values ?? [];
    // With a search, Excel keeps only the matching values that are checked.
    const keep = query.trim() ? shown.filter((v) => checked.has(v.value)) : all.filter((v) => checked.has(v.value));
    const everything = !query.trim() && keep.length === all.length;
    if (keep.length === 0) return;
    void filterColumn(controller, state.col, everything ? null : keep.map((v) => v.value));
    onClose();
  };

  const header = `Columna ${colName(state.col)}`;
  return (
    <div className="flex flex-col text-[13px]">
      <div className="flex flex-col p-1">
        <button type="button" className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent" onClick={() => { void sortFilterColumn(controller, state.col, true); onClose(); }}>
          <ArrowDownAZ className="h-4 w-4" /> Ordenar de A a Z
        </button>
        <button type="button" className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent" onClick={() => { void sortFilterColumn(controller, state.col, false); onClose(); }}>
          <ArrowDownZA className="h-4 w-4" /> Ordenar de Z a A
        </button>
        <button
          type="button"
          disabled={!filtered}
          className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:opacity-40"
          onClick={() => {
            void filterColumn(controller, state.col, null);
            onClose();
          }}
        >
          <FilterX className="h-4 w-4" /> Borrar filtro de «{header}»
        </button>
      </div>
      <div className="border-t border-border p-2">
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-input bg-background px-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            autoFocus
            aria-label="Buscar valores"
            placeholder="Buscar"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") accept();
            }}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none"
          />
        </label>
        <div className="mt-2 h-48 overflow-y-auto rounded-md border border-border p-1 text-xs">
          {values === null ? (
            <div className="p-2 text-muted-foreground">Cargando…</div>
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 hover:bg-accent">
                <input
                  type="checkbox"
                  checked={allShownChecked}
                  onChange={() =>
                    setChecked((current) => {
                      const next = new Set(current);
                      for (const v of shown) {
                        if (allShownChecked) next.delete(v.value);
                        else next.add(v.value);
                      }
                      return next;
                    })
                  }
                />
                (Seleccionar todo)
              </label>
              {shown.map((v) => (
                <label key={v.value} className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 hover:bg-accent">
                  <input type="checkbox" checked={checked.has(v.value)} onChange={() => toggle(v.value)} />
                  <span className="min-w-0 flex-1 truncate">{v.value === "" ? "(Vacías)" : v.value}</span>
                  <span className="text-muted-foreground tabular-nums">{v.count.toLocaleString("es-ES")}</span>
                </label>
              ))}
              {values.length >= VALUE_LIMIT ? <div className="px-1 py-0.5 text-muted-foreground">No se muestran todos los elementos.</div> : null}
            </>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border p-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button size="sm" onClick={accept} disabled={values === null || (query.trim() ? shown : values).every((v) => !checked.has(v.value))}>
          Aceptar
        </Button>
      </div>
    </div>
  );
}
