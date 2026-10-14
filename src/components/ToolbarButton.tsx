import { forwardRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ToolbarButtonProps {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  children: ReactNode;
  className?: string;
}

/** Compact ghost icon button with a tooltip ("Negrita · Ctrl+N"). */
export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(function ToolbarButton(
  { label, shortcut, pressed = false, disabled, onClick, onDoubleClick, children, className, ...rest },
  ref,
) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          // Keep the grid (or the cell editor) focused while clicking toolbar buttons.
          onMouseDown={(event) => event.preventDefault()}
          className={cn("h-7 w-7", pressed && "bg-accent text-accent-foreground ring-1 ring-border", className)}
          {...rest}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut ? ` · ${shortcut}` : ""}
      </TooltipContent>
    </Tooltip>
  );
});
