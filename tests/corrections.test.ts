import { describe, expect, it } from 'vitest';
import type { JobListResponse, TeamMember } from '../src/shared/api';
import { furthestStage } from '../src/shared/pipeline';
import { isUnreadableNote, UNREADABLE_NOTES, unreadableReason } from '../src/shared/unreadable';
import { compareJobs } from '../src/server/dedupe/scoring';
import { htmlToText, looksLikeHtml } from '../src/server/extraction/text';
import { repairHtmlDescriptions } from '../src/server/services/job-facts-store';
import { createTestServer, createUsers, jobPage } from './helpers';

describe('a status set back by mistake', () => {
  async function applied() {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'andy');
    server.http.serve('https://careers.example.com/jobs/1', jobPage({ title: 'Data Engineer', company: 'Acme' }));
    const added = await users.andy.addJob('https://careers.example.com/jobs/1');
    if (added.outcome !== 'created') throw new Error(added.outcome);
    const setStatus = (status: string) => users.andy.patch(`/api/applications/${added.applicationId}`, { status });
    const furthest = async () => ((await users.andy.get('/api/jobs?scope=mine')).json as JobListResponse).items[0].applications[0].furthestStage;
    const team = async () => ((await users.andy.get('/api/team')).json as TeamMember[]).find((member) => member.user.username === 'andy');
    return { setStatus, furthest, team };
  }

  it('no longer counts the stages clicked by mistake', async () => {
    const { setStatus, furthest, team } = await applied();
    await setStatus('Final Interview');
    expect(await furthest()).toBe('Final Interview');
    await setStatus('Applied');
    expect(await furthest()).toBe('Applied');
    expect(JSON.stringify(await team())).not.toContain('"final":1');
  });

  it('keeps the furthest stage when a job is rejected', async () => {
    const { setStatus, furthest } = await applied();
    await setStatus('Technical Interview');
    await setStatus('Rejected');
    expect(await furthest()).toBe('Technical Interview');
  });

  it('counts the stage it was moved back to', async () => {
    const { setStatus, furthest } = await applied();
    await setStatus('Offer');
    await setStatus('Recruiter Screen');
    expect(await furthest()).toBe('Recruiter Screen');
  });

  it('follows the same rule when stages are read from history', () => {
    expect(furthestStage(['Applied', 'Final Interview', 'Applied'])).toBe('Applied');
    expect(furthestStage(['Applied', 'Technical Interview', 'Rejected'])).toBe('Technical Interview');
    expect(furthestStage(['Applied', 'Recruiter Screen', 'Technical Interview'])).toBe('Technical Interview');
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
