import { memo } from 'react';
import { BadgeCheck, Building2, FileClock, Landmark, Laptop, Shuffle, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { EmploymentType, JobFacts, WorkArrangement } from '@shared/api';
import { cn } from '@/lib/utils';

const ARRANGEMENTS: Record<WorkArrangement, { icon: LucideIcon; label: string }> = {
  remote: { icon: Laptop, label: 'Remote' },
  hybrid: { icon: Shuffle, label: 'Hybrid' },
  onsite: { icon: Building2, label: 'On-site' }
};

const EMPLOYMENT: Record<EmploymentType, { icon: LucideIcon; label: string }> = {
  contract: { icon: FileClock, label: 'Contract' },
  permanent: { icon: BadgeCheck, label: 'Permanent' }
};

function Tag({ icon: Icon, label, hint, tone = 'plain' }: { icon: LucideIcon; label: string; hint?: string; tone?: 'plain' | 'notice' }) {
  return (
    <span title={hint ?? label} className={cn('inline-flex h-[18px] shrink-0 items-center gap-1 rounded px-1.5 text-[11px] font-medium leading-none', tone === 'notice' ? 'bg-warning-soft text-warning-ink' : 'bg-surface-2 text-ink-2')}>
      <Icon className="size-3" aria-hidden />
      {label}
    </span>
  );
}

/**
 * What matters first about a job: where it is done, on what terms, and whether it needs a
 * clearance or is federal. What is unknown shows nothing, rather than a guess.
 */
export const JobTags = memo(function JobTags({ facts, className, reserve = false }: { facts: JobFacts; className?: string; reserve?: boolean }) {
  const arrangement = facts.workArrangement ? ARRANGEMENTS[facts.workArrangement] : null;
  const employment = facts.employmentType ? EMPLOYMENT[facts.employmentType] : null;
  const any = !!arrangement || !!employment || !!facts.clearance || facts.isFederal;
  // A list keeps the line even when empty, so that every row is one height.
  if (!any && !reserve) return null;
  return (
    <div data-job-tags className={cn('flex h-[18px] items-center gap-1 overflow-hidden', className)}>
      {arrangement ? <Tag {...arrangement} /> : null}
      {employment ? <Tag {...employment} /> : null}
      {facts.clearance ? <Tag icon={ShieldCheck} label="Clearance" hint={facts.clearance === 'Required' ? 'Security clearance required' : `${facts.clearance} clearance required`} tone="notice" /> : null}
      {facts.isFederal ? <Tag icon={Landmark} label="Federal" hint="Federal position" tone="notice" /> : null}
    </div>
  );
});

const CURRENCY_SIGNS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$', INR: '₹' };

function amount(value: number, sign: string, period: JobFacts['salaryPeriod']): string {
  if (period === 'hour') return `${sign}${Number.isInteger(value) ? value : value.toFixed(2)}`;
  return value >= 1000 ? `${sign}${Math.round(value / 1000)}k` : `${sign}${value}`;
}

/** "$120k–$150k", or "$60–$80/hr". */
export function formatSalary(facts: JobFacts): string | null {
  if (facts.salaryMin === null) return null;
  const sign = facts.salaryCurrency ? (CURRENCY_SIGNS[facts.salaryCurrency] ?? `${facts.salaryCurrency} `) : '';
  const low = amount(facts.salaryMin, sign, facts.salaryPeriod);
  const range = facts.salaryMax !== null && facts.salaryMax !== facts.salaryMin ? `${low}–${amount(facts.salaryMax, sign, facts.salaryPeriod)}` : low;
  return facts.salaryPeriod === 'hour' ? `${range}/hr` : range;
}
