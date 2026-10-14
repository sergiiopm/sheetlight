import type { ReactNode } from "react";
import { useController } from "@/components/controller-context";
import { ToolbarButton } from "@/components/ToolbarButton";
import { useCommand } from "@/hooks/use-commands";
import type { CommandId } from "@/model/commands";

interface CommandButtonProps {
  readonly command: CommandId;
  /** Overrides the command label in the tooltip. */
  readonly label?: string;
  readonly children: ReactNode;
  readonly className?: string;
  /** Double click (format painter: keep painting). */
  readonly onDoubleClick?: () => void;
}

/** Toolbar icon button bound to a registry command (enabled, pressed, tooltip with shortcut). */
export function CommandButton({ command, label, children, className, onDoubleClick }: CommandButtonProps) {
  const controller = useController();
  const view = useCommand(controller.registry, command);
  if (!view.exists) return null;
  return (
    <ToolbarButton
      label={label ?? view.label}
      shortcut={view.shortcut}
      pressed={view.active}
      disabled={!view.enabled}
      onClick={() => void controller.runCommand(command, "toolbar")}
      onDoubleClick={onDoubleClick}
      className={className}
    >
      {children}
    </ToolbarButton>
  );
}
