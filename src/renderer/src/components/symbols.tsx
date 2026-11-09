import { CircleHelp, CodeXml, Phone, Send, Trophy, UsersRound, X, type LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import type { Stage } from '@shared/constants';
import { cn } from '@/lib/utils';
import { Tooltip } from './ui/misc';

/** One symbol per stage, used everywhere, so that it only has to be learned once. */
export const STAGE_ICONS: Record<Stage, LucideIcon> = {
  Applied: Send,
  'Recruiter Screen': Phone,
  'Technical Interview': CodeXml,
  'Final Interview': UsersRound,
  Offer: Trophy,
  Rejected: X
};

const STAGE_TOKENS: Record<Stage, string> = {
  Applied: 'applied',
  'Recruiter Screen': 'recruiter',
  'Technical Interview': 'technical',
  'Final Interview': 'final',
  Offer: 'offer',
  Rejected: 'rejected'
};

export function stageStyle(stage: Stage): CSSProperties {
  const token = STAGE_TOKENS[stage];
  return { backgroundColor: `var(--stage-${token}-bg)`, color: `var(--stage-${token}-ink)` };
}

export function stageInk(stage: Stage): string {
  return `var(--stage-${STAGE_TOKENS[stage]}-ink)`;
}

/** An icon and a word, for menus: the one place where symbols are being explained. */
export function IconLabel({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {children}
    </span>
  );
}

/** A symbol that says what it means on hover and to screen readers. */
export function Symbol({ icon: Icon, label, className, size = 'size-4' }: { icon: LucideIcon; label: string; className?: string; size?: string }) {
  return (
    <Tooltip content={label}>
      <span role="img" aria-label={label} tabIndex={0} className={cn('inline-flex shrink-0 items-center justify-center rounded', className)}>
        <Icon className={size} aria-hidden />
      </span>
    </Tooltip>
  );
}

/** A small "?" holding the explanation that used to be a paragraph on the page. */
export function HelpTip({ children }: { children: ReactNode }) {
  return (
    <Tooltip content={children}>
      <span role="img" aria-label="Help" tabIndex={0} className="inline-flex align-middle text-ink-3 hover:text-ink-2">
        <CircleHelp className="size-3.5" aria-hidden />
      </span>
    </Tooltip>
  );
}
