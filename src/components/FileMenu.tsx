import { FilePlus, FileSpreadsheet, FolderOpen, History, Info, Save, Settings, X } from "lucide-react";
import { CommandMenuItem } from "@/components/CommandMenuItem";
import { useController } from "@/components/controller-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getFileName } from "@/files/path";
import { useSettings } from "@/hooks/use-settings";
import { isTauri } from "@/lib/is-tauri";
import { getSettingsStore } from "@/lib/settings";

/** "Archivo" menu: new, open, recent files, save, save as, CSV options, close, options. */
export function FileMenu() {
  const controller = useController();
  const { recentFiles } = useSettings();
  const native = isTauri();
  // A recent file that cannot be opened any more (moved, deleted) leaves the list.
  const openRecent = async (path: string) => {
    if (!(await controller.manager.openPath(path))) getSettingsStore().removeRecentFile(path);
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          className="h-7 rounded-md bg-brand px-3 text-xs font-medium text-white hover:bg-brand/90"
        >
          Archivo
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        <CommandMenuItem command="file.new" icon={<FilePlus />} />
        <CommandMenuItem command="file.open" icon={<FolderOpen />} />
        {native ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={recentFiles.length === 0}>
              <History />
              Recientes
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-w-[28rem]">
              {recentFiles.map((path) => (
                <DropdownMenuItem key={path} title={path} onSelect={() => void openRecent(path)}>
                  <FileSpreadsheet />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{getFileName(path)}</span>
                    <span className="truncate text-[11px] text-muted-foreground">{path}</span>
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => getSettingsStore().clearRecentFiles()}>
                <X />
                Borrar la lista de recientes
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSeparator />
        <CommandMenuItem command="file.save" icon={<Save />} />
        <CommandMenuItem command="file.saveAs" />
        <CommandMenuItem command="file.csvOptions" />
        <DropdownMenuSeparator />
        <CommandMenuItem command="file.close" icon={<X />} />
        <DropdownMenuSeparator />
        <CommandMenuItem command="app.options" icon={<Settings />} />
        <CommandMenuItem command="app.about" icon={<Info />} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
