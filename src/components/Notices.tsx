import { useEffect } from "react";
import { CircleAlert, Info, X } from "lucide-react";
import { useController } from "@/components/controller-context";
import type { Notice } from "@/hooks/app-controller";
import { useStore } from "@/hooks/store";
import { cn } from "@/lib/utils";

const INFO_TIMEOUT_MS = 6000;

/** Toasts for `controller.notify` (errors stay until dismissed, info fades out). */
export function Notices() {
  const controller = useController();
  const notices = useStore(controller.notices);
  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-10 left-1/2 z-50 flex w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2" aria-live="polite">
      {notices.map((notice) => (
        <NoticeItem key={notice.id} notice={notice} onDismiss={() => controller.dismissNotice(notice.id)} />
      ))}
    </div>
  );
}

function NoticeItem({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  useEffect(() => {
    if (notice.kind !== "info") return;
    const timer = setTimeout(onDismiss, INFO_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // onDismiss only depends on the id; restarting the timer on re-renders would keep toasts alive.
  }, [notice.id, notice.kind]);
  const error = notice.kind === "error";
  return (
    <div
      role={error ? "alert" : "status"}
      className={cn(
        "pointer-events-auto flex items-start gap-2 rounded-md border bg-popover px-3 py-2 text-[13px] text-popover-foreground shadow-md",
        error && "border-destructive/40",
      )}
    >
      {error ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand" />}
      <span className="min-w-0 flex-1">{notice.message}</span>
      <button type="button" aria-label="Cerrar" className="rounded-sm p-0.5 hover:bg-accent" onClick={onDismiss}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
