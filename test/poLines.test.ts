import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  estimatePayload,
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
  t = await createTenant(h, { slug: `polines-${n++}` });
});

const owner = () => h.as(t.staff.owner!.token);

async function project() {
  const imported = await owner().post('/api/v1/projects/estimate-imports').send(estimatePayload());
  const created = await owner()
    .post('/api/v1/projects/projects')
    .send(projectBody({ estimate_import_id: imported.body.data.id, source_kind: 'journeyman_estimate' }));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const budget = await owner().get(`/api/v1/projects/projects/${created.body.data.id}/budget`);
  const line = (budget.body.data.lines as Array<Record<string, string>>).find((l) => l.code === '1120')!;
  return { projectId: created.body.data.id as string, costCodeId: line.cost_code_id as string };
}

describe('purchase order lines', () => {
  it('backfills one line and classifies a supplier PO as material', async () => {
    const { projectId, costCodeId } = await project();
    const poId = await h.db.withTenant(t.id, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO projects.purchase_orders
           (tenant_id, project_id, po_number, supplier_name, cost_code_id, cost_type, amount, scope_text, status)
         VALUES ($1,$2,'PO-OLD','Cabinets', $3, 'M', 26080.88, 'Materials', 'issued')
         RETURNING id`,
        [t.id, projectId, costCodeId],
      );
      await c.query(`DELETE FROM projects.po_lines WHERE po_id = $1`, [rows[0]!.id]);
      await c.query(`UPDATE projects.purchase_orders SET kind = 'subcontract' WHERE id = $1`, [rows[0]!.id]);
      await c.query(`SELECT projects.backfill_po_lines()`);
      return rows[0]!.id;
    });
    const row = await h.db.withTenant(t.id, async (c) =>
      c.query<{ kind: string; amount: string; lines: string; original: string }>(
        `SELECT p.kind::text AS kind, p.amount::text AS amount,
                count(l.id)::text AS lines, max(l.original_amount)::text AS original
           FROM projects.purchase_orders p
           LEFT JOIN projects.po_lines l ON l.po_id = p.id
          WHERE p.id = $1 GROUP BY p.id`,
        [poId],
      ),
    );
    expect(row.rows[0]).toMatchObject({ kind: 'material', lines: '1', original: '26080.88' });
    expect(Number(row.rows[0]!.amount)).toBe(26080.88);
  });

  it('keeps the header amount equal to the lines and ignores drafts in committed cost', async () => {
    const { projectId, costCodeId } = await project();
    const vendor = await owner().post('/api/v1/projects/vendors').send({
      legal_name: 'Tile Co',
      email: `tile-${n}@v.test`,
    });
    const kinds = await owner().get('/api/v1/projects/compliance-requirements');
    for (const req of kinds.body.data as Array<{ kind: string; required: boolean }>) {
      if (!req.required) continue;
      await owner().post(`/api/v1/projects/vendors/${vendor.body.data.id}/documents`).send({
        kind: req.kind,
        expires_on: '2027-12-31',
        file_key: `k/${req.kind}`,
      });
    }
    const draft = await owner().post(`/api/v1/projects/projects/${projectId}/purchase-orders`).send({
      po_number: 'PO-DRAFT-COST',
      vendor_id: vendor.body.data.id,
      cost_code_id: costCodeId,
      cost_type: 'S',
      amount: 800,
      scope_text: 'Not issued',
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const before = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    expect((before.body.data as Array<{ cost_code: string; committed_open: number }>).find((r) => r.cost_code === '1120')!.committed_open).toBe(0);

    const vendorRow = await owner().get(`/api/v1/projects/vendors/${vendor.body.data.id}`);
    const agreement = (vendorRow.body.data.documents as Array<{ id: string; kind: string }>).find(
      (d) => d.kind === 'master_agreement',
    );
    const issued = await owner().post(`/api/v1/projects/projects/${projectId}/purchase-orders`).send({
      po_number: 'PO-ISSUED-COST',
      vendor_id: vendor.body.data.id,
      cost_code_id: costCodeId,
      cost_type: 'S',
      amount: 1250.5,
      scope_text: 'Set tile',
      issue: true,
      agreement_document_id: agreement!.id,
      agreement_signed_at: '2026-10-01T00:00:00.000Z',
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const lines = await h.db.withTenant(t.id, (c) =>
      c.query<{ original_amount: string; header: string }>(
        `SELECT l.original_amount::text, p.amount::text AS header
           FROM projects.po_lines l JOIN projects.purchase_orders p ON p.id = l.po_id
          WHERE p.id = $1`,
        [issued.body.data.id],
      ),
    );
    expect(lines.rows).toHaveLength(1);
    expect(Number(lines.rows[0]!.header)).toBe(1250.5);

    const after = await owner().get(`/api/v1/projects/projects/${projectId}/cost-position`);
    expect((after.body.data as Array<{ cost_code: string; committed_open: number }>).find((r) => r.cost_code === '1120')!.committed_open).toBe(1250.5);

    await expect(
      h.db.withTenant(t.id, (c) =>
        c.query(`UPDATE projects.po_lines SET original_amount = 10 WHERE po_id = $1`, [issued.body.data.id]),
      ),
    ).rejects.toThrow(/original amount/i);

    const edited = await owner().patch(`/api/v1/projects/purchase-orders/${draft.body.data.id}`).send({ amount: 900 });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data.amount).toBe(900);
    const blocked = await owner().patch(`/api/v1/projects/purchase-orders/${issued.body.data.id}`).send({ amount: 1 });
    expect(blocked.status).toBe(409);
  });
});
