import { useCallback } from "react";
import { useController } from "@/components/controller-context";
import { CsvOptionsDialog, OptionsDialog, SortDialog } from "@/components/dialogs/DataDialogs";
import { FindReplacePanel } from "@/components/dialogs/FindReplacePanel";
import { FormatCellsDialog } from "@/components/dialogs/FormatCellsDialog";
import {
  AboutDialog,
  DeleteSheetDialog,
  GoToDialog,
  PasteSpecialDialog,
  ShiftCellsDialog,
  SizeDialog,
  UnhideSheetsDialog,
} from "@/components/dialogs/SimpleDialogs";
import { UnsavedDialog } from "@/components/UnsavedDialog";
import { useStore } from "@/hooks/store";
import { sessionFileName } from "@/hooks/workbook-session";

/** Renders the dialog in `controller.dialog` and the unsaved-changes prompt. */
export function DialogHost() {
  const controller = useController();
  const dialog = useStore(controller.dialog);
  const pending = useStore(controller.manager.pending);
  const close = useCallback(() => controller.closeDialog(), [controller]);
  const pendingSession = pending ? controller.manager.byId(pending.sessionId) : undefined;

  let content = null;
  switch (dialog?.kind) {
    case "formatCells":
      content = <FormatCellsDialog tab={dialog.tab} onClose={close} />;
      break;
    case "find":
      content = <FindReplacePanel tab={dialog.tab} onClose={close} />;
      break;
    case "goTo":
      content = <GoToDialog onClose={close} />;
      break;
    case "sortCustom":
      content = <SortDialog onClose={close} />;
      break;
    case "insertCells":
      content = <ShiftCellsDialog insert onClose={close} />;
      break;
    case "deleteCells":
      content = <ShiftCellsDialog insert={false} onClose={close} />;
      break;
    case "pasteSpecial":
      content = <PasteSpecialDialog onClose={close} />;
      break;
    case "csvOptions":
      content = <CsvOptionsDialog sessionId={dialog.sessionId} onClose={close} />;
      break;
    case "rowHeight":
      content = <SizeDialog axis="row" onClose={close} />;
      break;
    case "colWidth":
      content = <SizeDialog axis="col" onClose={close} />;
      break;
    case "deleteSheet":
      content = <DeleteSheetDialog sheet={dialog.sheet} onClose={close} />;
      break;
    case "unhideSheets":
      content = <UnhideSheetsDialog onClose={close} />;
      break;
    case "about":
      content = <AboutDialog onClose={close} />;
      break;
    case "options":
      content = <OptionsDialog onClose={close} />;
      break;
    case undefined:
      break;
  }

  return (
    <>
      {content}
      <UnsavedDialog
        open={pending !== null}
        documentName={pendingSession ? sessionFileName(pendingSession.meta.get()) : ""}
        onSave={() => void controller.manager.confirmPending("save")}
        onDiscard={() => void controller.manager.confirmPending("discard")}
        onCancel={() => void controller.manager.confirmPending("cancel")}
      />
    </>
  );
}
