import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from './support/harness.js';

let h: Harness;
let t: TenantFixture;
let projectId: string;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

const owner = () => h.as(t.staff.owner!.token);

let n = 0;
beforeEach(async () => {
  t = await createTenant(h, { slug: `phase4-${n++}` });
  const res = await owner().post('/api/v1/projects/projects').send(projectBody());
  expect(res.status).toBe(201);
  projectId = res.body.data.id;
});

async function schedule() {
  const res = await owner()
    .post(`/api/v1/projects/projects/${projectId}/draws`)
    .send({
      draws: [
        { label: 'Deposit', trigger_milestone: 'Contract signature', amount: 10450 },
        { label: 'Draw 1', trigger_milestone: 'Demolition complete', amount: 10450 },
        { label: 'Final', trigger_milestone: 'Punch complete', amount: 4180 },
      ],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as Array<{ id: string; label: string }>;
}

describe('draws — the revenue control', () => {
  it('numbers the schedule in order', async () => {
    const draws = await schedule();
    expect(draws.map((d: any) => d.sequence_number)).toEqual([1, 2, 3]);
  });

  it('must be earned before it can be approved', async () => {
    const [deposit] = await schedule();
    const early = await owner().post(`/api/v1/projects/draws/${deposit!.id}/approve`);
    expect(early.status).toBe(409);

    expect((await owner().post(`/api/v1/projects/draws/${deposit!.id}/earn`)).status).toBe(200);
    const approved = await owner().post(`/api/v1/projects/draws/${deposit!.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('approved');
  });

  it('only an owner or manager approves', async () => {
    const [deposit] = await schedule();
    await owner().post(`/api/v1/projects/draws/${deposit!.id}/earn`);
    const byPm = await h
      .as(t.staff.pm!.token)
      .post(`/api/v1/projects/draws/${deposit!.id}/approve`);
    expect(byPm.status).toBe(403);
  });

  it('an approved draw with no invoice number is the exception this module exists for', async () => {
    const [deposit] = await schedule();
    await owner().post(`/api/v1/projects/draws/${deposit!.id}/earn`);
    await owner().post(`/api/v1/projects/draws/${deposit!.id}/approve`);

    const exceptions = await owner().get('/api/v1/projects/exceptions/draws');
    expect(exceptions.body.data).toHaveLength(1);
    expect(exceptions.body.data[0].label).toBe('Deposit');

    const recorded = await h
      .as(t.staff.office!.token)
      .post(`/api/v1/projects/draws/${deposit!.id}/external-invoice`)
      .send({ external_invoice_number: '118432-1' });
    expect(recorded.status).toBe(200);

    // Status and recorded_at come from the database trigger, not the handler.
    expect(recorded.body.data.status).toBe('invoiced');
    expect(recorded.body.data.external_invoice_recorded_at).toBeTruthy();
    // Recording is a human assertion; verification is a separate call.
    expect(recorded.body.data.external_invoice_verified_at).toBeNull();

    const after = await owner().get('/api/v1/projects/exceptions/draws');
    expect(after.body.data).toHaveLength(0);
  });

  it('recording the same draw twice is draw_already_invoiced', async () => {
    const [deposit] = await schedule();
    await owner().post(`/api/v1/projects/draws/${deposit!.id}/earn`);
    await owner().post(`/api/v1/projects/draws/${deposit!.id}/approve`);
    await owner()
      .post(`/api/v1/projects/draws/${deposit!.id}/external-invoice`)
      .send({ external_invoice_number: '118432-1' });

    const again = await owner()
      .post(`/api/v1/projects/draws/${deposit!.id}/external-invoice`)
      .send({ external_invoice_number: '118432-9' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('draw_already_invoiced');
  });

  it('a project manager cannot record an invoice number', async () => {
    const [deposit] = await schedule();
    await owner().post(`/api/v1/projects/draws/${deposit!.id}/earn`);
    await owner().post(`/api/v1/projects/draws/${deposit!.id}/approve`);
    const res = await h
      .as(t.staff.pm!.token)
      .post(`/api/v1/projects/draws/${deposit!.id}/external-invoice`)
      .send({ external_invoice_number: 'X-1' });
    expect(res.status).toBe(403);
  });

  it('the manual adapter reports verification unavailable rather than pretending', async () => {
    const [deposit] = await schedule();
    const list = await owner().get(`/api/v1/projects/projects/${projectId}/draws`);
    expect(list.body.data.verification_available).toBe(false);
    expect(list.body.data.revenue_system).toBe('Manual entry');

    await owner().post(`/api/v1/projects/draws/${deposit!.id}/earn`);
    await owner().post(`/api/v1/projects/draws/${deposit!.id}/approve`);
    await owner()
      .post(`/api/v1/projects/draws/${deposit!.id}/external-invoice`)
      .send({ external_invoice_number: '118432-1' });

    // A failed check is a 200 with verified false, not an error — the mismatch
    // is information the office needs, not a system fault.
    const verify = await owner().post(`/api/v1/projects/draws/${deposit!.id}/verify`);
    expect(verify.status).toBe(200);
    expect(verify.body.data.verified).toBe(false);
    expect(verify.body.data.verification_available).toBe(false);

    // And verified_at stays null, because nothing verified it.
    const after = await owner().get(`/api/v1/projects/projects/${projectId}/draws`);
    expect(after.body.data.draws[0].external_invoice_verified_at).toBeNull();
  });

  it('replacing the schedule is refused once a draw has been earned', async () => {
    const [deposit] = await schedule();
    await owner().post(`/api/v1/projects/draws/${deposit!.id}/earn`);

    const replace = await owner()
      .post(`/api/v1/projects/projects/${projectId}/draws`)
      .send({ draws: [{ label: 'Everything', trigger_milestone: 'Done', amount: 25080 }] });
    expect(replace.status).toBe(409);
    expect(replace.body.error.details.committed_draws).toBe(1);
  });

  it('replacing an untouched schedule is fine', async () => {
    await schedule();
    const replace = await owner()
      .post(`/api/v1/projects/projects/${projectId}/draws`)
      .send({
        draws: [
          { label: 'Deposit', trigger_milestone: 'Signature', amount: 12000 },
          { label: 'Final', trigger_milestone: 'Punch', amount: 12000 },
        ],
      });
    expect(replace.status).toBe(201);
    expect(replace.body.data).toHaveLength(2);
  });
});

describe('permits', () => {
  async function jurisdiction() {
    const res = await owner()
      .post('/api/v1/projects/jurisdictions')
      .send({ name: `County ${Math.random().toString(36).slice(2, 7)}`, typical_review_days: 12 });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  it('seeds the milestone chain from the tenant template', async () => {
    const res = await owner()
      .post(`/api/v1/projects/projects/${projectId}/permits`)
      .send({
        jurisdiction_id: await jurisdiction(),
        permit_type: 'Building',
        applied_on: '2026-07-01',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.milestones_created).toBe(12);

    const permits = await owner().get(`/api/v1/projects/projects/${projectId}/permits`);
    const milestones = permits.body.data[0].milestones;
    expect(milestones[0].name).toBe('Permit requirement determined');
    // Template offset of -10 days applied to the application date.
    expect(milestones[0].due_on).toBe('2026-06-21');
  });

  it('a failed inspection is a status, not a delete', async () => {
    await owner()
      .post(`/api/v1/projects/projects/${projectId}/permits`)
      .send({ jurisdiction_id: await jurisdiction(), permit_type: 'Building' });
    const permits = await owner().get(`/api/v1/projects/projects/${projectId}/permits`);
    const roughIn = permits.body.data[0].milestones.find(
      (m: any) => m.name === 'Rough-in inspection passed',
    );

    const failed = await owner()
      .patch(`/api/v1/projects/permit-milestones/${roughIn.id}`)
      .send({ status: 'failed', note: 'DWV not vented at the lavatory' });
    expect(failed.status).toBe(200);
    expect(failed.body.data.status).toBe('failed');
    expect(failed.body.data.note).toContain('DWV');

    // Still there, and the re-inspection is the same row changing state.
    const after = await owner().get(`/api/v1/projects/projects/${projectId}/permits`);
    const still = after.body.data[0].milestones.find(
      (m: any) => m.name === 'Rough-in inspection passed',
    );
    expect(still.status).toBe('failed');
  });

  it('an overdue milestone appears in the exception view', async () => {
    await owner()
      .post(`/api/v1/projects/projects/${projectId}/permits`)
      .send({
        jurisdiction_id: await jurisdiction(),
        permit_type: 'Building',
        applied_on: '2026-01-01',
      });

    const res = await owner().get('/api/v1/projects/exceptions/permits');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].days_overdue).toBeGreaterThan(0);
  });

  it('a permit marked not required needs a reason', async () => {
    const res = await owner()
      .post(`/api/v1/projects/projects/${projectId}/permits`)
      .send({
        jurisdiction_id: await jurisdiction(),
        permit_type: 'Building',
        not_required: true,
      });
    expect(res.status).toBe(400);
  });
});

describe('schedule and daily logs', () => {
  it('a compliance-blocked vendor cannot be confirmed onto a window', async () => {
    const vendor = await owner()
      .post('/api/v1/projects/vendors')
      .send({ legal_name: 'Uninsured Co', email: 'unins@v.test' });

    const res = await owner()
      .post(`/api/v1/projects/projects/${projectId}/schedule`)
      .send({
        title: 'Tile setting',
        vendor_id: vendor.body.data.id,
        window_start: '2026-09-01',
        window_end: '2026-09-03',
        status: 'confirmed',
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('compliance_blocked');
  });

  it('but can be pencilled in as proposed', async () => {
    const vendor = await owner()
      .post('/api/v1/projects/vendors')
      .send({ legal_name: 'Renewal Pending Co', email: 'renew@v.test' });

    const res = await owner()
      .post(`/api/v1/projects/projects/${projectId}/schedule`)
      .send({
        title: 'Tile setting',
        vendor_id: vendor.body.data.id,
        window_start: '2026-09-01',
        window_end: '2026-09-03',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('proposed');
  });

  it('a window that ends before it starts is refused', async () => {
    const res = await owner()
      .post(`/api/v1/projects/projects/${projectId}/schedule`)
      .send({ title: 'Backwards', window_start: '2026-09-05', window_end: '2026-09-01' });
    expect(res.status).toBe(400);
  });

  it('dates come back as calendar days, not instants', async () => {
    // A `date` has no time and no zone. Parsed into a JS Date and serialised
    // to JSON it becomes an instant, and west of Greenwich that instant reads
    // as the day before — every due date and window, off by one, for some
    // users only.
    await owner()
      .post(`/api/v1/projects/projects/${projectId}/schedule`)
      .send({ title: 'Tile', window_start: '2026-09-01', window_end: '2026-09-03' });
    const res = await owner().get(`/api/v1/projects/projects/${projectId}/schedule`);
    expect(res.body.data[0].window_start).toBe('2026-09-01');
    expect(res.body.data[0].window_end).toBe('2026-09-03');
  });

  it('one daily log per project per date', async () => {
    const first = await owner()
      .post(`/api/v1/projects/projects/${projectId}/daily-logs`)
      .send({ log_date: '2026-08-04', work_completed: 'Tile set to the wet wall.' });
    expect(first.status).toBe(201);

    const duplicate = await owner()
      .post(`/api/v1/projects/projects/${projectId}/daily-logs`)
      .send({ log_date: '2026-08-04', work_completed: 'Written twice.' });
    expect(duplicate.status).toBe(409);
  });

  it('an office user cannot write a daily log', async () => {
    const res = await h
      .as(t.staff.office!.token)
      .post(`/api/v1/projects/projects/${projectId}/daily-logs`)
      .send({ log_date: '2026-08-04', work_completed: 'x' });
    expect(res.status).toBe(403);
  });
});
