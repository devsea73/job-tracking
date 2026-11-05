import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CalendarDays, CodeXml, ImageOff, Percent, Phone, Send, Trophy, User, UsersRound, type LucideIcon } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { CurrentUser, TeamMember } from '@shared/api';
import type { PassRate, ProcessStats } from '@shared/pipeline';
import { Avatar, userLabel, userName } from '@/components/job-bits';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { ANY, Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { call, errorMessage, useTeam } from '@/lib/api';
import { cn } from '@/lib/utils';

export function formatRate(rate: PassRate): string {
  return rate.percent === null ? '–' : `${rate.percent}%`;
}

const STAGES: Array<{ key: keyof Pick<ProcessStats, 'screenPass' | 'technicalPass' | 'interviewPass' | 'offerPass'>; label: string; icon: LucideIcon; explain: (rate: PassRate) => string }> = [
  { key: 'screenPass', label: 'Screen pass', icon: Phone, explain: (rate) => `${rate.reached} of ${rate.from} applications reached Recruiter Screen` },
  { key: 'technicalPass', label: 'Technical pass', icon: CodeXml, explain: (rate) => `${rate.reached} of ${rate.from} went from Recruiter Screen to Technical Interview` },
  { key: 'interviewPass', label: 'Interview pass', icon: UsersRound, explain: (rate) => `${rate.reached} of ${rate.from} went from Technical Interview to Final Interview` },
  { key: 'offerPass', label: 'Offer pass', icon: Trophy, explain: (rate) => `${rate.reached} of ${rate.from} went from Final Interview to Offer` }
];

/** Horizontal bars on one fixed 0-100% scale, so bars can be compared between people and stages. */
function PassRateChart({ stats }: { stats: ProcessStats }) {
  return (
    <ul className="space-y-2" aria-label="Pass rate at each stage">
      {STAGES.map(({ key, label, icon: Icon, explain }) => {
        const rate = stats[key];
        const noData = rate.percent === null;
        return (
          <li key={key}>
            <Tooltip content={`${label}: ${noData ? 'no data yet' : explain(rate)}`}>
              {/* The whole row is the hover target: a short bar should still be easy to point at. */}
              <div tabIndex={0} className="grid grid-cols-[20px_1fr_96px] items-center gap-2.5 rounded outline-offset-2">
                <span role="img" aria-label={label} className="text-ink-3">
                  <Icon className="size-4" aria-hidden />
                </span>
                <div className="h-3 rounded-[4px] bg-surface-2" aria-hidden>
                  {rate.percent ? <div className="h-full rounded-r-[4px] bg-accent" style={{ width: `${rate.percent}%` }} /> : null}
                </div>
                <span className="whitespace-nowrap text-right text-[12.5px] tabular-nums">
                  <span className="font-semibold text-ink">{formatRate(rate)}</span>
                  {noData ? null : (
                    <span className="ml-1.5 text-ink-3">
                      {rate.reached}/{rate.from}
                    </span>
                  )}
                </span>
              </div>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}

function Figure({ label, icon: Icon, value }: { label: string; icon: LucideIcon; value: string | number }) {
  return (
    <Tooltip content={label}>
      <div tabIndex={0} aria-label={`${label}: ${value}`} className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        <span className="text-[15px] font-semibold leading-tight tabular-nums">{value}</span>
      </div>
    </Tooltip>
  );
}

const ALL_PROFILES = ANY;

function MemberCard({ member, isAdmin }: { member: TeamMember; isAdmin: boolean }) {
  const [selected, setSelected] = useState<string>(ALL_PROFILES);
  const queryClient = useQueryClient();
  const toast = useToast();
  const chosen = selected === ALL_PROFILES ? null : (member.profiles.find((entry) => String(entry.profile.id) === selected) ?? null);
  const stats = chosen?.stats ?? member.stats;
  const removePhoto = () => {
    if (!chosen) return;
    void call('DELETE', `/api/admin/profiles/${chosen.profile.id}/avatar`)
      .then(() => queryClient.invalidateQueries())
      .then(() => toast.show('Photo removed.'))
      .catch((error) => toast.show(errorMessage(error), 'error'));
  };

  return (
    <Card className="p-3.5">
      <div className="mb-2.5 flex items-center gap-2.5">
        {chosen ? <Avatar subject={chosen.profile} label={chosen.profile.name} size="md" ring={false} /> : <Avatar subject={member.user} label={userLabel(member.user)} size="md" ring={false} />}
        <h2 className="min-w-0 flex-1 truncate font-semibold leading-tight">
          {userName(member.user)}
          {member.isActive ? null : <span className="ml-1.5 font-normal text-ink-3">(off)</span>}
        </h2>
        {isAdmin && chosen?.profile.avatarVersion ? (
          <Button size="icon-sm" variant="danger-ghost" title="Remove this profile's photo" aria-label={`Remove photo of ${chosen.profile.name}`} onClick={removePhoto}>
            <ImageOff />
          </Button>
        ) : null}
        {member.profiles.length > 1 ? (
          <Select
            ariaLabel={`Profile of ${userName(member.user)}`}
            className="w-[150px]"
            leading={<User className="size-3.5 text-ink-3" aria-hidden />}
            value={selected}
            onChange={setSelected}
            options={[
              { value: ALL_PROFILES, label: `All (${member.profiles.length})` },
              ...member.profiles.map((entry) => ({ value: String(entry.profile.id), label: `${entry.profile.name}${entry.profile.isArchived ? ' (archived)' : ''}` }))
            ]}
          />
        ) : null}
      </div>

      <div className="mb-3 flex flex-wrap justify-between gap-x-3 gap-y-1 border-y border-border py-2">
        <Figure label="Applications" icon={Send} value={stats.applications.toLocaleString()} />
        <Figure label="Interviews" icon={CalendarDays} value={stats.interviews.toLocaleString()} />
        <Figure label="Technical" icon={CodeXml} value={stats.technical.toLocaleString()} />
        <Figure label="Offers" icon={Trophy} value={stats.offers.toLocaleString()} />
        <Figure label="Success" icon={Percent} value={formatRate(stats.success)} />
      </div>

      <PassRateChart stats={stats} />
    </Card>
  );
}

type SortKey = 'name' | 'applications' | 'interviews' | 'technical' | 'offers' | 'success';

const COLUMNS: Array<{ key: SortKey; label: string; icon: LucideIcon; numeric?: boolean }> = [
  { key: 'name', label: 'Person', icon: User },
  { key: 'applications', label: 'Applications', icon: Send, numeric: true },
  { key: 'interviews', label: 'Interviews', icon: CalendarDays, numeric: true },
  { key: 'technical', label: 'Technical', icon: CodeXml, numeric: true },
  { key: 'offers', label: 'Offers', icon: Trophy, numeric: true },
  { key: 'success', label: 'Success', icon: Percent, numeric: true }
];

function sortValue(member: TeamMember, key: SortKey): string | number {
  switch (key) {
    case 'name':
      return userName(member.user).toLowerCase();
    case 'success':
      // People with no applications have no rate, and go below anyone at 0%.
      return member.stats.success.percent ?? -1;
    default:
      return member.stats[key];
  }
}

function SummaryTable({ members, sort, direction, onSort }: { members: TeamMember[]; sort: SortKey; direction: 'asc' | 'desc'; onSort: (key: SortKey) => void }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border text-ink-3">
            {COLUMNS.map((column) => {
              const active = sort === column.key;
              const Arrow = direction === 'asc' ? ArrowUp : ArrowDown;
              const Icon = column.icon;
              return (
                <th key={column.key} scope="col" aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'} className={cn('px-4 py-1.5 font-normal', column.numeric ? 'text-right' : 'text-left')}>
                  <Tooltip content={column.label}>
                    <button type="button" aria-label={column.label} onClick={() => onSort(column.key)} className={cn('inline-flex items-center gap-1 rounded hover:text-ink', active && 'text-ink')}>
                      <Icon className="size-4" aria-hidden />
                      {active ? <Arrow className="size-3" aria-hidden /> : null}
                    </button>
                  </Tooltip>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {members.map((member) => (
            <tr key={member.user.id} className="border-b border-border last:border-b-0">
              <td className="px-4 py-1.5">
                <div className="flex items-center gap-2">
                  <Avatar subject={member.user} label={userLabel(member.user)} ring={false} />
                  <span className="truncate font-medium">{userName(member.user)}</span>
                </div>
              </td>
              <td className="px-4 py-1.5 text-right">{member.stats.applications.toLocaleString()}</td>
              <td className="px-4 py-1.5 text-right">{member.stats.interviews.toLocaleString()}</td>
              <td className="px-4 py-1.5 text-right">{member.stats.technical.toLocaleString()}</td>
              <td className="px-4 py-1.5 text-right">{member.stats.offers.toLocaleString()}</td>
              <td className="px-4 py-1.5 text-right font-semibold">{formatRate(member.stats.success)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function TeamPage({ user }: { user: CurrentUser }) {
  const team = useTeam();
  const [sort, setSort] = useState<SortKey>('applications');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');

  const members = useMemo(() => {
    const list = [...(team.data ?? [])];
    const factor = direction === 'asc' ? 1 : -1;
    return list.sort((a, b) => {
      const left = sortValue(a, sort);
      const right = sortValue(b, sort);
      const order = typeof left === 'string' ? left.localeCompare(right as string) : left - (right as number);
      return factor * order || userName(a.user).localeCompare(userName(b.user));
    });
  }, [team.data, sort, direction]);

  const onSort = (key: SortKey) => {
    if (key === sort) setDirection(direction === 'asc' ? 'desc' : 'asc');
    else {
      setSort(key);
      setDirection(key === 'name' ? 'asc' : 'desc');
    }
  };

  return (
    <div className="h-full overflow-y-auto px-5 pb-8 pt-4">
      <h1 className="mb-3 text-[17px] font-semibold leading-tight">Team</h1>

      {team.isError ? (
        <Notice kind="error" title="Could not load the team" className="mb-4">
          {errorMessage(team.error)}
        </Notice>
      ) : null}

      {team.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-52" />
        </div>
      ) : members.length === 0 ? (
        <EmptyState icon={UsersRound} title="Nobody here yet" />
      ) : (
        <>
          <SummaryTable members={members} sort={sort} direction={direction} onSort={onSort} />
          <div className="mt-3 grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {members.map((member) => (
              <MemberCard key={member.user.id} member={member} isAdmin={user.role === 'admin'} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
