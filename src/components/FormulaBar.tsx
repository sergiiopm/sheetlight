import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

/**
 * Name box + formula input. Visual placeholder only: selection and editing are
 * wired to the grid and engine in later phases (see src/editor).
 */
export function FormulaBar() {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-workspace px-2">
      <Input
        aria-label="Cuadro de nombres"
        value="A1"
        readOnly
        className="h-7 w-24 shrink-0 font-mono text-xs"
      />
      <Separator />
      <span className="w-6 shrink-0 select-none text-center font-serif text-sm italic text-muted-foreground" aria-hidden>
        fx
      </span>
      <Input
        aria-label="Barra de fórmulas"
        disabled
        className="h-7 min-w-0 flex-1 font-mono text-xs"
      />
    </div>
  );
}
