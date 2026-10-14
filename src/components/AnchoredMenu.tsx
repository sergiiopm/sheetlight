import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

interface AnchoredMenuProps {
  /** Client coordinates of the pointer; null = closed. */
  readonly at: { readonly x: number; readonly y: number } | null;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly label: string;
}

/**
 * Context menu opened at a point (right click on the canvas grid or a sheet
 * tab). Uses the dropdown primitives with an invisible trigger at the
 * pointer, so command items are shared with the toolbar menus.
 */
export function AnchoredMenu({ at, onClose, children, label }: AnchoredMenuProps) {
  return (
    <DropdownMenu open={at !== null} onOpenChange={(open) => !open && onClose()} modal={false}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed h-0 w-0"
          style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label={label}
        align="start"
        side="bottom"
        sideOffset={2}
        collisionPadding={8}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="min-w-56"
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
