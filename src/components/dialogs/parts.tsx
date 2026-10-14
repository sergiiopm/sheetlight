import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Building blocks shared by the shell dialogs (Excel-like, compact, Spanish). */

interface ShellDialogProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly onClose: () => void;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
  /** Enter in a text field submits (like Excel's default button). */
  readonly onSubmit?: () => void;
}

export function ShellDialog({ title, description, onClose, children, footer, className, onSubmit }: ShellDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={cn("gap-3 p-5", className)}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit?.();
          }}
        >
          {children}
          {footer ? <DialogFooter className="pt-1">{footer}</DialogFooter> : null}
          {/* Lets Enter submit when the footer's primary button is not a submit button. */}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function OkCancel({ onCancel, okLabel = "Aceptar", disabled }: { onCancel: () => void; okLabel?: string; disabled?: boolean }) {
  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancelar
      </Button>
      <Button type="submit" size="sm" disabled={disabled}>
        {okLabel}
      </Button>
    </>
  );
}

/**
 * Labelled field. Use `group` when the content is not a single control
 * (lists of buttons, previews): a <label> would lend its name to the first button.
 */
export function Field({ label, children, className, group = false }: { label: string; children: ReactNode; className?: string; group?: boolean }) {
  if (group) {
    return (
      <div role="group" aria-label={label} className={cn("flex flex-col gap-1 text-xs text-muted-foreground", className)}>
        <span>{label}</span>
        <div className="text-sm text-foreground">{children}</div>
      </div>
    );
  }
  return (
    <label className={cn("flex flex-col gap-1 text-xs text-muted-foreground", className)}>
      <span>{label}</span>
      <span className="text-sm text-foreground">{children}</span>
    </label>
  );
}

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
}

/** Radix select with string values (no empty strings: use a sentinel such as "auto"). */
export function Choice({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<ChoiceOption>;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={ariaLabel} className={cn("h-8 text-[13px]", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Check({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex cursor-pointer items-center gap-2 text-[13px]", disabled && "cursor-not-allowed opacity-50")}>
      <input type="checkbox" className="accent-[var(--brand)]" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {children}
    </label>
  );
}

export function Radio<T extends string>({
  name,
  value,
  current,
  onChange,
  children,
}: {
  name: string;
  value: T;
  current: T;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px]">
      <input type="radio" className="accent-[var(--brand)]" name={name} checked={current === value} onChange={() => onChange(value)} />
      {children}
    </label>
  );
}

export const textInputClass =
  "h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] text-foreground shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring";
