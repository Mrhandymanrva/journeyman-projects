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
let n = 0;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  t = await createTenant(h, { slug: `bid-${n++}` });
});

const owner = () => h.as(t.staff.owner!.token);

async function vendor(name: string, compliant: boolean) {
  const created = await owner().post('/api/v1/projects/vendors').send({
    legal_name: name,
    email: `${name.toLowerCase().replace(/\W+/g, '-')}-${n}@v.test`,
  });
  expect(created.status).toBe(201);
  const vendorId = created.body.data.id as string;
  if (!compliant) return vendorId;
  const kinds = await owner().get('/api/v1/projects/compliance-requirements');
  for (const req of kinds.body.data as Array<{ kind: string; required: boolean }>) {
    if (!req.required) continue;
    await owner().post(`/api/v1/projects/vendors/${vendorId}/documents`).send({
      kind: req.kind,
      expires_on: '2027-12-31',
      file_key: `k/${req.kind}`,
    });
  }
  return vendorId;
}

async function bidWithLines() {
  const project = await owner().post('/api/v1/projects/projects').send(projectBody());
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const codes = await owner().get('/api/v1/projects/cost-codes');
  const winner = await vendor('Winner Tile', true);
  const other = await vendor('Other Tile', true);
  const blocked = await vendor('Blocked Tile', false);
  const bid = await owner().post('/api/v1/projects/bid-requests').send({
    project_id: projectId,
    subject: 'Tile',
    scope: 'Set tile',
    vendor_ids: [winner, other, blocked],
  });
  expect(bid.status).toBe(201);
  const detail = await owner().get(`/api/v1/projects/bid-requests/${bid.body.data.id}`);
  const recipients = detail.body.data.recipients as Array<{ id: string; vendor_id: string }>;
  const saved = await owner().put(`/api/v1/projects/bid-requests/${bid.body.data.id}/lines`).send({
    lines: [
      { cost_code_id: codes.body.data[0].id, cost_type: 'S', description: 'Floor' },
      { cost_code_id: codes.body.data[1].id, cost_type: 'S', description: 'Wall' },
    ],
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return {
    projectId,
    bidId: bid.body.data.id as string,
    lines: saved.body.data.lines as Array<{ id: string }>,
    winner: recipients.find((r) => r.vendor_id === winner)!.id,
    other: recipients.find((r) => r.vendor_id === other)!.id,
    blocked: recipients.find((r) => r.vendor_id === blocked)!.id,
    costCodeId: codes.body.data[0].id as string,
  };
}

describe('bid lines, leveling, and award', () => {
  it('levels quotes and awards one draft purchase order', async () => {
    const ctx = await bidWithLines();
    await owner().put(`/api/v1/projects/bid-requests/${ctx.bidId}/recipients/${ctx.winner}/quote-lines`).send({
      lines: [
        { bid_request_line_id: ctx.lines[0]!.id, amount: 4000 },
        { bid_request_line_id: ctx.lines[1]!.id, amount: 1500 },
      ],
    });
    await owner().put(`/api/v1/projects/bid-requests/${ctx.bidId}/recipients/${ctx.other}/quote-lines`).send({
      lines: [{ bid_request_line_id: ctx.lines[0]!.id, amount: 4500 }],
    });
    const level = await owner().get(`/api/v1/projects/bid-requests/${ctx.bidId}/leveling`);
    expect(level.status).toBe(200);
    expect(level.body.data.lines[0].low_amount).toBe(4000);
    expect(level.body.data.lines[1].quotes.find((q: { recipient_id: string }) => q.recipient_id === ctx.other).missing).toBe(true);
    const winner = level.body.data.recipients.find((r: { id: string }) => r.id === ctx.winner);
    expect(winner.total).toBe(5500);
    expect(winner.schedulable).toBe(true);
    const blocked = level.body.data.recipients.find((r: { id: string }) => r.id === ctx.blocked);
    expect(blocked.schedulable).toBe(false);

    const refused = await owner()
      .post(`/api/v1/projects/bid-requests/${ctx.bidId}/recipients/${ctx.blocked}/award`)
      .send({ po_number: 'PO-BLOCKED' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('compliance_blocked');

    const manual = await owner()
      .patch(`/api/v1/projects/bid-requests/${ctx.bidId}/recipients/${ctx.winner}`)
      .send({ response_status: 'awarded', quote_amount: 5500 });
    expect(manual.status).toBe(409);

    const awarded = await owner()
      .post(`/api/v1/projects/bid-requests/${ctx.bidId}/recipients/${ctx.winner}/award`)
      .send({ po_number: `PO-AWARD-${n}` });
    expect(awarded.status, JSON.stringify(awarded.body)).toBe(201);
    expect(awarded.body.data.status).toBe('draft');
    expect(awarded.body.data.amount).toBe(5500);
    const lines = await owner().get(`/api/v1/projects/purchase-orders/${awarded.body.data.id}/lines`);
    expect(lines.body.data.map((line: { original_amount: number }) => line.original_amount).sort()).toEqual([1500, 4000]);

    const again = await owner()
      .post(`/api/v1/projects/bid-requests/${ctx.bidId}/recipients/${ctx.winner}/award`)
      .send({ po_number: 'PO-AGAIN' });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(awarded.body.data.id);
    expect(again.body.data.idempotent).toBe(true);

    const detail = await owner().get(`/api/v1/projects/bid-requests/${ctx.bidId}`);
    const statuses = new Map(
      (detail.body.data.recipients as Array<{ id: string; response_status: string }>).map((r) => [
        r.id,
        r.response_status,
      ]),
    );
    expect(statuses.get(ctx.winner)).toBe('awarded');
    expect(statuses.get(ctx.other)).toBe('not_selected');
    expect(detail.body.data.closed_at).toBeTruthy();
  });

  it('awards a single quote amount when the request has no lines', async () => {
    const project = await owner().post('/api/v1/projects/projects').send(projectBody());
    const vendorId = await vendor('Single Quote', true);
    const codes = await owner().get('/api/v1/projects/cost-codes');
    const bid = await owner().post('/api/v1/projects/bid-requests').send({
      project_id: project.body.data.id,
      subject: 'One number',
      scope: 'Labor',
      vendor_ids: [vendorId],
    });
    const detail = await owner().get(`/api/v1/projects/bid-requests/${bid.body.data.id}`);
    const recipientId = detail.body.data.recipients[0].id as string;
    await owner().patch(`/api/v1/projects/bid-requests/${bid.body.data.id}/recipients/${recipientId}`).send({
      response_status: 'quoted',
      quote_amount: 2200,
    });
    const missing = await owner()
      .post(`/api/v1/projects/bid-requests/${bid.body.data.id}/recipients/${recipientId}/award`)
      .send({ po_number: `PO-ONE-${n}` });
    expect(missing.status).toBe(400);
    const awarded = await owner()
      .post(`/api/v1/projects/bid-requests/${bid.body.data.id}/recipients/${recipientId}/award`)
      .send({ po_number: `PO-ONE-${n}`, cost_code_id: codes.body.data[0].id, cost_type: 'S' });
    expect(awarded.status, JSON.stringify(awarded.body)).toBe(201);
    expect(awarded.body.data.amount).toBe(2200);
  });
});

describe('change orders move purchase order lines once', () => {
  it('adds the line change on approval and does not add it again', async () => {
    const project = await owner().post('/api/v1/projects/projects').send(projectBody());
    const projectId = project.body.data.id as string;
    const vendorId = await vendor('CO Sub', true);
    const loaded = await owner().get(`/api/v1/projects/vendors/${vendorId}`);
    const agreement = (loaded.body.data.documents as Array<{ id: string; kind: string }>).find(
      (d) => d.kind === 'master_agreement',
    )!;
    const codes = await owner().get('/api/v1/projects/cost-codes');
    const po = await owner().post(`/api/v1/projects/projects/${projectId}/purchase-orders`).send({
      po_number: `PO-CO-${n}`,
      vendor_id: vendorId,
      cost_code_id: codes.body.data[0].id,
      cost_type: 'S',
      amount: 1000,
      scope_text: 'Base scope',
      issue: true,
      agreement_document_id: agreement.id,
      agreement_signed_at: '2026-10-01T00:00:00.000Z',
    });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    const co = await owner().post(`/api/v1/projects/projects/${projectId}/change-orders`).send({
      description: 'Extra tile',
      customer_amount: 300,
      lines: [
        {
          cost_code_id: codes.body.data[0].id,
          cost_type: 'S',
          amount: 250,
          po_id: po.body.data.id,
        },
      ],
    });
    expect(co.status, JSON.stringify(co.body)).toBe(201);
    await owner().post(`/api/v1/projects/change-orders/${co.body.data.id}/send`);
    const approved = await owner().post(`/api/v1/projects/change-orders/${co.body.data.id}/approve`).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.po_lines_applied).toBe(1);
    const lines = await owner().get(`/api/v1/projects/purchase-orders/${po.body.data.id}/lines`);
    expect(lines.body.data[0].current_amount).toBe(1250);
    expect(lines.body.data[0].change_amount).toBe(250);

    const budgetBefore = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
    const again = await owner().post(`/api/v1/projects/change-orders/${co.body.data.id}/approve`).send({});
    expect(again.status).toBe(200);
    expect(again.body.data.po_lines_already_applied).toBe(1);
    expect(again.body.data.budget_lines_created).toBe(0);
    const linesAfter = await owner().get(`/api/v1/projects/purchase-orders/${po.body.data.id}/lines`);
    expect(linesAfter.body.data[0].current_amount).toBe(1250);
    const budgetAfter = await owner().get(`/api/v1/projects/projects/${projectId}/budget`);
    expect(budgetAfter.body.data.lines).toEqual(budgetBefore.body.data.lines);
  });
});
