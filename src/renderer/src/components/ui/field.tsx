import type { ComponentProps, LabelHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const control =
  'w-full rounded-md border border-border-strong bg-surface text-ink placeholder:text-ink-3 focus-visible:border-accent focus-visible:outline-2 disabled:opacity-60';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(control, 'h-8.5 px-2.5', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, 'px-2.5 py-2 resize-y', className)} {...props} />;
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('block text-[12.5px] font-medium text-ink-2 mb-1', className)} {...props} />;
}

export function Field({ label, htmlFor, hint, children, className }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="mt-1 text-[12px] text-ink-3">{hint}</p> : null}
    </div>
  );
}
