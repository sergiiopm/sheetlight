import type { ReactNode } from "react";
import { useController } from "@/components/controller-context";
import { DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuShortcut } from "@/components/ui/dropdown-menu";
import { useCommand } from "@/hooks/use-commands";
import type { CommandId } from "@/model/commands";

interface CommandMenuItemProps {
  readonly command: CommandId;
  readonly label?: string;
  readonly icon?: ReactNode;
  /** Render as a checkbox item showing the command's active state. */
  readonly toggle?: boolean;
  readonly source?: "menu" | "contextMenu";
}

/** Dropdown/context menu entry bound to a registry command. */
export function CommandMenuItem({ command, label, icon, toggle = false, source = "menu" }: CommandMenuItemProps) {
  const controller = useController();
  const view = useCommand(controller.registry, command);
  if (!view.exists) return null;
  const run = () => void controller.runCommand(command, source);
  if (toggle) {
    return (
      <DropdownMenuCheckboxItem checked={view.active} disabled={!view.enabled} onSelect={run}>
        {label ?? view.label}
        {view.shortcut ? <DropdownMenuShortcut>{view.shortcut}</DropdownMenuShortcut> : null}
      </DropdownMenuCheckboxItem>
    );
  }
  return (
    <DropdownMenuItem disabled={!view.enabled} onSelect={run}>
      {icon ?? <span className="size-4" aria-hidden />}
      {label ?? view.label}
      {view.shortcut ? <DropdownMenuShortcut>{view.shortcut}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  );
}
