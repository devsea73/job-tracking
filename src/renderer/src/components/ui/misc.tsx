import { AlertTriangle, CheckCircle2, Info, type LucideIcon } from 'lucide-react';
import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content side={side} sideOffset={5} className="z-[60] max-w-64 rounded-md bg-[#17181c] px-2 py-1 text-[12px] text-white shadow-panel dark:bg-[#eceef2] dark:text-[#17181c]">
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn('rounded-xl border border-border bg-surface', className)}>{children}</section>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden />;
}

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-surface-2 text-ink-3">
        <Icon className="size-5" aria-hidden />
      </div>
      <p className="font-medium text-ink">{title}</p>
      {children ? <div className="mt-1 max-w-md text-ink-2">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

const NOTICE_STYLES = {
  error: { box: 'bg-danger-soft text-danger-ink', icon: AlertTriangle },
  warning: { box: 'bg-warning-soft text-warning-ink', icon: AlertTriangle },
  success: { box: 'bg-success-soft text-success-ink', icon: CheckCircle2 },
  info: { box: 'bg-accent-soft text-accent-soft-ink', icon: Info }
} as const;

export function Notice({ kind = 'info', title, children, action, className }: { kind?: keyof typeof NOTICE_STYLES; title?: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  const style = NOTICE_STYLES[kind];
  const Icon = style.icon;
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-2.5 rounded-lg px-3 py-2.5', style.box, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn('selectable', title ? 'mt-0.5 opacity-90' : '')}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
