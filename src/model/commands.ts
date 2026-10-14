/**
 * Command registry: every user action that can be triggered from more than one
 * place (toolbar, menu, context menu, keyboard shortcut, command palette) is
 * a `Command` registered here under a stable id such as `format.bold`.
 *
 * Commands do not hold undo state themselves: a command that changes the
 * workbook builds `EngineOp`s and calls `engine.apply()` (one undo step); undo
 * and redo are the `edit.undo` / `edit.redo` commands calling the engine.
 *
 * Shortcut syntax: `Mod+B`, `Mod+Shift+Z`, `F2`, `Alt+Enter`, `Mod+Space`
 * (`Mod` = Ctrl on Windows). Matching uses `KeyboardEvent.key`
 * case-insensitively, plus modifiers.
 */

export type CommandId = string;

export interface CommandContext {
  /** Where the command was triggered from (some commands behave differently in the editor). */
  readonly source: "toolbar" | "menu" | "contextMenu" | "shortcut" | "palette" | "api";
}

export interface Command {
  readonly id: CommandId;
  /** Spanish, user-facing ("Negrita"). */
  readonly label: string;
  readonly shortcut?: string;
  /** Group for menus/palette ("Formato", "Edición"…). */
  readonly group?: string;
  isEnabled?(): boolean;
  /** For toggles (bold, wrap…): current on/off state. */
  isActive?(): boolean;
  run(context: CommandContext): void | Promise<void>;
}

export type CommandsListener = () => void;

export class CommandRegistry {
  private readonly commands = new Map<CommandId, Command>();
  private readonly listeners = new Set<CommandsListener>();
  private version = 0;

  /** Registers (or replaces) commands; returns an unregister function. */
  register(...commands: Command[]): () => void {
    for (const command of commands) this.commands.set(command.id, command);
    this.changed();
    return () => {
      for (const command of commands) {
        if (this.commands.get(command.id) === command) this.commands.delete(command.id);
      }
      this.changed();
    };
  }

  get(id: CommandId): Command | undefined {
    return this.commands.get(id);
  }

  all(): Command[] {
    return [...this.commands.values()];
  }

  async run(id: CommandId, context: CommandContext = { source: "api" }): Promise<boolean> {
    const command = this.commands.get(id);
    if (!command || (command.isEnabled && !command.isEnabled())) return false;
    await command.run(context);
    return true;
  }

  /** Finds the command bound to a keyboard event, if any. */
  match(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): Command | undefined {
    for (const command of this.commands.values()) {
      if (command.shortcut && shortcutMatches(command.shortcut, event)) return command;
    }
    return undefined;
  }

  /** Notifies UI (enabled/active states) that something changed. */
  changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  getVersion = (): number => this.version;

  subscribe = (listener: CommandsListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export function shortcutMatches(
  shortcut: string,
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
): boolean {
  const parts = shortcut.split("+");
  const key = parts[parts.length - 1].toLowerCase();
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  const eventKey = event.key === " " ? "space" : event.key.toLowerCase();
  return (
    eventKey === key &&
    mods.has("mod") === (event.ctrlKey || event.metaKey) &&
    mods.has("shift") === event.shiftKey &&
    mods.has("alt") === event.altKey
  );
}
