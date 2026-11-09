import type Database from 'better-sqlite3';

/**
 * Copies what a database from before timelines knew into steps, once, as it is updated (straight
 * after migration 0009; 0010 then works each application's stage out from the steps).
 *
 * Interviews become steps at their own time, the one the person entered. "Hiring Manager" and
 * "Other" were kinds of interview, not stages: they take the stage the application was at then,
 * and a hiring manager interview says so in its note. A status change that no interview stands for
 * becomes a step at the moment it was made, the only time known for it. Changes that were undone
 * (a stage set and then moved back from) were mistakes, and are left out, as they always counted.
 * An offer or a rejection the application ends at is kept as its last step, so that every
 * application stays at the stage it was at.
 */
export function stepsFromHistory(sqlite: Database.Database): void {
  const hasTable = (name: string) => !!sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  if (!hasTable('interviews') || !hasTable('application_status_history')) return;

  const applications = sqlite.prepare('SELECT id, status, updated_at FROM applications ORDER BY id').all() as Array<{ id: number; status: string; updated_at: string }>;
  const interviewsOf = group(
    sqlite.prepare('SELECT id, application_id, stage, scheduled_at, timezone, note, created_at, updated_at FROM interviews ORDER BY application_id, scheduled_at, id').all() as InterviewRow[]
  );
  const historyOf = group(sqlite.prepare('SELECT id, application_id, old_status, new_status, changed_at FROM application_status_history ORDER BY application_id, changed_at, id').all() as HistoryRow[]);
  const insert = sqlite.prepare('INSERT INTO application_steps (application_id, stage, at, timezone, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

  for (const application of applications) {
    for (const step of stepsOf(application, interviewsOf.get(application.id) ?? [], historyOf.get(application.id) ?? [])) {
      insert.run(application.id, step.stage, step.at, step.timezone, step.note, step.createdAt, step.updatedAt);
    }
  }
}

interface InterviewRow {
  id: number;
  application_id: number;
  stage: string;
  scheduled_at: string;
  timezone: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface HistoryRow {
  id: number;
  application_id: number;
  old_status: string | null;
  new_status: string;
  changed_at: string;
}

export interface ConvertedStep {
  stage: string;
  at: string;
  timezone: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

const RANK: Record<string, number> = { Applied: 0, 'Recruiter Screen': 1, 'Technical Interview': 2, 'Final Interview': 3, Offer: 4 };
const INTERVIEWS = ['Recruiter Screen', 'Technical Interview', 'Final Interview'];

function group<T extends { application_id: number }>(rows: T[]): Map<number, T[]> {
  const byApplication = new Map<number, T[]>();
  for (const row of rows) {
    const list = byApplication.get(row.application_id);
    if (list) list.push(row);
    else byApplication.set(row.application_id, [row]);
  }
  return byApplication;
}

/**
 * The status changes that stood, oldest first. Two applications merged into one kept both their
 * histories, mixed together; each began at a change from nothing, and a change carries on the run
 * it moved from. In each run, a stage moved back from was a mistake, and a rejection moved away
 * from was taken back.
 */
export function standingChanges(history: Array<Pick<HistoryRow, 'id' | 'old_status' | 'new_status' | 'changed_at'>>): Array<{ status: string; at: string }> {
  const runs: Array<{ status: string | null; changes: Array<{ status: string; at: string }> }> = [];
  let latest: (typeof runs)[number] | null = null;
  for (const entry of history) {
    let run: (typeof runs)[number] | null = null;
    if (entry.old_status !== null && latest) {
      run = latest.status === entry.old_status ? latest : ([...runs].reverse().find((candidate) => candidate.status === entry.old_status) ?? latest);
    }
    if (!run) {
      run = { status: null, changes: [] };
      runs.push(run);
    }
    run.status = entry.new_status;
    latest = run;
    if (entry.old_status === null) continue;
    const rank = RANK[entry.new_status];
    // Moving back undoes the stages above; moving off a rejection undoes it.
    run.changes = run.changes.filter((change) => (change.status === 'Rejected' ? false : rank === undefined || RANK[change.status] <= rank));
    run.changes.push({ status: entry.new_status, at: entry.changed_at });
  }
  return runs.flatMap((run) => run.changes).sort((a, b) => a.at.localeCompare(b.at));
}

/** One application's steps, from its interviews and the status changes that stood. */
export function stepsOf(application: { status: string; updated_at: string }, interviews: Array<Omit<InterviewRow, 'id' | 'application_id'>>, history: HistoryRow[]): ConvertedStep[] {
  const changes = standingChanges(history);
  const steps: ConvertedStep[] = [];

  // The interview stage the application was at by then, from the changes that stood.
  const stageAt = (at: string) => {
    let found: string | null = null;
    for (const change of changes) if (change.at <= at && INTERVIEWS.includes(change.status)) found = change.status;
    return found ?? changes.find((change) => INTERVIEWS.includes(change.status))?.status ?? 'Recruiter Screen';
  };
  for (const interview of interviews) {
    const known = INTERVIEWS.includes(interview.stage);
    const note = interview.stage === 'Hiring Manager' ? `Hiring manager${interview.note ? `: ${interview.note}` : ''}` : interview.note;
    steps.push({ stage: known ? interview.stage : stageAt(interview.scheduled_at), at: interview.scheduled_at, timezone: interview.timezone, note, createdAt: interview.created_at, updatedAt: interview.updated_at });
  }

  // A stage reached without an interview to show for it: at the moment it was set.
  for (const stage of [...INTERVIEWS, 'Offer']) {
    if (steps.some((step) => step.stage === stage)) continue;
    const change = changes.find((candidate) => candidate.status === stage);
    if (change) steps.push({ stage, at: change.at, timezone: 'UTC', note: null, createdAt: change.at, updatedAt: change.at });
  }

  // Where the application ends stays where it ends: an offer or rejection comes after everything else.
  const latestAt = () => steps.reduce<string | null>((latest, step) => (latest === null || step.at > latest ? step.at : latest), null);
  if (application.status === 'Rejected' || application.status === 'Offer') {
    const outcome = [...changes].reverse().find((change) => change.status === application.status);
    const existing = steps.find((step) => step.stage === application.status);
    const at = outcome?.at ?? existing?.at ?? application.updated_at;
    const others = steps.filter((step) => step !== existing);
    const last = others.reduce<string | null>((latest, step) => (latest === null || step.at > latest ? step.at : latest), null);
    const when = last !== null && last >= at ? new Date(Date.parse(last) + 1000).toISOString() : at;
    if (existing) existing.at = when;
    else steps.push({ stage: application.status, at: when, timezone: 'UTC', note: null, createdAt: outcome?.at ?? application.updated_at, updatedAt: outcome?.at ?? application.updated_at });
  } else if (application.status !== 'Applied' && !steps.some((step) => step.stage === application.status)) {
    // A stage set with no change recorded for it (only ever by hand, in the database): as late as known.
    const at = latestAt();
    steps.push({ stage: application.status, at: at !== null && at > application.updated_at ? at : application.updated_at, timezone: 'UTC', note: null, createdAt: application.updated_at, updatedAt: application.updated_at });
  }
  return steps;
}
