import { describe, expect, it } from 'vitest';
import type { JobListResponse } from '../src/shared/api';
import { createTestServer, createUsers, jobPage } from './helpers';

describe('sorting My Applications by applied date', () => {
  it('puts the latest applied first, apart from when each job was added', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'andy');
    const added: number[] = [];
    for (const [index, company] of ['Acme', 'Globex', 'Initech'].entries()) {
      server.http.serve(`https://careers.example.com/jobs/${index}`, jobPage({ title: `Data Engineer ${index}`, company }));
      const response = await users.andy.addJob(`https://careers.example.com/jobs/${index}`);
      if (response.outcome !== 'created') throw new Error(response.outcome);
      added.push(response.jobId);
    }
    // Applied in a different order from the one they were added in, as an imported list can be.
    const appliedOn = ['2026-09-10T12:00:00.000Z', '2026-08-30T12:00:00.000Z', '2026-10-01T12:00:00.000Z'];
    added.forEach((jobId, index) => server.ctx.handle.sqlite.prepare('UPDATE applications SET applied_at = ? WHERE job_id = ?').run(appliedOn[index], jobId));

    const order = async (sort: string) => ((await users.andy.get(`/api/jobs?scope=mine&sort=${sort}`)).json as JobListResponse).items.map((job) => job.company);
    expect(await order('applied')).toEqual(['Initech', 'Acme', 'Globex']);
    expect(await order('recent')).toEqual(['Initech', 'Globex', 'Acme']);
  });
});
