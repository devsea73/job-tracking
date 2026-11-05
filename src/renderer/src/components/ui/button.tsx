import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-default',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-ink hover:bg-accent-hover',
        secondary: 'bg-surface border border-border-strong text-ink hover:bg-surface-2',
        ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        danger: 'bg-danger text-white hover:opacity-90 dark:text-[#1c0a0a]',
        'danger-ghost': 'text-danger-ink hover:bg-danger-soft'
      },
      size: {
        sm: 'h-7 px-2.5 text-[12.5px]',
        md: 'h-8.5 px-3.5',
        icon: 'size-8',
        'icon-sm': 'size-7'
      }
    },
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export function Button({ className, variant, size, loading, children, disabled, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {loading ? <Loader2 className="spin" aria-hidden /> : null}
      {children}
    </button>
  );
}
