import type { ReactNode } from "react";
import { FilePlus, FolderOpen, Moon, Sun } from "lucide-react";
import { ToolbarButton } from "@/components/ToolbarButton";
import { Separator } from "@/components/ui/separator";
import type { ThemeMode } from "@/lib/theme";

interface ToolbarProps {
  theme: ThemeMode;
  onNew: () => void;
  onOpen: () => void;
  onToggleTheme: () => void;
}

/** Labelled slot for a set of related toolbar buttons. */
function ToolbarGroup({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex min-w-6 items-center gap-0.5">
      {children}
    </div>
  );
}

export function Toolbar({ theme, onNew, onOpen, onToggleTheme }: ToolbarProps) {
  return (
    <header className="flex flex-wrap items-center gap-0.5 border-b border-border bg-background px-2 py-1">
      <ToolbarGroup label="Archivo">
        <ToolbarButton label="Nuevo libro" shortcut="Ctrl+N" onClick={onNew}>
          <FilePlus />
        </ToolbarButton>
        <ToolbarButton label="Abrir" shortcut="Ctrl+O" onClick={onOpen}>
          <FolderOpen />
        </ToolbarButton>
      </ToolbarGroup>

      <Separator className="mx-1" />
      {/* Pending: undo / redo, clipboard, format painter. */}
      <ToolbarGroup label="Edición" />

      <Separator className="mx-1" />
      {/* Pending: font, bold / italic / underline, colors, borders, alignment, number formats. */}
      <ToolbarGroup label="Formato" />

      <Separator className="mx-1" />
      {/* Pending: rows / columns, charts, sort and filter. */}
      <ToolbarGroup label="Insertar" />

      <div className="ml-auto flex items-center gap-0.5">
        <ToolbarButton label={theme === "dark" ? "Modo claro" : "Modo oscuro"} onClick={onToggleTheme}>
          {theme === "dark" ? <Sun /> : <Moon />}
        </ToolbarButton>
      </div>
    </header>
  );
}
