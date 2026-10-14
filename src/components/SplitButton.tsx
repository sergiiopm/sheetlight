import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { ToolbarButton } from "@/components/ToolbarButton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface SplitButtonProps {
  readonly label: string;
  readonly shortcut?: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  /** Main part: repeats the last choice (Excel). Without it the whole button opens the menu. */
  readonly onClick?: () => void;
  readonly onDoubleClick?: () => void;
  /** `menu`: children are dropdown items; `popover`: free content (color palettes). */
  readonly kind?: "menu" | "popover";
  readonly menuLabel?: string;
  /** For popovers, a function receives `close` (e.g. after picking a color). */
  readonly children: ReactNode | ((close: () => void) => ReactNode);
  readonly contentClassName?: string;
}

/** Excel split button: icon + small arrow that opens a menu or a popover. */
export function SplitButton({
  label,
  shortcut,
  icon,
  disabled,
  pressed,
  onClick,
  onDoubleClick,
  kind = "menu",
  menuLabel,
  children,
  contentClassName,
}: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const content = typeof children === "function" ? children(close) : children;
  const arrow = (
    <button
      type="button"
      aria-label={onClick ? (menuLabel ?? `Más opciones: ${label}`) : label}
      title={menuLabel ?? label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      className={cn(
        "flex h-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50",
        onClick ? "w-3.5" : "gap-0.5 px-1 text-foreground [&_svg]:size-4",
      )}
    >
      {onClick ? null : icon}
      <ChevronDown className="!size-3 text-muted-foreground" />
    </button>
  );

  const trigger =
    kind === "menu" ? (
      <DropdownMenuTrigger asChild>{arrow}</DropdownMenuTrigger>
    ) : (
      <PopoverTrigger asChild>{arrow}</PopoverTrigger>
    );

  const body = (
    <div className="flex items-center">
      {onClick ? (
        <ToolbarButton label={label} shortcut={shortcut} pressed={pressed} disabled={disabled} onClick={onClick} onDoubleClick={onDoubleClick} className="w-7 rounded-r-none">
          {icon}
        </ToolbarButton>
      ) : null}
      {trigger}
    </div>
  );

  if (kind === "menu") {
    return (
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        {body}
        <DropdownMenuContent align="start" className={contentClassName}>
          {content}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {body}
      <PopoverContent align="start" className={contentClassName}>
        {content}
      </PopoverContent>
    </Popover>
  );
}
