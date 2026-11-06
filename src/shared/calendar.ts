/**
 * Calendar days written 2026-11-05, with no time zone attached. Arithmetic on them is plain date
 * arithmetic, the same on every computer. Where in time a day begins is a separate question,
 * answered for the viewer's own time zone by the host (see services/activity.ts).
 */

const DAY_MS = 86_400_000;

/** How the dashboard groups applications over time. */
export const ACTIVITY_GROUPS = ['hour', 'day', 'week', 'month'] as const;
export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number];

/** The longest range the dashboard asks about. */
export const MAX_RANGE_DAYS = 400;

const dayNumber = (date: string): number => {
  const [year, month, day] = date.split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
};

const fromDayNumber = (days: number): string => new Date(days * DAY_MS).toISOString().slice(0, 10);

/** True for a real day written 2026-11-05: not 2026-02-30, not 2026-1-5. */
export function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && fromDayNumber(dayNumber(value)) === value;
}

export const addDays = (date: string, days: number): string => fromDayNumber(dayNumber(date) + days);

/** Days from the first date to the second: 0 for the same day. */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

/** The Monday of the week the day is in. Weeks run Monday to Sunday. */
export function weekStart(date: string): string {
  const days = dayNumber(date);
  const weekday = (new Date(days * DAY_MS).getUTCDay() + 6) % 7;
  return fromDayNumber(days - weekday);
}

export const monthStart = (date: string): string => `${date.slice(0, 7)}-01`;

/** The first day of the month this many months away. */
export function addMonths(date: string, months: number): string {
  const [year, month] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + months, 1)).toISOString().slice(0, 10);
}

export const monthEnd = (date: string): string => addDays(addMonths(date, 1), -1);

/** The day a moment falls on for this computer. */
export const localCalendarDate = (moment: Date): string =>
  `${moment.getFullYear()}-${String(moment.getMonth() + 1).padStart(2, '0')}-${String(moment.getDate()).padStart(2, '0')}`;

/** Hours for one day, days up to two months, weeks up to half a year, months beyond. */
export function autoGroup(from: string, to: string): ActivityGroup {
  const days = daysBetween(from, to) + 1;
  if (days <= 1) return 'hour';
  if (days <= 62) return 'day';
  if (days <= 183) return 'week';
  return 'month';
}

/** Hours only make sense for a single day: there would be too many of them otherwise. */
export const groupFits = (group: ActivityGroup, from: string, to: string): boolean => group !== 'hour' || from === to;
