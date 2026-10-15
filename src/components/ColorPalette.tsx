import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/** Excel's "Office" theme colors: base row + tints/shades, then the standard colors. */
const THEME_BASE = ["#ffffff", "#000000", "#e7e6e6", "#44546a", "#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"];
const THEME_ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  THEME_BASE,
  ["#f2f2f2", "#7f7f7f", "#d0cece", "#d6dce4", "#d9e2f3", "#fbe5d5", "#ededed", "#fff2cc", "#deebf6", "#e2efd9"],
  ["#d8d8d8", "#595959", "#aeabab", "#adb9ca", "#b4c6e7", "#f7cbac", "#dbdbdb", "#fee599", "#bdd7ee", "#c5e0b3"],
  ["#bfbfbf", "#3f3f3f", "#757070", "#8496b0", "#8eaadb", "#f4b183", "#c9c9c9", "#ffd965", "#9cc3e5", "#a8d08d"],
  ["#a5a5a5", "#262626", "#3a3838", "#323f4f", "#2f5496", "#c55a11", "#7b7b7b", "#bf9000", "#2e75b5", "#538135"],
  ["#7f7f7f", "#0c0c0c", "#171616", "#222a35", "#1f3864", "#833c0b", "#525252", "#7f6000", "#1e4e79", "#375623"],
];
export const STANDARD_COLORS = ["#c00000", "#ff0000", "#ffc000", "#ffff00", "#92d050", "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0"];

const NAMES: Record<string, string> = {
  "#c00000": "Rojo oscuro",
  "#ff0000": "Rojo",
  "#ffc000": "Naranja",
  "#ffff00": "Amarillo",
  "#92d050": "Verde claro",
  "#00b050": "Verde",
  "#00b0f0": "Azul claro",
  "#0070c0": "Azul",
  "#002060": "Azul oscuro",
  "#7030a0": "Púrpura",
  "#ffffff": "Blanco",
  "#000000": "Negro",
};

interface ColorPaletteProps {
  /** Label of the "no color" entry ("Automático" for fonts, "Sin relleno" for fills); omitted = none. */
  readonly noneLabel?: string;
  readonly onPick: (color: string | null) => void;
  readonly value?: string | null;
}

function Swatch({ color, selected, onPick }: { color: string; selected: boolean; onPick: (color: string) => void }) {
  return (
    <button
      type="button"
      title={NAMES[color] ?? color}
      aria-label={NAMES[color] ?? color}
      onClick={() => onPick(color)}
      className={cn(
        "h-4 w-4 border border-black/10 hover:scale-110 hover:border-foreground focus-visible:outline-1 focus-visible:outline-ring dark:border-white/15",
        selected && "outline-2 outline-offset-1 outline-brand",
      )}
      style={{ backgroundColor: color }}
    />
  );
}

/** Excel-like color grid used by font color, fill, borders and sheet tab color. */
export function ColorPalette({ noneLabel, onPick, value }: ColorPaletteProps) {
  const current = value?.toLowerCase() ?? null;
  const customRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  // The native `change` event fires once when the system picker closes
  // (React's onChange fires on every drag step and would flood the undo stack).
  useEffect(() => {
    const input = customRef.current;
    if (!input) return;
    const onChange = () => pickRef.current(input.value);
    input.addEventListener("change", onChange);
    return () => input.removeEventListener("change", onChange);
  }, []);
  return (
    <div className="flex w-[13.5rem] flex-col gap-2 text-xs">
      {noneLabel ? (
        <button
          type="button"
          className="rounded-sm px-2 py-1 text-left hover:bg-accent"
          onClick={() => onPick(null)}
        >
          {noneLabel}
        </button>
      ) : null}
      <div>
        <div className="mb-1 text-[11px] text-muted-foreground">Colores del tema</div>
        <div className="flex flex-col gap-0.5">
          {THEME_ROWS.map((row, index) => (
            <div key={index} className={cn("flex gap-1", index === 0 && "mb-1")}>
              {row.map((color) => (
                <Swatch key={color} color={color} selected={current === color} onPick={onPick} />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1 text-[11px] text-muted-foreground">Colores estándar</div>
        <div className="flex gap-1">
          {STANDARD_COLORS.map((color) => (
            <Swatch key={color} color={color} selected={current === color} onPick={onPick} />
          ))}
        </div>
      </div>
      <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent">
        <input
          type="color"
          className="h-4 w-6 cursor-pointer border-0 bg-transparent p-0"
          ref={customRef}
          defaultValue={current ?? "#000000"}
        />
        Más colores…
      </label>
    </div>
  );
}
