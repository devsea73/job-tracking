import { describe, expect, it } from 'vitest';
import type { ActivityResponse, ApplicationSummary, JobListResponse, TeamMember } from '../src/shared/api';
import { furthestStage } from '../src/shared/pipeline';
import { isUnreadableNote, UNREADABLE_NOTES, unreadableReason } from '../src/shared/unreadable';
import { compareJobs } from '../src/server/dedupe/scoring';
import { htmlToText, looksLikeHtml } from '../src/server/extraction/text';
import { repairHtmlDescriptions } from '../src/server/services/job-facts-store';
import { createTestServer, createUsers, jobPage } from './helpers';

/**
 * Where an application is comes from its timeline, never from a status set by hand. A step put in
 * by mistake is corrected by removing it or changing it, and everything counted follows at once.
 */
describe('a step put in by mistake', () => {
  async function applied() {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'andy');
    server.http.serve('https://careers.example.com/jobs/1', jobPage({ title: 'Data Engineer', company: 'Acme' }));
    const added = await users.andy.addJob('https://careers.example.com/jobs/1');
    if (added.outcome !== 'created') throw new Error(added.outcome);
    const andy = users.andy;
    const add = (stage: Parameters<typeof andy.addStep>[1], at: string) => andy.addStep(added.applicationId, stage, at);
    const change = (stepId: number, stage: string, at: string) => andy.patch(`/api/steps/${stepId}`, { stage, at, timezone: 'UTC' });
    const remove = (stepId: number) => andy.delete(`/api/steps/${stepId}`);
    const mine = async () => ((await andy.get('/api/jobs?scope=mine')).json as JobListResponse).items[0].applications[0] as ApplicationSummary;
    const team = async () => ((await andy.get('/api/team')).json as TeamMember[]).find((member) => member.user.username === 'andy')?.stats;
    // October 2026, in UTC: what the trend lines count, bucket by bucket.
    const trends = async () => ((await andy.get('/api/activity?tz=UTC&today=2026-10-31&from=2026-10-01&to=2026-10-31&scope=me')).json as ActivityResponse).people[0].trends;
    const sum = (values: Array<number | null>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
    return { add, change, remove, mine, team, trends, sum, applicationId: added.applicationId, andy };
  }

  it('no longer counts anywhere once it is removed', async () => {
    const { add, remove, mine, team, trends, sum } = await applied();
    const final = await add('Final Interview', '2026-10-05T10:00:00Z');
    expect(await mine()).toMatchObject({ stage: 'Final Interview', furthestStage: 'Final Interview', interviewCount: 1 });
    expect(await team()).toMatchObject({ interviews: 1, technical: 1, interviewPass: { reached: 1 } });
    expect(sum((await trends()).final)).toBe(1);

    expect((await remove(final.id)).status).toBe(200);
    expect(await mine()).toMatchObject({ stage: 'Applied', furthestStage: 'Applied', interviewCount: 0 });
    expect(await team()).toMatchObject({ interviews: 0, technical: 0, screenPass: { reached: 0 }, interviewPass: { reached: 0 } });
    const after = await trends();
    expect(sum(after.interviews)).toBe(0);
    expect(sum(after.technical)).toBe(0);
    expect(sum(after.final)).toBe(0);
  });

  it('sets the stage again when its stage or time is changed', async () => {
    const { add, change, mine, trends, sum } = await applied();
    const screen = await add('Recruiter Screen', '2026-10-03T10:00:00Z');
    const technical = await add('Technical Interview', '2026-10-05T10:00:00Z');
    expect(await mine()).toMatchObject({ stage: 'Technical Interview', furthestStage: 'Technical Interview' });

    // Entered as a technical round, but it was a second screen.
    expect((await change(technical.id, 'Recruiter Screen', '2026-10-05T10:00:00Z')).status).toBe(200);
    expect(await mine()).toMatchObject({ stage: 'Recruiter Screen', furthestStage: 'Recruiter Screen' });
    expect(sum((await trends()).technical)).toBe(0);

    // The first screen was really later than the second step: the stage is the latest one's.
    expect((await change(technical.id, 'Technical Interview', '2026-10-05T10:00:00Z')).status).toBe(200);
    expect((await change(screen.id, 'Recruiter Screen', '2026-10-07T10:00:00Z')).status).toBe(200);
    expect(await mine()).toMatchObject({ stage: 'Recruiter Screen', furthestStage: 'Technical Interview' });
    // Each stage counts on the day of its first step, as entered.
    const lines = await trends();
    expect(lines.technical[4]).toBe(1);
    expect(lines.interviews[4]).toBe(1);
    expect(sum(lines.interviews)).toBe(1);
  });

  it('keeps the furthest stage reached when the job is rejected', async () => {
    const { add, mine } = await applied();
    await add('Technical Interview', '2026-10-05T10:00:00Z');
    await add('Rejected', '2026-10-06T10:00:00Z');
    expect(await mine()).toMatchObject({ stage: 'Rejected', furthestStage: 'Technical Interview' });
  });

  it('takes the interviews after an offer or rejection off the timeline, and nothing before it', async () => {
    const { add, mine, andy, applicationId } = await applied();
    const first = await add('Technical Interview', '2026-10-05T10:00:00Z');
    const third = await add('Technical Interview', '2026-10-12T10:00:00Z');
    const rejected = await add('Rejected', '2026-10-08T10:00:00Z');
    expect(rejected.removed.map((step) => step.id)).toEqual([third.id]);
    const steps = (await andy.get(`/api/jobs/${(await andy.get('/api/jobs?scope=mine')).json.items[0].id}`)).json.applications[0].steps;
    expect(steps.map((step: { id: number }) => step.id)).toEqual([first.id, rejected.id]);
    expect(await mine()).toMatchObject({ stage: 'Rejected', furthestStage: 'Technical Interview', interviewCount: 1 });

    // Asked back after all: an interview after the rejection stays, and is where it is now.
    const again = await add('Final Interview', '2026-10-20T10:00:00Z');
    expect(again.removed).toEqual([]);
    expect(await mine()).toMatchObject({ stage: 'Final Interview', furthestStage: 'Final Interview' });
    expect(applicationId).toBe(again.applicationId);
  });

  it('counts every step there, whatever order they are in', () => {
    expect(furthestStage(['Final Interview', 'Recruiter Screen'])).toBe('Final Interview');
    expect(furthestStage(['Technical Interview', 'Rejected'])).toBe('Technical Interview');
    expect(furthestStage(['Rejected'])).toBe('Applied');
  });
});

describe('descriptions that arrive as markup', () => {
  const POSTED = '<p>RENFROE is seeking a <strong>Senior Software Engineer</strong>.</p><ul><li>Build APIs</li><li>Own features</li></ul>';

  it('turns markup into text', () => {
    const text = htmlToText(POSTED);
    expect(looksLikeHtml(text)).toBe(false);
    expect(text).toContain('RENFROE is seeking a Senior Software Engineer.');
    expect(text).toMatch(/- Build APIs\s+- Own features/);
  });

  it('handles markup encoded once or twice, even inside real tags', () => {
    const once = POSTED.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const twice = once.replace(/&/g, '&amp;');
    expect(htmlToText(once)).toBe(htmlToText(POSTED));
    expect(htmlToText(twice)).toBe(htmlToText(POSTED));
    expect(htmlToText(`<div>${once}</div>`)).toBe(htmlToText(POSTED));
  });

  it('leaves plain text alone', () => {
    expect(looksLikeHtml('Use C# and compare a < b and c > d.')).toBe(false);
    expect(looksLikeHtml('<p>Hi</p>')).toBe(true);
  });

  it('saves typed-in or pasted markup as text', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'andy');
    const added = await users.andy.addJob('https://careers.example.com/jobs/2', { manual: { title: 'Senior Software Engineer', company: 'RENFROE', description: POSTED } });
    if (added.outcome !== 'created') throw new Error(added.outcome);
    expect((await users.andy.get(`/api/jobs/${added.jobId}`)).json.description).toBe(htmlToText(POSTED));
  });

  it('fixes descriptions already saved as markup, once', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'andy');
    server.http.serve('https://careers.example.com/jobs/3', jobPage({ title: 'Engineer', company: 'Acme' }));
    const added = await users.andy.addJob('https://careers.example.com/jobs/3');
    if (added.outcome !== 'created') throw new Error(added.outcome);
    const sqlite = server.ctx.handle.sqlite;
    sqlite.prepare('UPDATE jobs SET description = ? WHERE id = ?').run(POSTED, added.jobId);
    expect(repairHtmlDescriptions(sqlite)).toBe(1);
    expect((sqlite.prepare('SELECT description FROM jobs WHERE id = ?').get(added.jobId) as { description: string }).description).toBe(htmlToText(POSTED));
    expect(repairHtmlDescriptions(sqlite)).toBe(0);
  });
});

describe('jobs whose posting could not be read', () => {
  it('say why, in one plain sentence', () => {
    expect(unreadableReason('not_found', 'This posting appears to have been closed or removed from the site.')).toBe('closed');
    expect(unreadableReason('blocked', 'This job site showed a bot check instead of the posting.')).toBe('blocked');
    expect(unreadableReason('blocked', 'This job site refused the automated request (HTTP 429).')).toBe('refused');
    expect(unreadableReason('blocked', 'This page requires signing in, so its details cannot be read automatically.')).toBe('sign_in');
    expect(unreadableReason('timeout', 'The job site took too long to respond.')).toBe('unreachable');
    expect(unreadableReason('incomplete', 'Could not find the description on this page.')).toBe('no_description');
    expect(isUnreadableNote(UNREADABLE_NOTES.closed)).toBe(true);
    expect(isUnreadableNote('We are hiring a data engineer.')).toBe(false);
  });

  it('are never alike because they share a note', () => {
    const job = { company: 'JobDiva Staffing', title: 'Unknown title', location: null, description: UNREADABLE_NOTES.blocked, identifiers: [] };
    expect(compareJobs(job, { ...job }).decision).not.toBe('auto');
    expect(compareJobs(job, { ...job }).reasons).not.toContain('Identical description');
  });
});
