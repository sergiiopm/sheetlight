import { lazy, Suspense, useCallback } from "react";
import { useController } from "@/components/controller-context";
import { UnsavedDialog } from "@/components/UnsavedDialog";
import { useStore } from "@/hooks/store";
import { sessionFileName } from "@/hooks/workbook-session";

// Dialogs load on first use to keep the start-up bundle small (cold start < 1 s).
const data = () => import("@/components/dialogs/DataDialogs");
const simple = () => import("@/components/dialogs/SimpleDialogs");
const FormatCellsDialog = lazy(() => import("@/components/dialogs/FormatCellsDialog").then((m) => ({ default: m.FormatCellsDialog })));
const FindReplacePanel = lazy(() => import("@/components/dialogs/FindReplacePanel").then((m) => ({ default: m.FindReplacePanel })));
const SortDialog = lazy(() => data().then((m) => ({ default: m.SortDialog })));
const CsvOptionsDialog = lazy(() => data().then((m) => ({ default: m.CsvOptionsDialog })));
const OptionsDialog = lazy(() => data().then((m) => ({ default: m.OptionsDialog })));
const AboutDialog = lazy(() => simple().then((m) => ({ default: m.AboutDialog })));
const DeleteSheetDialog = lazy(() => simple().then((m) => ({ default: m.DeleteSheetDialog })));
const GoToDialog = lazy(() => simple().then((m) => ({ default: m.GoToDialog })));
const PasteSpecialDialog = lazy(() => simple().then((m) => ({ default: m.PasteSpecialDialog })));
const ShiftCellsDialog = lazy(() => simple().then((m) => ({ default: m.ShiftCellsDialog })));
const SizeDialog = lazy(() => simple().then((m) => ({ default: m.SizeDialog })));
const UnhideSheetsDialog = lazy(() => simple().then((m) => ({ default: m.UnhideSheetsDialog })));

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
      <Suspense fallback={null}>{content}</Suspense>
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
