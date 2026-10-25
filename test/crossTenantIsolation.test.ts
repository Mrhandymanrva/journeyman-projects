import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTenant,
  estimatePayload,
  projectBody,
  startHarness,
  type Harness,
  type TenantFixture,
} from "./support/harness.js";

/**
 * MANDATORY TEST 1 — cross-tenant isolation. Handoff README §2.
 *
 * Log in as tenant A. Request every route with tenant B's identifiers
 * substituted into every path parameter and body field. Every one must return
 * 404 — not 403, which would confirm the row exists.
 *
 * This file is written to be the thing that fails when a route is added
 * without thinking about tenancy: ROUTES below is the list of every staff
 * route the module serves, and there is a test at the bottom asserting the
 * list is complete against the Express router. Adding a route without adding
 * it here breaks the build.
 */

let h: Harness;
let A: TenantFixture;
let B: TenantFixture;

/** Identifiers that belong to tenant B, to be substituted into A's requests. */
interface ForeignIds {
  bidId: string;
  recipientId: string;
  tenantId: string;
  projectId: string;
  estimateImportId: string;
  staffId: string;
  businessUnitId: string;
  budgetLineId: string;
  costCodeId: string;
  vendorId: string;
  documentId: string;
  poId: string;
  poLineId: string;
  billId: string;
  drawId: string;
  jurisdictionId: string;
  permitId: string;
  milestoneId: string;
  scheduleItemId: string;
  changeOrderId: string;
  externalInvoiceId: string;
  projectInvoiceId: string;
  preconTaskId: string;
  inspectionId: string;
}
let foreign: ForeignIds;

beforeAll(async () => {
  h = await startHarness();
  A = await createTenant(h, { slug: "tenant-a", displayName: "Tenant A" });
  B = await createTenant(h, { slug: "tenant-b", displayName: "Tenant B" });

  // Build a fully populated project inside tenant B, using B's own session.
  const importRes = await h
    .as(B.staff.owner!.token)
    .post("/api/v1/projects/estimate-imports")
    .send(estimatePayload());
  expect(importRes.status).toBe(201);

  const projectRes = await h
    .as(B.staff.owner!.token)
    .post("/api/v1/projects/projects")
    .send(
      projectBody({
        project_number: "TENANT-B-0001",
        estimate_import_id: importRes.body.data.id,
        source_kind: "journeyman_estimate",
        pm_id: B.staff.pm!.id,
      }),
    );
  expect(projectRes.status).toBe(201);

  const projectId = projectRes.body.data.id as string;
  const b = h.as(B.staff.owner!.token);

  const precon = await b.get(`/api/v1/projects/projects/${projectId}/precon-tasks`);
  expect(precon.status, JSON.stringify(precon.body)).toBe(200);
  const permitTask = (precon.body.data as Array<{ id: string; type: string }>).find(
    (task) => task.type === "permit",
  );
  expect(permitTask).toBeTruthy();
  const inspection = await b
    .post(`/api/v1/projects/precon-tasks/${permitTask!.id}/inspections`)
    .send({ notes: "Rough-in" });
  expect(inspection.status, JSON.stringify(inspection.body)).toBe(201);

  // A vendor with every required document, so it can hold a purchase order.
  const vendorRes = await b.post("/api/v1/projects/vendors").send({
    legal_name: "Tenant B Tile Co",
    email: "tile@tenant-b.test",
    trades: ["tile"],
  });
  expect(vendorRes.status).toBe(201);
  const vendorId = vendorRes.body.data.id as string;

  const kinds = await b.get("/api/v1/projects/compliance-requirements");
  let documentId = "";
  let agreementId = "";
  for (const req of kinds.body.data as Array<{
    kind: string;
    required: boolean;
  }>) {
    if (!req.required) continue;
    const doc = await b
      .post(`/api/v1/projects/vendors/${vendorId}/documents`)
      .send({
        kind: req.kind,
        expires_on: "2027-12-31",
        file_key: `k/${req.kind}`,
      });
    expect(doc.status).toBe(201);
    documentId ||= doc.body.data.id;
    if (req.kind === "master_agreement") agreementId = doc.body.data.id;
  }
  expect(
    (await b.post(`/api/v1/projects/vendors/${vendorId}/activate`)).status,
  ).toBe(200);

  const budget = await b.get(`/api/v1/projects/projects/${projectId}/budget`);
  const budgetLineId = budget.body.data.lines[0].id as string;
  const costCodeId = budget.body.data.lines[0].cost_code_id as string;

  const poRes = await b
    .post(`/api/v1/projects/projects/${projectId}/purchase-orders`)
    .send({
      po_number: "B-PO-0001",
      vendor_id: vendorId,
      cost_code_id: costCodeId,
      cost_type: "S",
      amount: 5200,
      scope_text: "Set tile to primary bath",
      issue: true,
      agreement_document_id: agreementId,
      agreement_signed_at: "2026-10-01T00:00:00.000Z",
    });
  expect(poRes.status, JSON.stringify(poRes.body)).toBe(201);
  const poLines = await b.get(
    `/api/v1/projects/purchase-orders/${poRes.body.data.id}/lines`,
  );
  expect(poLines.status).toBe(200);

  const billRes = await b
    .post(`/api/v1/projects/purchase-orders/${poRes.body.data.id}/bills`)
    .send({ vendor_invoice_number: "B-INV-1", amount: 5200 });
  expect(billRes.status).toBe(201);

  // A draw, a permit with milestones, and a scheduled window — all inside
  // tenant B, so tenant A has something real to try to reach.
  const drawRes = await b
    .post(`/api/v1/projects/projects/${projectId}/draws`)
    .send({
      draws: [
        {
          label: "Deposit",
          trigger_milestone: "Contract signature",
          amount: 10450,
        },
        { label: "Final", trigger_milestone: "Punch complete", amount: 8360 },
      ],
    });
  expect(drawRes.status, JSON.stringify(drawRes.body)).toBe(201);

  const jurisdictionRes = await b
    .post("/api/v1/projects/jurisdictions")
    .send({ name: "Tenant B County", typical_review_days: 10 });
  expect(jurisdictionRes.status).toBe(201);

  const permitRes = await b
    .post(`/api/v1/projects/projects/${projectId}/permits`)
    .send({
      jurisdiction_id: jurisdictionRes.body.data.id,
      permit_type: "Building",
      applied_on: "2026-07-01",
    });
  expect(permitRes.status, JSON.stringify(permitRes.body)).toBe(201);

  const permits = await b.get(`/api/v1/projects/projects/${projectId}/permits`);
  const milestoneId = permits.body.data[0].milestones[0].id as string;

  const scheduleRes = await b
    .post(`/api/v1/projects/projects/${projectId}/schedule`)
    .send({
      title: "Tile setting",
      window_start: "2026-08-10",
      window_end: "2026-08-12",
    });
  expect(scheduleRes.status).toBe(201);

  const coRes = await b
    .post(`/api/v1/projects/projects/${projectId}/change-orders`)
    .send({
      description: "Tenant B's change order",
      customer_amount: 2400,
      lines: [{ cost_code_id: costCodeId, cost_type: "S", amount: 1500 }],
    });
  expect(coRes.status, JSON.stringify(coRes.body)).toBe(201);

  const invRes = await b.post("/api/v1/projects/external-invoices").send({
    external_invoice_number: "TENANT-B-INV-1",
    amount: 500,
    project_id: projectId,
  });
  expect(invRes.status, JSON.stringify(invRes.body)).toBe(201);

  // A billed draw, so tenant A has a project invoice to try to reach.
  await b.post(`/api/v1/projects/draws/${drawRes.body.data[0].id}/earn`);
  await b.post(`/api/v1/projects/draws/${drawRes.body.data[0].id}/approve`);
  const piRes = await b
    .post(`/api/v1/projects/draws/${drawRes.body.data[0].id}/invoice`)
    .send({});
  expect(piRes.status, JSON.stringify(piRes.body)).toBe(201);

  const bid = (
    await b
      .post("/api/v1/projects/bid-requests")
      .send({
        project_id: projectId,
        subject: "Bid",
        scope: "Scope",
        vendor_ids: [vendorId],
      })
  ).body.data;
  const recipient = (await b.get("/api/v1/projects/bid-requests/" + bid.id))
    .body.data.recipients[0];
  foreign = {
    bidId: bid.id,
    recipientId: recipient.id,
    tenantId: B.id,
    projectId,
    changeOrderId: coRes.body.data.id,
    externalInvoiceId: invRes.body.data.id,
    projectInvoiceId: piRes.body.data.id,
    preconTaskId: permitTask!.id,
    inspectionId: inspection.body.data.id,
    estimateImportId: importRes.body.data.id,
    drawId: drawRes.body.data[0].id,
    jurisdictionId: jurisdictionRes.body.data.id,
    permitId: permitRes.body.data.id,
    milestoneId,
    scheduleItemId: scheduleRes.body.data.id,
    staffId: B.staff.pm!.id,
    businessUnitId: Object.values(B.businessUnits)[0]!,
    budgetLineId,
    costCodeId,
    vendorId,
    documentId,
    poId: poRes.body.data.id,
    poLineId: poLines.body.data[0].id,
    billId: billRes.body.data.id,
  };
});

afterAll(async () => {
  await h?.close();
});

type Method = "get" | "post" | "put" | "patch" | "delete";

interface RouteCase {
  method: Method;
  /** The Express route template, matched against the live router below. */
  template: string;
  /** The same path with tenant B's identifiers substituted. */
  path: (f: ForeignIds) => string;
  body?: (f: ForeignIds) => unknown;
}

const BASE = "/api/v1/projects";

const ROUTES: RouteCase[] = [
  {method:"delete",template:BASE+"/projects/:id",path:f=>BASE+"/projects/"+f.projectId,body:()=>({confirm_project_number:"TENANT-B-0001"})},
 {method:'get',template:BASE+'/vendors/:id/quickbooks',path:f=>BASE+'/vendors/'+f.vendorId+'/quickbooks'},
 {method:'post',template:BASE+'/vendors/:id/quickbooks-sync',path:f=>BASE+'/vendors/'+f.vendorId+'/quickbooks-sync',body:()=>({qbo_id:'301',confirmed:true})},
 {method:"delete",template:BASE+"/projects/:id/controls/:recordId",path:f=>BASE+"/projects/"+f.projectId+"/controls/"+f.documentId,body:()=>({version:1})},
  {method:"post",template:BASE+"/vendors/:id/accounting-tax",path:f=>BASE+"/vendors/"+f.vendorId+"/accounting-tax",body:()=>({})},
  {method:"get",template:BASE+"/projects/:id/vendor-bills",path:f=>BASE+"/projects/:id/vendor-bills".replace(":id",f.projectId),body:()=>({})},
  {method:"patch",template:BASE+"/projects/:id/accounting",path:f=>BASE+"/projects/:id/accounting".replace(":id",f.projectId),body:()=>({})},
  {method:"post",template:BASE+"/vendors/:id/accounting-review",path:f=>BASE+"/vendors/:id/accounting-review".replace(":id",f.vendorId),body:()=>({})},
  {method:"post",template:BASE+"/vendors/:id/accounting-sync",path:f=>BASE+"/vendors/:id/accounting-sync".replace(":id",f.vendorId),body:()=>({})},
  {method:"post",template:BASE+"/bills/:id/accounting-sync",path:f=>BASE+"/bills/:id/accounting-sync".replace(":id",f.billId),body:()=>({})},

 {method:'get',template:BASE+'/projects/:id/controls',path:f=>BASE+'/projects/'+f.projectId+'/controls'},
 {method:'post',template:BASE+'/projects/:id/controls',path:f=>BASE+'/projects/'+f.projectId+'/controls'},
 {method:'patch',template:BASE+'/projects/:id/controls/:recordId',path:f=>BASE+'/projects/'+f.projectId+'/controls/'+f.documentId},
 {method:'post',template:BASE+'/projects/:id/controls/baseline',path:f=>BASE+'/projects/'+f.projectId+'/controls/baseline'},
 {method:'post',template:BASE+'/projects/:id/controls/:recordId/deliver',path:f=>BASE+'/projects/'+f.projectId+'/controls/'+f.documentId+'/deliver'},
 {method:'post',template:BASE+'/projects/:id/controls/:recordId/file',path:f=>BASE+'/projects/'+f.projectId+'/controls/'+f.documentId+'/file'},
 {method:'patch',template:BASE+'/resources/:id',path:f=>BASE+'/resources/'+f.projectId,body:()=>({active:false})},
 {method:'get',template:BASE+'/projects/:id/controls/:recordId/file',path:f=>BASE+'/projects/'+f.projectId+'/controls/'+f.documentId+'/file'},
 {method:'get',template:BASE+'/projects/:id/controls/:recordId/preview',path:f=>BASE+'/projects/'+f.projectId+'/controls/'+f.documentId+'/preview'},
 {method:'get',template:BASE+'/projects/:id/controls/:recordId/pdf',path:f=>BASE+'/projects/'+f.projectId+'/controls/'+f.documentId+'/pdf'},
 {method:'get',template:BASE+'/projects/:id/controls/:recordId/publications',path:f=>BASE+'/projects/'+f.projectId+'/controls/'+f.documentId+'/publications'},
 {method:'get',template:BASE+'/projects/:id/controls/:recordId/publish-targets',path:f=>BASE+'/projects/'+f.projectId+'/controls/'+f.documentId+'/publish-targets'},
 {method:'post',template:BASE+'/projects/:id/controls/:recordId/publish',path:f=>BASE+'/projects/'+f.projectId+'/controls/'+f.documentId+'/publish'},
 {method:'post',template:BASE+'/projects/:id/controls/:recordId/sync-link',path:f=>BASE+'/projects/'+f.projectId+'/controls/'+f.documentId+'/sync-link'},
 {method:'post',template:BASE+'/projects/:id/controls/:recordId/publications/:publicationId/check',path:f=>BASE+'/projects/'+f.projectId+'/controls/'+f.documentId+'/publications/00000000-0000-4000-8000-000000000001/check'},
 {method:'get',template:BASE+'/projects/:id/controls/:recordId/history',path:f=>BASE+'/projects/'+f.projectId+'/controls/'+f.documentId+'/history'},
 {method:'post',template:BASE+'/users/:id/setup-link',path:f=>BASE+'/users/'+f.staffId+'/setup-link'},
 {method:'patch',template:BASE+'/users/:id',path:f=>BASE+'/users/'+f.staffId,body:()=>({full_name:'Foreign user',phone:'',role:'office',active:true,business_unit_id:null})},
 {method:'get',template:BASE+'/projects/:id/servicetitan/schedule',path:f=>BASE+'/projects/'+f.projectId+'/servicetitan/schedule?from=2026-09-16&to=2026-09-29'},
 {method:'get',template:BASE+'/projects/:id/servicetitan',path:f=>BASE+'/projects/'+f.projectId+'/servicetitan'},
 {method:'post',template:BASE+'/projects/:id/servicetitan',path:f=>BASE+'/projects/'+f.projectId+'/servicetitan',body:()=>({external_project_id:'200'})},
  {
    method: "post",
    template: BASE + "/vendors/:id/documents/upload",
    path: (f) =>
      BASE + "/vendors/:id/documents/upload".replace(":id", f.vendorId),
    body: () => ({}),
  },
  {
    method: "patch",
    template: BASE + "/vendors/:id/documents/:docId/coverage",
    path: (f) => BASE + "/vendors/" + f.vendorId + "/documents/" + f.documentId + "/coverage",
    body: () => ({coverage_kinds:["gl_insurance","wc_insurance"]}),
  },
  {
    method: "get",
    template: BASE + "/vendors/:id/documents/:docId/file",
    path: (f) =>
      BASE +
      "/vendors/:id/documents/:docId/file"
        .replace(":id", f.vendorId)
        .replace(":docId", f.documentId),
    body: () => ({}),
  },
  {
    method: "get",
    template: BASE + "/vendors/:id/work",
    path: (f) => BASE + "/vendors/:id/work".replace(":id", f.vendorId),
    body: () => ({}),
  },
  {
    method: "get",
    template: BASE + "/bid-requests/:id",
    path: (f) => BASE + "/bid-requests/:id".replace(":id", f.bidId),
    body: () => ({}),
  },
  {
    method: "patch",
    template: BASE + "/bid-requests/:id/recipients/:recipientId",
    path: (f) =>
      BASE +
      "/bid-requests/:id/recipients/:recipientId"
        .replace(":id", f.bidId)
        .replace(":recipientId", f.recipientId),
    body: () => ({}),
  },
  {
    method: "post",
    template: BASE + "/bid-requests/:id/close",
    path: (f) => BASE + "/bid-requests/:id/close".replace(":id", f.bidId),
    body: () => ({}),
  },
  {
    method: "post",
    template: BASE + "/bid-requests/:id/email-drafts",
    path: (f) =>
      BASE + "/bid-requests/:id/email-drafts".replace(":id", f.bidId),
    body: () => ({}),
  },
  {
    method: "post",
    template: BASE + "/bid-requests/:id/recipients/:recipientId/mark-sent",
    path: (f) =>
      BASE +
      "/bid-requests/:id/recipients/:recipientId/mark-sent"
        .replace(":id", f.bidId)
        .replace(":recipientId", f.recipientId),
    body: () => ({}),
  },
  {
    method: "post",
    template: BASE + "/bid-requests/:id/send",
    path: (f) => BASE + "/bid-requests/:id/send".replace(":id", f.bidId),
    body: () => ({}),
  },
  {
    method: "get",
    template: BASE + "/bid-requests/:id/lines",
    path: (f) => BASE + "/bid-requests/" + f.bidId + "/lines",
  },
  {
    method: "put",
    template: BASE + "/bid-requests/:id/lines",
    path: (f) => BASE + "/bid-requests/" + f.bidId + "/lines",
    body: () => ({ lines: [] }),
  },
  {
    method: "put",
    template: BASE + "/bid-requests/:id/recipients/:recipientId/quote-lines",
    path: (f) =>
      BASE +
      "/bid-requests/" +
      f.bidId +
      "/recipients/" +
      f.recipientId +
      "/quote-lines",
    body: () => ({ lines: [] }),
  },
  {
    method: "get",
    template: BASE + "/bid-requests/:id/leveling",
    path: (f) => BASE + "/bid-requests/" + f.bidId + "/leveling",
  },
  {
    method: "post",
    template: BASE + "/bid-requests/:id/recipients/:recipientId/award",
    path: (f) =>
      BASE +
      "/bid-requests/" +
      f.bidId +
      "/recipients/" +
      f.recipientId +
      "/award",
    body: () => ({ po_number: "FOREIGN" }),
  },
  {
    method: "get",
    template: "/api/v1/bid-response/:tenantId/:recipientId",
    path: (f) => "/api/v1/bid-response/" + f.tenantId + "/" + f.recipientId,
    body: () => ({}),
  },
  {
    method: "post",
    template: "/api/v1/bid-response/:tenantId/:recipientId",
    path: (f) => "/api/v1/bid-response/" + f.tenantId + "/" + f.recipientId,
    body: () => ({}),
  },
  {
    method: "post",
    template: BASE + "/projects/:id/schedule-proposal",
    path: (f) => BASE + "/projects/" + f.projectId + "/schedule-proposal",
    body: () => ({}),
  },
  {
    method: "post",
    template: BASE + "/projects/:id/jobs/:jobId/dispatch/publish",
    path: (f) =>
      BASE +
      "/projects/" +
      f.projectId +
      "/jobs/" +
      f.projectId +
      "/dispatch/publish",
    body: () => ({}),
  },
  {
    method: "get",
    template: BASE + "/projects/:id/jobs/:jobId/dispatch",
    path: (f) =>
      BASE + "/projects/" + f.projectId + "/jobs/" + f.projectId + "/dispatch",
  },
  {
    method: "post",
    template: BASE + "/projects/:id/jobs/:jobId/dispatch/refresh",
    path: (f) =>
      BASE +
      "/projects/" +
      f.projectId +
      "/jobs/" +
      f.projectId +
      "/dispatch/refresh",
    body: () => ({}),
  },
  {
    method: "get",
    template: BASE + "/projects/:id/jobs",
    path: (f) => BASE + "/projects/" + f.projectId + "/jobs",
  },
  {
    method: "post",
    template: BASE + "/projects/:id/jobs",
    path: (f) => BASE + "/projects/" + f.projectId + "/jobs",
    body: () => ({}),
  },
  {
    method: "delete",
    template: BASE + "/projects/:id/jobs/:jobId",
    path: (f) => BASE + "/projects/" + f.projectId + "/jobs/" + f.projectId,
  },
  {
    method: "get",
    template: `${BASE}/projects/:id`,
    path: (f) => `${BASE}/projects/${f.projectId}`,
  },
  {
    method: "get",
    template: `${BASE}/projects/:id/cost-position`,
    path: (f) => `${BASE}/projects/${f.projectId}/cost-position`,
  },
  {
    method: "get",
    template: `${BASE}/projects/:id/margin`,
    path: (f) => `${BASE}/projects/${f.projectId}/margin`,
  },
  {
    method: "get",
    template: `${BASE}/projects/:id/gates`,
    path: (f) => `${BASE}/projects/${f.projectId}/gates`,
  },
  {
    method: "get",
    template: `${BASE}/estimate-imports/:id`,
    path: (f) => `${BASE}/estimate-imports/${f.estimateImportId}`,
  },
  {
    method: "patch",
    template: `${BASE}/projects/:id`,
    path: (f) => `${BASE}/projects/${f.projectId}`,
    body: () => ({ name: "Renamed by another tenant" }),
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/stage`,
    path: (f) => `${BASE}/projects/${f.projectId}/stage`,
    body: () => ({ stage: "precon" }),
  },
  {
    method: "patch",
    template: `${BASE}/projects/:id/gates/:n/checklist`,
    path: (f) => `${BASE}/projects/${f.projectId}/gates/0/checklist`,
    body: () => ({ key: "item_1", done: true }),
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/gates/:n/approve`,
    path: (f) => `${BASE}/projects/${f.projectId}/gates/0/approve`,
    body: () => ({}),
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/gates/:n/reject`,
    path: (f) => `${BASE}/projects/${f.projectId}/gates/0/reject`,
    body: () => ({ note: "no" }),
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/field-release`,
    path: (f) => `${BASE}/projects/${f.projectId}/field-release`,
    body: () => ({ note: "not this tenant" }),
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/field-release/undo`,
    path: (f) => `${BASE}/projects/${f.projectId}/field-release/undo`,
    body: () => ({ note: "not this tenant" }),
  },

  // --- phase 2: budget ----------------------------------------------------
  {
    method: "get",
    template: `${BASE}/projects/:id/budget`,
    path: (f) => `${BASE}/projects/${f.projectId}/budget`,
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/budget`,
    path: (f) => `${BASE}/projects/${f.projectId}/budget`,
    body: (f) => ({
      cost_code_id: f.costCodeId,
      cost_type: "S",
      budget_amount: 100,
    }),
  },
  {
    method: "patch",
    template: `${BASE}/projects/:id/budget/:lineId`,
    path: (f) => `${BASE}/projects/${f.projectId}/budget/${f.budgetLineId}`,
    body: () => ({ budget_amount: 1 }),
  },
  {
    method: "get",
    template: `${BASE}/projects/:id/exceptions`,
    path: (f) => `${BASE}/projects/${f.projectId}/exceptions`,
  },
  {
    method: "get",
    template: `${BASE}/projects/:id/export/cost`,
    path: (f) => `${BASE}/projects/${f.projectId}/export/cost`,
  },

  // --- phase 2: purchase orders and bills ---------------------------------
  {
    method: "get",
    template: `${BASE}/projects/:id/purchase-orders`,
    path: (f) => `${BASE}/projects/${f.projectId}/purchase-orders`,
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/purchase-orders`,
    path: (f) => `${BASE}/projects/${f.projectId}/purchase-orders`,
    body: (f) => ({
      po_number: "A-STEALS-PO",
      supplier_name: "Counter purchase",
      cost_code_id: f.costCodeId,
      cost_type: "M",
      amount: 10,
      scope_text: "x",
    }),
  },
  {
    method: "patch",
    template: `${BASE}/purchase-orders/:id`,
    path: (f) => `${BASE}/purchase-orders/${f.poId}`,
    body: () => ({ amount: 1 }),
  },
  {
    method: "get",
    template: `${BASE}/purchase-orders/:id/bills`,
    path: (f) => `${BASE}/purchase-orders/${f.poId}/bills`,
  },
  {
    method: "post",
    template: `${BASE}/purchase-orders/:id/bills`,
    path: (f) => `${BASE}/purchase-orders/${f.poId}/bills`,
    body: () => ({ vendor_invoice_number: "A-STEALS-INV", amount: 1 }),
  },
  {
    method: "post",
    template: `${BASE}/bills/:id/approve`,
    path: (f) => `${BASE}/bills/${f.billId}/approve`,
    body: () => ({}),
  },
  {
    method: "post",
    template: `${BASE}/bills/:id/reject`,
    path: (f) => `${BASE}/bills/${f.billId}/reject`,
    body: () => ({}),
  },
  {
    method: "get",
    template: `${BASE}/purchase-orders/:id/lines`,
    path: (f) => `${BASE}/purchase-orders/${f.poId}/lines`,
  },
  {
    method: "post",
    template: `${BASE}/purchase-orders/:id/lines`,
    path: (f) => `${BASE}/purchase-orders/${f.poId}/lines`,
    body: (f) => ({
      cost_code_id: f.costCodeId,
      cost_type: "S",
      original_amount: 10,
    }),
  },
  {
    method: "patch",
    template: `${BASE}/po-lines/:lineId`,
    path: (f) => `${BASE}/po-lines/${f.poLineId}`,
    body: () => ({ original_amount: 1 }),
  },
  {
    method: "delete",
    template: `${BASE}/po-lines/:lineId`,
    path: (f) => `${BASE}/po-lines/${f.poLineId}`,
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/material-bills`,
    path: (f) => `${BASE}/projects/${f.projectId}/material-bills`,
    body: (f) => ({
      supplier_name: "Foreign supplier",
      cost_code_id: f.costCodeId,
      amount: 10,
      order_number: "ORD-FOREIGN",
    }),
  },
  {
    method: "get",
    template: `${BASE}/purchase-orders/:id/qbo-candidates`,
    path: (f) => `${BASE}/purchase-orders/${f.poId}/qbo-candidates`,
  },
  {
    method: "post",
    template: `${BASE}/bills/:id/link-qbo`,
    path: (f) => `${BASE}/bills/${f.billId}/link-qbo`,
    body: () => ({ qbo_txn_type: "Purchase", qbo_id: "9001" }),
  },

  // --- phase 3: vendors and compliance ------------------------------------
  {
    method: "get",
    template: `${BASE}/vendors/:id`,
    path: (f) => `${BASE}/vendors/${f.vendorId}`,
  },
  {
    method: "patch",
    template: `${BASE}/vendors/:id`,
    path: (f) => `${BASE}/vendors/${f.vendorId}`,
    body: () => ({ legal_name: "Renamed by another tenant" }),
  },
  {
    method: "post",
    template: `${BASE}/vendors/:id/documents`,
    path: (f) => `${BASE}/vendors/${f.vendorId}/documents`,
    body: () => ({
      kind: "license",
      expires_on: "2028-01-01",
      file_key: "k/x",
    }),
  },
  {
    method: "patch",
    template: `${BASE}/vendors/:id/documents/:docId`,
    path: (f) => `${BASE}/vendors/${f.vendorId}/documents/${f.documentId}`,
    body: () => ({ verify_method: "called the carrier" }),
  },
  {
    method: "post",
    template: `${BASE}/vendors/:id/activate`,
    path: (f) => `${BASE}/vendors/${f.vendorId}/activate`,
    body: () => ({}),
  },
  {
    method: "post",
    template: `${BASE}/vendors/:id/deactivate`,
    path: (f) => `${BASE}/vendors/${f.vendorId}/deactivate`,
    body: () => ({}),
  },
  {
    method: "post",
    template: `${BASE}/vendors/:id/scores`,
    path: (f) => `${BASE}/vendors/${f.vendorId}/scores`,
    body: (f) => ({ project_id: f.projectId, quality_score: 1 }),
  },

  // --- external invoices --------------------------------------------------
  {
    method: "get",
    template: `${BASE}/projects/:id/external-invoices`,
    path: (f) => `${BASE}/projects/${f.projectId}/external-invoices`,
  },
  {
    method: "post",
    template: `${BASE}/external-invoices/:id/apply`,
    path: (f) => `${BASE}/external-invoices/${f.externalInvoiceId}/apply`,
    body: (f) => ({ draw_id: f.drawId }),
  },

  // --- project invoices ---------------------------------------------------
  {
    method: "get",
    template: `${BASE}/projects/:id/invoices`,
    path: (f) => `${BASE}/projects/${f.projectId}/invoices`,
  },
  {
    method: "post",
    template: `${BASE}/draws/:id/invoice`,
    path: (f) => `${BASE}/draws/${f.drawId}/invoice`,
    body: () => ({}),
  },
  {
    method: "post",
    template: `${BASE}/change-orders/:id/invoice`,
    path: (f) => `${BASE}/change-orders/${f.changeOrderId}/invoice`,
    body: () => ({}),
  },
  {
    method: "get",
    template: `${BASE}/invoices/:id`,
    path: (f) => `${BASE}/invoices/${f.projectInvoiceId}`,
  },
  {
    method: "post",
    template: `${BASE}/invoices/:id/send`,
    path: (f) => `${BASE}/invoices/${f.projectInvoiceId}/send`,
    body: () => ({}),
  },
  {
    method: "post",
    template: `${BASE}/invoices/:id/external-ref`,
    path: (f) => `${BASE}/invoices/${f.projectInvoiceId}/external-ref`,
    body: () => ({ external_ref: "STOLEN-1" }),
  },
  {
    method: "post",
    template: `${BASE}/invoices/:id/void`,
    path: (f) => `${BASE}/invoices/${f.projectInvoiceId}/void`,
    body: () => ({}),
  },

  // --- statement ----------------------------------------------------------
  {
    method: "get",
    template: `${BASE}/projects/:id/statement`,
    path: (f) => `${BASE}/projects/${f.projectId}/statement`,
  },
  {
    method: "get",
    template: `${BASE}/projects/:id/export/statement`,
    path: (f) => `${BASE}/projects/${f.projectId}/export/statement`,
  },

  // --- phase 5: change orders ---------------------------------------------
  {
    method: "get",
    template: `${BASE}/projects/:id/change-orders`,
    path: (f) => `${BASE}/projects/${f.projectId}/change-orders`,
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/change-orders`,
    path: (f) => `${BASE}/projects/${f.projectId}/change-orders`,
    body: () => ({
      description: "Raised into another tenant",
      customer_amount: 100,
    }),
  },
  {
    method: "patch",
    template: `${BASE}/change-orders/:id`,
    path: (f) => `${BASE}/change-orders/${f.changeOrderId}`,
    body: () => ({ customer_amount: 1 }),
  },
  {
    method: "post",
    template: `${BASE}/change-orders/:id/send`,
    path: (f) => `${BASE}/change-orders/${f.changeOrderId}/send`,
    body: () => ({}),
  },
  {
    method: "post",
    template: `${BASE}/change-orders/:id/approve`,
    path: (f) => `${BASE}/change-orders/${f.changeOrderId}/approve`,
    body: () => ({}),
  },
  {
    method: "post",
    template: `${BASE}/change-orders/:id/reject`,
    path: (f) => `${BASE}/change-orders/${f.changeOrderId}/reject`,
    body: () => ({}),
  },

  // --- phase 4: draws -----------------------------------------------------
  {
    method: "get",
    template: `${BASE}/projects/:id/draws`,
    path: (f) => `${BASE}/projects/${f.projectId}/draws`,
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/draws`,
    path: (f) => `${BASE}/projects/${f.projectId}/draws`,
    body: () => ({
      draws: [
        { label: "Deposit", trigger_milestone: "Signature", amount: 100 },
      ],
    }),
  },
  {
    method: "post",
    template: `${BASE}/draws/:id/earn`,
    path: (f) => `${BASE}/draws/${f.drawId}/earn`,
    body: () => ({}),
  },
  {
    method: "post",
    template: `${BASE}/draws/:id/approve`,
    path: (f) => `${BASE}/draws/${f.drawId}/approve`,
    body: () => ({}),
  },
  {
    method: "post",
    template: `${BASE}/draws/:id/external-invoice`,
    path: (f) => `${BASE}/draws/${f.drawId}/external-invoice`,
    body: () => ({ external_invoice_number: "A-STEALS-INVOICE" }),
  },
  {
    method: "patch",
    template: `${BASE}/draws/:id/external-invoice`,
    path: (f) => `${BASE}/draws/${f.drawId}/external-invoice`,
    body: () => ({ external_invoice_number: "A-STEALS-INVOICE" }),
  },
  {
    method: "post",
    template: `${BASE}/draws/:id/verify`,
    path: (f) => `${BASE}/draws/${f.drawId}/verify`,
    body: () => ({}),
  },

  // --- phase 5: permits, schedule, daily logs -----------------------------
  {
    method: "get",
    template: `${BASE}/projects/:id/permits`,
    path: (f) => `${BASE}/projects/${f.projectId}/permits`,
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/permits`,
    path: (f) => `${BASE}/projects/${f.projectId}/permits`,
    body: (f) => ({
      jurisdiction_id: f.jurisdictionId,
      permit_type: "Building",
    }),
  },
  {
    method: "patch",
    template: `${BASE}/permits/:id`,
    path: (f) => `${BASE}/permits/${f.permitId}`,
    body: () => ({ permit_number: "STOLEN-1" }),
  },
  {
    method: "patch",
    template: `${BASE}/permit-milestones/:id`,
    path: (f) => `${BASE}/permit-milestones/${f.milestoneId}`,
    body: () => ({ status: "complete" }),
  },
  {
    method: "get",
    template: `${BASE}/projects/:id/schedule`,
    path: (f) => `${BASE}/projects/${f.projectId}/schedule`,
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/schedule`,
    path: (f) => `${BASE}/projects/${f.projectId}/schedule`,
    body: () => ({
      title: "Stolen slot",
      window_start: "2026-09-01",
      window_end: "2026-09-02",
    }),
  },
  {
    method: "patch",
    template: `${BASE}/schedule/:id`,
    path: (f) => `${BASE}/schedule/${f.scheduleItemId}`,
    body: () => ({ status: "cancelled" }),
  },
  {
    method: "get",
    template: `${BASE}/projects/:id/daily-logs`,
    path: (f) => `${BASE}/projects/${f.projectId}/daily-logs`,
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/daily-logs`,
    path: (f) => `${BASE}/projects/${f.projectId}/daily-logs`,
    body: () => ({
      log_date: "2026-09-01",
      work_completed: "Written into another tenant",
    }),
  },
  {
    method: "get",
    template: `${BASE}/projects/:id/precon-tasks`,
    path: (f) => `${BASE}/projects/${f.projectId}/precon-tasks`,
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/precon-tasks`,
    path: (f) => `${BASE}/projects/${f.projectId}/precon-tasks`,
    body: () => ({ type: "other", title: "Foreign task", owner_role: "owner" }),
  },
  {
    method: "post",
    template: `${BASE}/projects/:id/precon-tasks/apply-template`,
    path: (f) => `${BASE}/projects/${f.projectId}/precon-tasks/apply-template`,
    body: () => ({}),
  },
  {
    method: "patch",
    template: `${BASE}/precon-tasks/:id`,
    path: (f) => `${BASE}/precon-tasks/${f.preconTaskId}`,
    body: () => ({ status: "done" }),
  },
  {
    method: "post",
    template: `${BASE}/precon-tasks/:id/inspections`,
    path: (f) => `${BASE}/precon-tasks/${f.preconTaskId}/inspections`,
    body: () => ({ result: "passed" }),
  },
  {
    method: "patch",
    template: `${BASE}/precon-inspections/:id`,
    path: (f) => `${BASE}/precon-inspections/${f.inspectionId}`,
    body: () => ({ result: "cancelled" }),
  },
  {
    method: "delete",
    template: `${BASE}/precon-inspections/:id`,
    path: (f) => `${BASE}/precon-inspections/${f.inspectionId}`,
  },
];

/**
 * Routes whose path parameter is not an identifier, so "substitute another
 * tenant's value" has no meaning. Each needs its own test instead, and naming
 * one here is a claim that the test exists.
 *
 * The exemption list is deliberately awkward to add to. A route that reaches
 * for it and is actually identifier-shaped will read wrong in review.
 */
const NOT_AN_IDENTIFIER: Array<{
  signature: string;
  why: string;
  coveredBy: string;
}> = [
  {
    signature: `PATCH ${BASE}/compliance-requirements/:kind`,
    why: ":kind is a doc_kind enum value, shared vocabulary across all tenants",
    coveredBy: "compliance requirements are per tenant",
  },
];

describe("cross-tenant isolation", () => {
  it.each(
    ROUTES.map((r) => [`${r.method.toUpperCase()} ${r.template}`, r] as const),
  )("%s with another tenant's ids returns 404", async (_label, route) => {
    const req = h.as(A.staff.owner!.token);
    const path = route.path(foreign);
    const res =
      route.method === "get"
        ? await req.get(path)
        : route.method === "post"
          ? await req.post(path).send(route.body?.(foreign) ?? {})
          : route.method === "put"
            ? await req.put(path).send(route.body?.(foreign) ?? {})
          : route.method === "delete"
            ? await req.del(path)
            : await req.patch(path).send(route.body?.(foreign) ?? {});

    expect(
      res.status,
      `${route.method.toUpperCase()} ${path} returned ${res.status}: ` +
        JSON.stringify(res.body),
    ).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("a foreign id in a body field is rejected, not silently accepted", async () => {
    // The project would be created in tenant A but point at tenant B's import.
    // RLS makes the SELECT for that import return nothing, so this must be a
    // 404 on the import — never a project created with a dangling reference.
    const res = await h
      .as(A.staff.owner!.token)
      .post("/api/v1/projects/projects")
      .send(
        projectBody({
          project_number: "A-STEALS-B",
          estimate_import_id: foreign.estimateImportId,
          source_kind: "journeyman_estimate",
        }),
      );
    expect(res.status).toBe(404);

    const check = await h.db.withTenant(A.id, async (c) =>
      c.query(
        `SELECT 1 FROM projects.projects WHERE project_number = 'A-STEALS-B'`,
      ),
    );
    expect(check.rows).toHaveLength(0);
  });

  it("a foreign staff id as pm_id is a validation error, not an assignment", async () => {
    const res = await h
      .as(A.staff.owner!.token)
      .post("/api/v1/projects/projects")
      .send(
        projectBody({ project_number: "A-FOREIGN-PM", pm_id: foreign.staffId }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_failed");
  });

  it("a foreign business unit id cannot be attached to this tenant's project", async () => {
    // No FK crosses tenants, so the database would accept this. The API must
    // not: a project pointing at another tenant's unit is a cross-tenant read
    // waiting for someone to join through it.
    const res = await h
      .as(A.staff.owner!.token)
      .post("/api/v1/projects/projects")
      .send(
        projectBody({
          project_number: "A-FOREIGN-UNIT",
          business_unit_id: foreign.businessUnitId,
        }),
      );
    expect([400, 403, 404]).toContain(res.status);
    expect(res.status).not.toBe(201);
  });

  it("tenant A's list never contains tenant B's project", async () => {
    const res = await h
      .as(A.staff.owner!.token)
      .get("/api/v1/projects/projects?per_page=200");
    expect(res.status).toBe(200);
    const numbers = (res.body.data as Array<{ project_number: string }>).map(
      (p) => p.project_number,
    );
    expect(numbers).not.toContain("TENANT-B-0001");
  });

  it("the reference collections never leak across tenants", async () => {
    // These have no :id, so the parameterised-route coverage rule above does
    // not see them. They are still tenant-scoped reads and RLS is the only
    // thing filtering them — which is the point, but it has to be asserted.
    const a = h.as(A.staff.owner!.token);
    const b = h.as(B.staff.owner!.token);

    for (const path of ["/cost-codes", "/business-units", "/staff"]) {
      const mine = await a.get(`/api/v1/projects${path}`);
      const theirs = await b.get(`/api/v1/projects${path}`);
      expect(mine.status, path).toBe(200);
      expect(theirs.status, path).toBe(200);

      const mineIds = new Set(
        (mine.body.data as Array<{ id: string }>).map((r) => r.id),
      );
      const overlap = (theirs.body.data as Array<{ id: string }>).filter((r) =>
        mineIds.has(r.id),
      );
      expect(
        overlap,
        `${path} returned rows belonging to both tenants`,
      ).toEqual([]);
      expect(
        mineIds.size,
        `${path} returned nothing, so this proves nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it("a session for a staff member of another tenant does not resolve", async () => {
    // The token names tenant A but a staff row belonging to B. The tenant
    // transaction opens on A, RLS hides B's staff row, and the session fails
    // to resolve to an identity — 401, not a silently downgraded request.
    const token = h.sessions.issue({
      tenantId: A.id,
      staffId: B.staff.owner!.id,
    });
    const res = await h.as(token).get("/api/v1/projects/projects");
    expect(res.status).toBe(401);
  });

  it("no route answers 403 for a foreign row", async () => {
    // Stated separately from the per-route assertions because it is the rule,
    // and the rule is the thing that must not regress: 403 on another tenant's
    // identifier confirms the identifier is real.
    const req = h.as(A.staff.owner!.token);
    for (const route of ROUTES) {
      const path = route.path(foreign);
      const res =
        route.method === "get"
          ? await req.get(path)
          : route.method === "post"
            ? await req.post(path).send(route.body?.(foreign) ?? {})
            : route.method === "put"
              ? await req.put(path).send(route.body?.(foreign) ?? {})
            : route.method === "delete"
              ? await req.del(path)
              : await req.patch(path).send(route.body?.(foreign) ?? {});
      expect(res.status, `${route.method.toUpperCase()} ${path}`).not.toBe(403);
    }
  });
});

describe("route coverage", () => {
  it("every staff route with an :id parameter is covered above", () => {
    const declared = collectRoutes(h.app);
    const parameterised = declared.filter((r) => r.path.includes(":"));
    const covered = new Set([
      ...ROUTES.map((r) => `${r.method.toUpperCase()} ${r.template}`),
      ...NOT_AN_IDENTIFIER.map((e) => e.signature),
    ]);
    const missing = parameterised
      .map((r) => `${r.method} ${r.path}`)
      .filter((sig) => !covered.has(sig));
    expect(
      missing,
      "These routes take an identifier but are not exercised with a foreign one. " +
        "Add them to ROUTES in this file.",
    ).toEqual([]);
  });

  it("a tenant cannot change another tenant's compliance requirements", async () => {
    // The exemption above claims this is covered. This is the coverage.
    const before = await h
      .as(B.staff.owner!.token)
      .get("/api/v1/projects/compliance-requirements");
    const glBefore = (
      before.body.data as Array<{ kind: string; warn_days: number }>
    ).find((r) => r.kind === "gl_insurance");
    expect(glBefore!.warn_days).toBe(30);

    const patched = await h
      .as(A.staff.owner!.token)
      .patch("/api/v1/projects/compliance-requirements/gl_insurance")
      .send({ warn_days: 120 });
    expect(patched.status).toBe(200);

    const after = await h
      .as(B.staff.owner!.token)
      .get("/api/v1/projects/compliance-requirements");
    const glAfter = (
      after.body.data as Array<{ kind: string; warn_days: number }>
    ).find((r) => r.kind === "gl_insurance");
    expect(glAfter!.warn_days).toBe(30);
  });

  it("every ROUTES entry names a route that actually exists", () => {
    // The other direction. A template that matches nothing is a test that
    // passes because it is testing a 404 handler.
    const declared = new Set(
      collectRoutes(h.app).map((r) => `${r.method} ${r.path}`),
    );
    const stale = ROUTES.map(
      (r) => `${r.method.toUpperCase()} ${r.template}`,
    ).filter((sig) => !declared.has(sig));
    expect(
      stale,
      "These ROUTES entries no longer match a mounted route.",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

interface DeclaredRoute {
  method: string;
  path: string;
}

/** Walks the Express router tree so the coverage check reads the app, not a list. */
function collectRoutes(app: unknown): DeclaredRoute[] {
  const out: DeclaredRoute[] = [];
  const walk = (stack: unknown[], prefix: string) => {
    for (const layer of stack as Array<Record<string, any>>) {
      if (layer.route) {
        const path = prefix + layer.route.path;
        for (const [method, on] of Object.entries(
          layer.route.methods as Record<string, boolean>,
        )) {
          if (on && method !== "_all")
            out.push({ method: method.toUpperCase(), path });
        }
      } else if (layer.name === "router" && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + extractMountPath(layer));
      }
    }
  };
  walk(
    (
      (app as Record<string, any>)._router ??
      (app as Record<string, any>).router
    ).stack,
    "",
  );
  return out;
}

function extractMountPath(layer: Record<string, any>): string {
  // Express does not expose the mount path directly; it is recoverable from
  // the layer's regexp for the simple string mounts this app uses.
  const source: string = layer.regexp?.source ?? "";
  if (source === "^\\/?(?=\\/|$)") return "";
  const match = /^\^\\\/((?:[\w\-]|\\\/)*)\\\/\?/.exec(source);
  if (!match) return "";
  return "/" + match[1]!.replace(/\\\//g, "/");
}
