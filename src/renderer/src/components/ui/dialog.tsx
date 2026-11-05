import { Dialog as RadixDialog } from 'radix-ui';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
import { cn } from '@/lib/utils';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** A centered modal, for short tasks. */
export function Dialog({ open, onOpenChange, title, description, children, footer, className }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RadixDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[calc(100vw-48px)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-surface shadow-panel',
            className
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3.5">
            <div className="min-w-0">
              <RadixDialog.Title className="text-[15px] font-semibold text-ink">{title}</RadixDialog.Title>
              {description ? <RadixDialog.Description className="mt-0.5 text-[12.5px] text-ink-2">{description}</RadixDialog.Description> : <RadixDialog.Description className="sr-only">Dialog</RadixDialog.Description>}
            </div>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close" className="-mr-1 -mt-0.5">
                <X />
              </Button>
            </RadixDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}

/** A panel that slides over the right edge, for details that keep the list in view. */
export function Sheet({ open, onOpenChange, title, children }: SheetProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-30 bg-black/25" />
        <RadixDialog.Content className="fixed bottom-0 right-0 top-0 z-30 flex w-[min(720px,calc(100vw-120px))] flex-col border-l border-border bg-surface shadow-panel">
          <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
          <RadixDialog.Description className="sr-only">Job details</RadixDialog.Description>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  danger,
  loading,
  onConfirm
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      className="max-w-md"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-ink-2">{children}</div>
    </Dialog>
  );
}
