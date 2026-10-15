import { useSyncExternalStore } from "react";
import type { CommandId, CommandRegistry } from "@/model/commands";
import { formatShortcut } from "@/hooks/shortcuts";

/** Re-renders when any command's enabled/active state may have changed. */
export function useRegistryVersion(registry: CommandRegistry): number {
  return useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);
}

export interface CommandView {
  readonly exists: boolean;
  readonly label: string;
  /** Spanish shortcut label ("Ctrl+Mayús+L"), if any. */
  readonly shortcut: string | undefined;
  readonly enabled: boolean;
  readonly active: boolean;
}

/** Snapshot of a command for buttons and menu items. */
export function commandView(registry: CommandRegistry, id: CommandId): CommandView {
  const command = registry.get(id);
  if (!command) return { exists: false, label: id, shortcut: undefined, enabled: false, active: false };
  return {
    exists: true,
    label: command.label,
    shortcut: command.shortcut ? formatShortcut(command.shortcut) : undefined,
    enabled: command.isEnabled ? command.isEnabled() : true,
    active: command.isActive ? command.isActive() : false,
  };
}

export function useCommand(registry: CommandRegistry, id: CommandId): CommandView {
  useRegistryVersion(registry);
  return commandView(registry, id);
}
