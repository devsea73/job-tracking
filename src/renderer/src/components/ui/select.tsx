import { Select as RadixSelect } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label: ReactNode;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** Replaces the default trigger's look, e.g. a status badge. */
  renderValue?: ReactNode;
  triggerClassName?: string;
}

/** Radix treats the empty string as "nothing selected", so "all" options travel as this value. */
export const ANY = '__any__';

export function Select({ value, onChange, options, placeholder, className, ariaLabel, disabled, renderValue, triggerClassName }: SelectProps) {
  return (
    <RadixSelect.Root value={value} onValueChange={onChange} disabled={disabled}>
      <RadixSelect.Trigger
        aria-label={ariaLabel}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        className={cn(
          renderValue ? '' : 'inline-flex h-8.5 items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-2.5 text-ink hover:bg-surface-2 data-[placeholder]:text-ink-3',
          'cursor-default disabled:opacity-60',
          className,
          triggerClassName
        )}
      >
        {renderValue ?? <RadixSelect.Value placeholder={placeholder} />}
        {renderValue ? null : (
          <RadixSelect.Icon>
            <ChevronDown className="size-3.5 text-ink-3" />
          </RadixSelect.Icon>
        )}
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          onClick={(event) => event.stopPropagation()}
          className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-panel"
        >
          <RadixSelect.Viewport>
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                className="relative flex h-8 cursor-default select-none items-center rounded-md pl-2.5 pr-8 text-ink outline-none data-[highlighted]:bg-surface-2"
              >
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="absolute right-2">
                  <Check className="size-3.5 text-ink-2" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
