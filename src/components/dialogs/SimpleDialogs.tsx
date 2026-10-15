import { useEffect, useState } from "react";
import packageInfo from "../../../package.json";
import { useController } from "@/components/controller-context";
import { Check, Field, OkCancel, Radio, ShellDialog, textInputClass } from "@/components/dialogs/parts";
import { Button } from "@/components/ui/button";
import type { PasteMode } from "@/engine/contract";
import type { SheetId } from "@/engine/types";
import {
  charsToPx,
  currentSize,
  pointsToPx,
  pxToChars,
  pxToPoints,
  setHidden,
  setSize,
  shiftCells,
} from "@/hooks/actions/data-actions";
import { goTo } from "@/hooks/actions/find-actions";
import { deleteSheet, setSheetHidden } from "@/hooks/actions/sheet-actions";
import type { CellShift } from "@/hooks/selection-ops";

interface CloseProps {
  readonly onClose: () => void;
}

// ---------------------------------------------------------------------------
// Ir a (Ctrl+G / F5)
// ---------------------------------------------------------------------------

export function GoToDialog({ onClose }: CloseProps) {
  const controller = useController();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const message = await goTo(controller, text);
    if (message) setError(message);
    else onClose();
  };
  return (
    <ShellDialog title="Ir a" onClose={onClose} onSubmit={() => void submit()} footer={<OkCancel onCancel={onClose} disabled={!text.trim()} />}>
      <Field label="Referencia">
        <input
          autoFocus
          className={textInputClass}
          placeholder="Por ejemplo: B7, A1:C10, Hoja2!A1"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
        />
      </Field>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </ShellDialog>
  );
}

// ---------------------------------------------------------------------------
// Insertar / Eliminar celdas
// ---------------------------------------------------------------------------

export function ShiftCellsDialog({ insert, onClose }: CloseProps & { insert: boolean }) {
  const controller = useController();
  const [shift, setShift] = useState<CellShift>(insert ? "down" : "up");
  const options: ReadonlyArray<{ value: CellShift; label: string }> = insert
    ? [
        { value: "right", label: "Desplazar las celdas hacia la derecha" },
        { value: "down", label: "Desplazar las celdas hacia abajo" },
        { value: "entireRow", label: "Insertar toda una fila" },
        { value: "entireCol", label: "Insertar toda una columna" },
      ]
    : [
        { value: "left", label: "Desplazar las celdas hacia la izquierda" },
        { value: "up", label: "Desplazar las celdas hacia arriba" },
        { value: "entireRow", label: "Toda la fila" },
        { value: "entireCol", label: "Toda la columna" },
      ];
  return (
    <ShellDialog
      title={insert ? "Insertar" : "Eliminar"}
      className="max-w-sm"
      onClose={onClose}
      onSubmit={() => {
        onClose();
        void shiftCells(controller, insert, shift);
      }}
      footer={<OkCancel onCancel={onClose} />}
    >
      <div className="flex flex-col gap-2">
        {options.map((option) => (
          <Radio key={option.value} name="shift" value={option.value} current={shift} onChange={setShift}>
            {option.label}
          </Radio>
        ))}
      </div>
    </ShellDialog>
  );
}

// ---------------------------------------------------------------------------
// Pegado especial (Ctrl+Alt+V)
// ---------------------------------------------------------------------------

const PASTE_MODES: ReadonlyArray<{ value: PasteMode; label: string }> = [
  { value: "all", label: "Todo" },
  { value: "formulas", label: "Fórmulas" },
  { value: "values", label: "Valores" },
  { value: "formats", label: "Formatos" },
  { value: "transpose", label: "Transponer" },
];

export function PasteSpecialDialog({ onClose }: CloseProps) {
  const controller = useController();
  const [mode, setMode] = useState<PasteMode>("all");
  return (
    <ShellDialog
      title="Pegado especial"
      className="max-w-sm"
      onClose={onClose}
      onSubmit={() => {
        onClose();
        void controller.paste(mode);
      }}
      footer={<OkCancel onCancel={onClose} />}
    >
      <div className="flex flex-col gap-2">
        {PASTE_MODES.map((option) => (
          <Radio key={option.value} name="paste" value={option.value} current={mode} onChange={setMode}>
            {option.label}
          </Radio>
        ))}
      </div>
    </ShellDialog>
  );
}

// ---------------------------------------------------------------------------
// Alto de fila / Ancho de columna
// ---------------------------------------------------------------------------

export function SizeDialog({ axis, onClose }: CloseProps & { axis: "row" | "col" }) {
  const controller = useController();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void currentSize(controller, axis).then((px) => {
      if (cancelled) return;
      const value = axis === "row" ? pxToPoints(px) : pxToChars(px);
      setText(String(value).replace(".", ","));
    });
    return () => {
      cancelled = true;
    };
  }, [controller, axis]);

  const value = Number((text ?? "").replace(",", "."));
  const max = axis === "row" ? 409 : 255;
  const valid = text !== null && text.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= max;
  return (
    <ShellDialog
      title={axis === "row" ? "Alto de fila" : "Ancho de columna"}
      className="max-w-xs"
      onClose={onClose}
      onSubmit={() => {
        if (!valid) return;
        onClose();
        // Excel hides rows/columns sized to 0.
        if (value === 0) void setHidden(controller, axis, true);
        else void setSize(controller, axis, axis === "row" ? pointsToPx(value) : charsToPx(value));
      }}
      footer={<OkCancel onCancel={onClose} disabled={!valid} />}
    >
      <Field label={axis === "row" ? "Alto de fila (puntos)" : "Ancho de columna (caracteres)"}>
        <input autoFocus className={textInputClass} inputMode="decimal" value={text ?? ""} onChange={(event) => setText(event.target.value)} />
      </Field>
      {!valid && text !== null ? <p className="text-xs text-destructive">Escribe un número entre 0 y {max}.</p> : null}
    </ShellDialog>
  );
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export function DeleteSheetDialog({ sheet, onClose }: CloseProps & { sheet: SheetId }) {
  const controller = useController();
  const name = controller.session?.info.sheets.find((s) => s.id === sheet)?.name ?? "";
  return (
    <ShellDialog
      title="Eliminar hoja"
      description={`Se eliminará permanentemente la hoja «${name}». Podrás deshacerlo con Ctrl+Z.`}
      className="max-w-sm"
      onClose={onClose}
      onSubmit={() => {
        onClose();
        void deleteSheet(controller, sheet);
      }}
      footer={<OkCancel onCancel={onClose} okLabel="Eliminar" />}
    />
  );
}

export function UnhideSheetsDialog({ onClose }: CloseProps) {
  const controller = useController();
  const hidden = controller.session?.info.sheets.filter((s) => s.hidden) ?? [];
  const [selected, setSelected] = useState<Set<SheetId>>(() => new Set(hidden.slice(0, 1).map((s) => s.id)));
  return (
    <ShellDialog
      title="Mostrar"
      className="max-w-sm"
      onClose={onClose}
      onSubmit={() => {
        onClose();
        void (async () => {
          for (const id of selected) await setSheetHidden(controller, id, false);
        })();
      }}
      footer={<OkCancel onCancel={onClose} disabled={selected.size === 0} />}
    >
      <Field label="Mostrar una o más hojas" group>
        <div className="max-h-48 overflow-y-auto rounded-md border border-border p-1">
          {hidden.length === 0 ? <p className="p-2 text-xs text-muted-foreground">No hay hojas ocultas.</p> : null}
          {hidden.map((sheet) => (
            <div key={sheet.id} className="px-1 py-0.5">
              <Check
                checked={selected.has(sheet.id)}
                onChange={(on) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (on) next.add(sheet.id);
                    else next.delete(sheet.id);
                    return next;
                  })
                }
              >
                {sheet.name}
              </Check>
            </div>
          ))}
        </div>
      </Field>
    </ShellDialog>
  );
}

// ---------------------------------------------------------------------------
// Acerca de
// ---------------------------------------------------------------------------

export function AboutDialog({ onClose }: CloseProps) {
  return (
    <ShellDialog
      title="Acerca de Sheetlight"
      className="max-w-sm"
      onClose={onClose}
      onSubmit={onClose}
      footer={
        <Button type="submit" size="sm">
          Cerrar
        </Button>
      }
    >
      <div className="flex flex-col gap-1 text-[13px]">
        <p>Hoja de cálculo ligera, rápida y local para Windows.</p>
        <p className="text-muted-foreground">Versión {packageInfo.version} · Licencia MIT</p>
        <p className="text-muted-foreground">Motor de fórmulas: IronCalc.</p>
      </div>
    </ShellDialog>
  );
}
