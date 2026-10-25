import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { MemoryStaffSessions } from '../src/http/memoryStaffSessions.js';
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from './support/harness.js';
import { tickGate } from './support/tickGate.js';

const UNRELEASED = {
  released: false,
  released_by: null,
  released_at: null,
  note: null,
};

describe('field release', () => {
  let h: Harness;
  let t: TenantFixture;
  let other: TenantFixture;
  const token = 'portfolio-feed-token-for-field-release';

  beforeAll(async () => {
    h = await startHarness();
    t = await createTenant(h, { slug: 'field-release' });
    other = await createTenant(h, { slug: 'field-release-other' });
  });
  afterAll(async () => {
    await h?.close();
  });

  const as = (key: keyof TenantFixture['staff']) => h.as(t.staff[key]!.token);
  const feed = () =>
    supertest(
      createApp({
        database: h.db,
        staffSessions: new MemoryStaffSessions(),
        serveConsole: false,
        portfolio: { tenantId: t.id, token },
      }),
    );

  async function project(number = 'FR-1', start = '2026-10-28') {
    const res = await as('owner')
      .post('/api/v1/projects/projects')
      .send(projectBody({ project_number: number, scheduled_start: start, name: `Release ${number}` }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.field_release).toEqual(UNRELEASED);
    expect(res.body.data.scheduled_start).toBe(start);
    return res.body.data as { id: string; project_number: string };
  }

  it('does not call ServiceTitan or QuickBooks', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = [
      'src/routes/fieldRelease.ts',
      'src/domain/fieldRelease.ts',
      'client/fieldRelease.js',
    ]
      .map((file) => readFileSync(path.join(root, file), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/adapters\/(quickbooks|serviceTitan|servicetitan)/);
  });

  it('exposes an unreleased flag and scheduled_start on the project and portfolio reads', async () => {
    const created = await project('FR-READ', '2026-10-30');
    const detail = await as('office').get(`/api/v1/projects/projects/${created.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.scheduled_start).toBe('2026-10-30');
    expect(detail.body.data.field_release).toEqual({ ...UNRELEASED, history: [] });
    expect(detail.body.data.field_start).toEqual({ date: null, source: null, observed_at: null });
    expect(detail.body.data.field_start_source).toBeUndefined();
    expect(detail.body.data.precon.open).toBe(7);
    expect(detail.body.data.precon.tasks).toHaveLength(7);

    const list = await as('pm').get('/api/v1/projects/projects?per_page=200');
    const row = (list.body.data as Array<{
      id: string;
      scheduled_start: string;
      field_release: unknown;
      field_start: { date: string | null; source: string | null; observed_at: string | null };
      precon: { open: number; overdue: number; tasks?: unknown };
    }>).find((item) => item.id === created.id);
    expect(row?.scheduled_start).toBe('2026-10-30');
    expect(row?.field_release).toEqual(UNRELEASED);
    expect(row?.field_start).toEqual({ date: null, source: null, observed_at: null });
    expect(row?.precon).toEqual({ open: 7, overdue: detail.body.data.precon.overdue });
    expect(row?.precon?.tasks).toBeUndefined();

    const summary = await feed().get('/api/v1/portfolio/summary').set('Authorization', `Bearer ${token}`);
    expect(summary.status).toBe(200);
    const summaryRow = (
      summary.body.data.projects as Array<{
        id: string;
        scheduled_start: string;
        field_release: unknown;
        field_start: { date: string | null; source: string | null; observed_at: string | null };
        precon: { open: number; overdue: number };
      }>
    ).find((item) => item.id === created.id);
    expect(summaryRow?.scheduled_start).toBe('2026-10-30');
    expect(summaryRow?.field_release).toEqual(UNRELEASED);
    expect(summaryRow?.field_start).toEqual({ date: null, source: null, observed_at: null });
    expect(summaryRow?.precon).toEqual({ open: 7, overdue: detail.body.data.precon.overdue });

    const portfolioProjects = await feed().get('/api/v1/portfolio/projects').set('Authorization', `Bearer ${token}`);
    const portfolioRow = (
      portfolioProjects.body.data.projects as Array<{
        id: string;
        scheduled_start: string;
        field_release: unknown;
        field_start: { date: string | null; source: string | null; observed_at: string | null };
        precon: { open: number; overdue: number };
      }>
    ).find((item) => item.id === created.id);
    expect(portfolioRow?.scheduled_start).toBe('2026-10-30');
    expect(portfolioRow?.field_release).toEqual(UNRELEASED);
    expect(portfolioRow?.field_start).toEqual({ date: null, source: null, observed_at: null });
    expect(portfolioRow?.precon).toEqual({ open: 7, overdue: detail.body.data.precon.overdue });
  });

  it('lets owner and manager release and undo, and keeps an append-only history', async () => {
    const created = await project('FR-HIST');
    const session = await as('manager').get('/api/v1/projects/session');
    expect(session.body.data.capabilities).toContain('record_field_release');

    const released = await as('manager')
      .post(`/api/v1/projects/projects/${created.id}/field-release`)
      .send({ note: '  Crew confirmed  ' });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.data.released).toBe(true);
    expect(released.body.data.released_by).toBe('manager');
    expect(released.body.data.note).toBe('Crew confirmed');
    expect(released.body.data.released_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(released.body.data.history).toEqual([
      expect.objectContaining({
        action: 'release',
        actor: 'manager',
        note: 'Crew confirmed',
      }),
    ]);
    expect(released.body.data.history[0].occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const again = await as('owner')
      .post(`/api/v1/projects/projects/${created.id}/field-release`)
      .send({ note: 'Owner reconfirmed' });
    expect(again.status).toBe(200);
    expect(again.body.data.released_by).toBe('owner');
    expect(again.body.data.note).toBe('Owner reconfirmed');
    expect(again.body.data.history).toHaveLength(2);
    expect(again.body.data.history[0].note).toBe('Crew confirmed');
    expect(again.body.data.history[1]).toEqual(
      expect.objectContaining({ action: 'release', actor: 'owner', note: 'Owner reconfirmed' }),
    );

    const blank = await as('manager').post(`/api/v1/projects/projects/${created.id}/field-release`).send({ note: '   ' });
    expect(blank.status).toBe(200);
    expect(blank.body.data.note).toBeNull();
    expect(blank.body.data.released).toBe(true);

    const undone = await as('owner')
      .post(`/api/v1/projects/projects/${created.id}/field-release/undo`)
      .send({ note: 'Start moved' });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(undone.body.data).toMatchObject(UNRELEASED);
    expect(undone.body.data.history.map((event: { action: string }) => event.action)).toEqual([
      'release',
      'release',
      'release',
      'undo',
    ]);
    expect(undone.body.data.history[0].note).toBe('Crew confirmed');
    expect(undone.body.data.history[3]).toEqual(
      expect.objectContaining({ action: 'undo', actor: 'owner', note: 'Start moved' }),
    );

    const detail = await as('office').get(`/api/v1/projects/projects/${created.id}`);
    expect(detail.body.data.field_release.released).toBe(false);
    expect(detail.body.data.field_release.history).toHaveLength(4);

    const summary = await feed().get('/api/v1/portfolio/summary').set('Authorization', `Bearer ${token}`);
    const summaryRow = (summary.body.data.projects as Array<{ id: string; field_release: { released: boolean } }>).find(
      (item) => item.id === created.id,
    );
    expect(summaryRow?.field_release.released).toBe(false);

    const secondUndo = await as('manager')
      .post(`/api/v1/projects/projects/${created.id}/field-release/undo`)
      .send({});
    expect(secondUndo.status).toBe(409);
    expect(secondUndo.body.error.code).toBe('conflict');

    const tooLong = await as('owner')
      .post(`/api/v1/projects/projects/${created.id}/field-release`)
      .send({ note: 'x'.repeat(2001) });
    expect(tooLong.status).toBe(400);

    await expect(
      h.db.withTenant(t.id, (c) =>
        c.query(`UPDATE projects.field_release_events SET note = 'rewritten' WHERE project_id = $1`, [created.id]),
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      h.db.withTenant(t.id, (c) =>
        c.query(`DELETE FROM projects.field_release_events WHERE project_id = $1`, [created.id]),
      ),
    ).rejects.toThrow(/append-only/);
    const kept = await h.db.withTenant(t.id, (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.field_release_events WHERE project_id = $1`,
        [created.id],
      ),
    );
    expect(kept.rows[0]?.n).toBe('4');

    const removed = await as('owner')
      .del(`/api/v1/projects/projects/${created.id}`)
      .send({ confirm_project_number: created.project_number });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const gone = await h.db.withTenant(t.id, (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects.field_release_events WHERE project_id = $1`,
        [created.id],
      ),
    );
    expect(gone.rows[0]?.n).toBe('0');
  });

  it('refuses office, project_manager, estimator, and bookkeeper, including a view of someone else', async () => {
    const created = await project('FR-ROLE');
    await as('owner').post(`/api/v1/projects/projects/${created.id}/field-release`).send({ note: 'Capacity yes' });

    for (const role of ['office', 'pm', 'estimator', 'bookkeeper'] as const) {
      const session = await as(role).get('/api/v1/projects/session');
      expect(session.body.data.capabilities, role).not.toContain('record_field_release');
      const release = await as(role)
        .post(`/api/v1/projects/projects/${created.id}/field-release`)
        .send({ note: 'no' });
      expect(release.status, role).toBe(403);
      expect(release.body.error.code).toBe('forbidden');
      const undo = await as(role).post(`/api/v1/projects/projects/${created.id}/field-release/undo`).send({});
      expect(undo.status, role).toBe(403);
      const seen = await as(role).get(`/api/v1/projects/projects/${created.id}`);
      expect(seen.status, role).toBe(200);
      expect(seen.body.data.field_release.released).toBe(true);
      expect(seen.body.data.field_release.released_by).toBe('owner');
      expect(seen.body.data.field_release.note).toBe('Capacity yes');
    }

    const foreign = await h
      .as(other.staff.owner!.token)
      .post(`/api/v1/projects/projects/${created.id}/field-release`)
      .send({ note: 'other tenant' });
    expect(foreign.status).toBe(404);
    const foreignUndo = await h
      .as(other.staff.manager!.token)
      .post(`/api/v1/projects/projects/${created.id}/field-release/undo`)
      .send({});
    expect(foreignUndo.status).toBe(404);
  });

  it('does not block scheduling or Gate 2 approval', async () => {
    const created = await project('FR-OPEN');
    const before = await as('owner').post(`/api/v1/projects/projects/${created.id}/schedule`).send({
      title: 'Site walk',
      window_start: '2026-11-02',
      window_end: '2026-11-03',
    });
    expect(before.status, JSON.stringify(before.body)).toBe(201);

    await tickGate(as('pm'), created.id, 2);
    const gate = await as('pm').post(`/api/v1/projects/projects/${created.id}/gates/2/approve`);
    expect(gate.status, JSON.stringify(gate.body)).toBe(200);
    expect(gate.body.data.status).toBe('approved');

    const released = await as('manager').post(`/api/v1/projects/projects/${created.id}/field-release`).send({});
    expect(released.status).toBe(200);
    const after = await as('pm').post(`/api/v1/projects/projects/${created.id}/schedule`).send({
      title: 'Mobilization',
      window_start: '2026-11-04',
      window_end: '2026-11-04',
      status: 'confirmed',
    });
    expect(after.status, JSON.stringify(after.body)).toBe(201);
    expect(after.body.data.status).toBe('confirmed');

    const detail = await as('office').get(`/api/v1/projects/projects/${created.id}`);
    expect(detail.body.data.gates.find((g: { gate_number: number }) => g.gate_number === 2).status).toBe('approved');
    expect(detail.body.data.field_release.released).toBe(true);
  });
});
