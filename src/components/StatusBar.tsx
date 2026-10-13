interface StatusBarProps {
  formatLabel: string;
  byteLength: number | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("es-ES", { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("es-ES", { maximumFractionDigits: 1 })} MB`;
}

/** Bottom status line. Selection statistics (suma, promedio, recuento) and zoom come later. */
export function StatusBar({ formatLabel, byteLength }: StatusBarProps) {
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-3 text-[11px] text-muted-foreground">
      <span>Listo</span>
      <div className="flex items-center gap-3">
        {byteLength !== null ? <span>{formatSize(byteLength)}</span> : null}
        <span>{formatLabel}</span>
        <span>100%</span>
      </div>
    </footer>
  );
}
