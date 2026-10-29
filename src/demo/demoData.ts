/**
 * The demo account, as data.
 *
 * Whitfield, Okonkwo, and Delaney are the reference projects, rebuilt as actual
 * rows in actual state: gates approved, budgets frozen by the freeze trigger,
 * POs issued, bills approved, a vendor whose general liability lapsed, a draw
 * approved but not invoiced, a permit milestone overdue.
 * Nguyen, Brooks, and Hale are CSR hand-off projects. Segreto's financials
 * come from one fixture object.
 *
 * Every exception the console shows is produced by the data rather than
 * asserted by a fixture. If the eligibility trigger stops working, this seed
 * fails rather than quietly producing a green screen.
 *
 * Two callers: scripts/seedDemo.ts against a real DATABASE_URL, and
 * scripts/devServer.ts against an in-process Postgres. It takes its privileged
 * runner as a parameter because the platform rows — tenants and entitlements —
 * are not writable by the application role, and how you get privilege differs
 * between the two.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database, SqlClient } from '../db/database.js';
import { activateModule, writePlatformRows } from '../db/activation.js';
import { storeProjectAr } from '../domain/arMatch.js';
import { GATE_CHECKLISTS } from '../domain/gateReadiness.js';
import { seedDrawSchedule } from './../domain/drawSchedule.js';
import { seedPreconTasks } from '../domain/preconTasks.js';
import { today } from '../domain/projectControls.js';
import {
  SEGRETO_DASHBOARD_FIXTURE,
  segretoDashboardInput,
  segretoInvoiceLines,
  segretoReadNotes,
} from './segretoDashboardFixture.js';
import {
  normalizeServiceTitanContact,
  pickServiceTitanContact,
  type ServiceTitanContactSource,
} from '../domain/stCustomerContacts.js';

/** The recorded CRM contacts response, mapped the same way a project read stores it. */
function nguyenServiceTitanContacts() {
  const file = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../test/fixtures/st-crm/customer-location-contacts.json',
  );
  const fixture = JSON.parse(readFileSync(file, 'utf8')) as {
    customer: { data: ServiceTitanContactSource[] };
    location: { data: ServiceTitanContactSource[] };
  };
  const customerContacts = fixture.customer.data.flatMap((row) => {
    const contact = normalizeServiceTitanContact(row);
    return contact ? [contact] : [];
  });
  const locationContacts = fixture.location.data.flatMap((row) => {
    const contact = normalizeServiceTitanContact(row);
    return contact ? [contact] : [];
  });
  return {
    customerContacts,
    locationContacts,
    picked: pickServiceTitanContact([...customerContacts, ...locationContacts]),
  };
}

export const DEMO_SLUG = 'demo';
export const DEMO_TENANT_ID = '5b1f0c9e-0000-4000-8000-000000000001';

/** The one pricebook service the fake ServiceTitan client returns. Not a setting. */
export const DEMO_ST_LABOR_SERVICE = {
  id: '91025',
  code: 'MHM.25PLFE',
  name: 'Project Labor From Estimate',
  active: true,
};

export interface SeedOptions {
  db: Database;
  /** Runs with rights the application role does not have. */
  privileged: <T>(fn: (c: SqlClient) => Promise<T>) => Promise<T>;
  log?: (message: string) => void;
}

export async function seedDemoTenant(opts: SeedOptions): Promise<void> {
  const { db, privileged } = opts;
  const log = opts.log ?? (() => {});
  const TENANT_ID = DEMO_TENANT_ID;

  // Fresh every run. Cascades through every tenant-scoped table.
  await privileged(async (c) => {
    await c.query(`DELETE FROM projects.tenants WHERE slug = $1 OR id = $2`, [
      DEMO_SLUG,
      TENANT_ID,
    ]);
    await writePlatformRows(c, {
      tenantId: TENANT_ID,
      slug: DEMO_SLUG,
      displayName: 'Demo Contracting',
      entitlements: [
        { moduleKey: 'estimating', state: 'active' },
        { moduleKey: 'projects', state: 'active' },
      ],
    });
  });

  const counts = await activateModule(db, TENANT_ID, 'Richmond');
  log(`activated: ${counts.costCodes} cost codes, ${counts.gates} gate templates`);

  // Checklists on the shipped gate templates. activate_tenant() seeds gates
  // with an empty checklist because their content is tenant configuration —
  // but a gate with nothing to tick makes the whole control look decorative,
  // and the checklist is what actually blocks approval.
  const CHECKLISTS: Record<number, Array<{ key: string; label: string }>> = {
    0: [
      { key: 'signed', label: 'Signed contract on file' },
      { key: 'deposit', label: 'Deposit received' },
      { key: 'scope', label: 'Scope of work agreed with the customer' },
    ],
    1: [...GATE_CHECKLISTS[1]!],
    2: [...GATE_CHECKLISTS[2]!],
    3: [
      { key: 'punch', label: 'Punch list walked with the customer' },
      { key: 'inspections', label: 'All inspections passed' },
    ],
    4: [...GATE_CHECKLISTS[4]!],
  };
  await db.withTenant(TENANT_ID, async (c) => {
    for (const [gate, items] of Object.entries(CHECKLISTS)) {
      await c.query(
        `UPDATE projects.gate_templates SET checklist = $3::jsonb
          WHERE tenant_id = $1 AND gate_number = $2`,
        [TENANT_ID, Number(gate), JSON.stringify(items)],
      );
    }
  });

  const ids = await db.withTenant(TENANT_ID, async (c) => {
    const staff: Record<string, string> = {};
    for (const [key, name, email, role] of [
      ['owner', 'M. Holloway', 'owner@demo.test', 'owner'],
      ['manager', 'A. Whitcomb', 'manager@demo.test', 'manager'],
      ['pm', 'D. Reyes', 'pm@demo.test', 'project_manager'],
      ['pm2', 'T. Vance', 'pm2@demo.test', 'project_manager'],
      ['office', 'J. Meade', 'office@demo.test', 'office'],
      ['bookkeeper', 'R. Alvarez', 'books@demo.test', 'bookkeeper'],
    ] as const) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO projects.staff (tenant_id, email, full_name, role, login_bootstrap)
         VALUES ($1,$2,$3,$4::projects.staff_role,true) RETURNING id`,
        [TENANT_ID, email, name, role],
      );
      staff[key] = rows[0]!.id;
    }

    const units = await c.query<{ id: string; name: string }>(
      `INSERT INTO projects.business_units (tenant_id, name) VALUES ($1,'Hampton-Newport News')
       ON CONFLICT DO NOTHING RETURNING id, name`,
      [TENANT_ID],
    );
    const richmond = await c.query<{ id: string }>(
      `SELECT id FROM projects.business_units WHERE tenant_id = $1 AND name = 'Richmond'`,
      [TENANT_ID],
    );

    const jurisdictions: Record<string, string> = {};
    for (const [name, days] of [
      ['City of Richmond', 12],
      ['City of Newport News', 15],
      ['Henrico County', 9],
    ] as const) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO projects.jurisdictions (tenant_id, name, state, typical_review_days)
         VALUES ($1,$2,'VA',$3) RETURNING id`,
        [TENANT_ID, name, days],
      );
      jurisdictions[name] = rows[0]!.id;
    }

    const costCodes = new Map<string, string>();
    await c.query(
      `INSERT INTO projects.cost_codes
         (tenant_id, code, division_code, division_name, description,
          default_cost_type, sort_order, active, external_source, external_id)
       VALUES ($1, 'MHM.25PLFE', 'ST', 'ServiceTitan', 'Project Labor From Estimate',
               'L'::projects.cost_type, 0, true, 'servicetitan_pricebook_service', '91025')
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [TENANT_ID],
    );
    const codeRows = await c.query<{ id: string; code: string }>(
      `SELECT id, code FROM projects.cost_codes WHERE tenant_id = $1`,
      [TENANT_ID],
    );
    for (const row of codeRows.rows) costCodes.set(row.code, row.id);

    return {
      staff,
      richmond: richmond.rows[0]!.id,
      hampton: units.rows[0]?.id ?? richmond.rows[0]!.id,
      jurisdictions,
      costCodes,
    };
  });

  // --------------------------------------------------------------- vendors ---
  const REQUIRED = [
    'master_agreement',
    'tax_form',
    'license',
    'gl_insurance',
    'wc_insurance',
    'auto_insurance',
  ] as const;

  const vendors = await db.withTenant(TENANT_ID, async (c) => {
    const made: Record<string, string> = {};
    for (const [key, name, trades, glExpiry] of [
      ['tile', 'Tidewater Tile Co.', ['tile'], '2026-11-30'],
      ['plumb', 'Bell Plumbing LLC', ['plumbing'], '2026-11-30'],
      // The lapsed one. Everything else current, general liability expired
      // yesterday — which is what blocks scheduling and lights up the console.
      ['paint', 'Cardinal Painting', ['painting'], 'yesterday'],
      ['counter', 'Riverside Countertops', ['countertops'], '2027-03-31'],
      ['elec', 'Peninsula Electric', ['electrical'], '2027-06-30'],
      ['drywall', 'James River Drywall', ['drywall'], '2026-09-30'],
      ['floor', 'Old Dominion Flooring', ['flooring'], '2027-05-31'],
    ] as const) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO projects.vendors
           (tenant_id, legal_name, email, trades, license_authority, active, onboarded_at)
         VALUES ($1,$2,$3,$4,'VA DPOR',true, now()) RETURNING id`,
        [TENANT_ID, name, `${key}@demo.test`, trades],
      );
      const vendorId = rows[0]!.id;
      made[key] = vendorId;

      for (const kind of REQUIRED) {
        const expires =
          kind === 'gl_insurance' && glExpiry === 'yesterday'
            ? null // set below with a relative date
            : '2027-12-31';
        if (expires === null) {
          await c.query(
            `INSERT INTO projects.vendor_documents (tenant_id, vendor_id, kind, expires_on, file_key)
             VALUES ($1,$2,$3::projects.doc_kind, CURRENT_DATE - 4, $4)`,
            [TENANT_ID, vendorId, kind, `demo/${key}/${kind}`],
          );
        } else {
          await c.query(
            `INSERT INTO projects.vendor_documents (tenant_id, vendor_id, kind, expires_on, file_key)
             VALUES ($1,$2,$3::projects.doc_kind,$4,$5)`,
            [TENANT_ID, vendorId, kind, expires, `demo/${key}/${kind}`],
          );
        }
      }
    }
    return made;
  });
  log(`vendors: ${Object.keys(vendors).length} (Cardinal Painting GL expired 4 days ago)`);

  /**
   * Seeds the tenant's real draw schedule, then advances the first `invoiced`
   * of them through earned, approved and invoiced, and optionally leaves the
   * next one approved-but-uninvoiced — the exception this module exists to
   * surface.
   *
   * Uses the template rather than hand-written amounts so the demo shows the
   * actual 30/30/30/10 with its retainage held. A demo that hardcodes the
   * numbers demonstrates the numbers, not the feature.
   */
  async function seedDraws(
    projectId: string,
    invoiced: number,
    approvedNotInvoiced: number,
    contractValue: number,
    invoicePrefix: string,
  ) {
    await db.withTenant(TENANT_ID, async (c) => {
      await seedDrawSchedule(c, TENANT_ID, projectId, contractValue);
      for (let i = 1; i <= invoiced; i++) {
        await c.query(
          `UPDATE projects.draws
              SET status = 'invoiced', earned_at = now() - interval '20 days',
                  approved_by = $3, approved_at = now() - interval '14 days',
                  external_invoice_number = $4,
                  external_invoice_recorded_at = now() - interval '12 days'
            WHERE project_id = $1 AND sequence_number = $2`,
          [projectId, i, ids.staff.manager, `${invoicePrefix}-${i}`],
        );
      }
      for (let i = invoiced + 1; i <= invoiced + approvedNotInvoiced; i++) {
        await c.query(
          `UPDATE projects.draws
              SET status = 'approved', earned_at = now() - interval '8 days',
                  approved_by = $3, approved_at = now() - interval '6 days'
            WHERE project_id = $1 AND sequence_number = $2`,
          [projectId, i, ids.staff.manager],
        );
      }
    });
  }


  // -------------------------------------------------------------- projects ---
  interface BudgetSpec {
    code: string;
    budget: number;
    billed: number;
    committed: number;
  }

  async function buildProject(spec: {
    number: string;
    name: string;
    address: string;
    city: string;
    unit: string;
    jurisdiction: string;
    pm: string;
    contract: number | null;
    target: number;
    stage: string;
    approvedGates: number;
    startedDaysAgo: number;
    lengthDays: number;
    budget: BudgetSpec[];
    customer?: string;
  }) {
    return db.withTenant(TENANT_ID, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO projects.projects
           (tenant_id, project_number, business_unit_id, jurisdiction_id, name,
            address_line1, city, region, pm_id, contract_value, target_margin, stage,
            actual_start, scheduled_start, scheduled_end, external_job_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'VA',$8,$9,$10,$11::projects.project_stage,
                 CURRENT_DATE - $12::int,
                 (now() AT TIME ZONE 'America/New_York')::date,
                 CURRENT_DATE - $12::int + $13::int, $14)
         RETURNING id`,
        [
          TENANT_ID,
          spec.number,
          spec.unit,
          spec.jurisdiction,
          spec.name,
          spec.address,
          spec.city,
          spec.pm,
          spec.contract,
          spec.target,
          spec.stage,
          spec.startedDaysAgo,
          spec.lengthDays,
          spec.number.replace(/\D/g, '').slice(-6),
        ],
      );
      const projectId = rows[0]!.id;
      if (spec.customer) {
        await c.query(
          `UPDATE projects.projects SET source_customer_name = $2 WHERE id = $1`,
          [projectId, spec.customer],
        );
      }

      await c.query(
        `INSERT INTO projects.stage_gates (tenant_id, project_id, gate_number, title, checklist)
         SELECT tenant_id, $1, gate_number, title, checklist
           FROM projects.gate_templates WHERE tenant_id = $2`,
        [projectId, TENANT_ID],
      );

      for (const line of spec.budget) {
        const costCodeId = ids.costCodes.get(line.code);
        if (!costCodeId) throw new Error(`demo seed references unknown cost code ${line.code}`);
        await c.query(
          `INSERT INTO projects.budget_lines
             (tenant_id, project_id, cost_code_id, cost_type, budget_amount)
           VALUES ($1,$2,$3,(SELECT default_cost_type FROM projects.cost_codes WHERE id = $3),$4)`,
          [TENANT_ID, projectId, costCodeId, line.budget],
        );
      }

      // Approve gates in order. The freeze gate's trigger copies budget to
      // baseline as a side effect, which is the point — the seed does not set
      // baseline_amount itself.
      for (let g = 0; g < spec.approvedGates; g++) {
        await c.query(
          `UPDATE projects.stage_gates
              SET status = 'approved', approved_by = $3, approved_at = now() - interval '10 days'
            WHERE project_id = $1 AND gate_number = $2`,
          [projectId, g, ids.staff.manager],
        );
      }

      return projectId;
    });
  }

  async function spendAgainst(
    projectId: string,
    poNumberPrefix: string,
    lines: Array<BudgetSpec & { vendor?: string }>,
  ) {
    await db.withTenant(TENANT_ID, async (c) => {
      let n = 1;
      for (const line of lines) {
        if (line.billed === 0 && line.committed === 0) continue;
        const costCodeId = ids.costCodes.get(line.code)!;
        const amount = line.billed + line.committed;
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO projects.purchase_orders
             (tenant_id, project_id, po_number, supplier_name, vendor_id, cost_code_id, cost_type,
              amount, scope_text, status, issued_by, issued_at)
           VALUES ($1,$2,$3,$4,$5,$6,
                   (SELECT default_cost_type FROM projects.cost_codes WHERE id = $6),
                   $7,$8,'issued',$9, now() - interval '14 days')
           RETURNING id`,
          [
            TENANT_ID,
            projectId,
            `${poNumberPrefix}-${String(n++).padStart(3, '0')}`,
            line.vendor ? null : 'Trade supplier',
            line.vendor ? vendors[line.vendor] : null,
            costCodeId,
            amount,
            `Work to cost code ${line.code}`,
            ids.staff.manager,
          ],
        );
        if (line.billed > 0) {
          await c.query(
            `INSERT INTO projects.vendor_bills
               (tenant_id, po_id, vendor_invoice_number, amount, status, approved_by, approved_at)
             VALUES ($1,$2,$3,$4,'approved',$5, now() - interval '7 days')`,
            [TENANT_ID, rows[0]!.id, `INV-${poNumberPrefix}-${n}`, line.billed, ids.staff.bookkeeper],
          );
        }
      }
    });
  }

  // --- Whitfield: mid-execution, one code over, one draw approved not invoiced
  const whitfieldBudget: BudgetSpec[] = [
    { code: '110', budget: 640, billed: 640, committed: 0 },
    { code: '120', budget: 900, billed: 1150, committed: 0 },
    { code: '210', budget: 2200, billed: 2050, committed: 0 },
    { code: '510', budget: 4800, billed: 4800, committed: 0 },
    { code: '520', budget: 2600, billed: 0, committed: 2600 },
    { code: '610', budget: 2100, billed: 2100, committed: 0 },
    { code: '820', budget: 1900, billed: 1900, committed: 0 },
    { code: '1110', budget: 3400, billed: 4180, committed: 0 },
    { code: '1120', budget: 5200, billed: 3100, committed: 2100 },
    { code: '1030', budget: 1850, billed: 0, committed: 1850 },
    { code: '1210', budget: 1400, billed: 0, committed: 1400 },
    { code: '1410', budget: 800, billed: 0, committed: 0 },
    { code: 'MHM.25PLFE', budget: 4800, billed: 0, committed: 0 },
  ];

  const whitfield = await buildProject({
    number: 'DMO-2026-0184',
    name: 'Whitfield — Primary Bath',
    address: '4412 Grove Avenue',
    city: 'Richmond',
    unit: ids.richmond,
    jurisdiction: ids.jurisdictions['City of Richmond']!,
    pm: ids.staff.pm!,
    contract: 41800,
    target: 0.38,
    stage: 'execution',
    approvedGates: 3,
    startedDaysAgo: 19,
    lengthDays: 24,
    budget: whitfieldBudget,
    customer: 'Ada Whitfield',
  });
  await spendAgainst(whitfield, 'PO-W', [
    ...whitfieldBudget.map((b) => ({
      ...b,
      vendor:
        b.code === '1120' ? 'tile' : b.code === '510' || b.code === '520' ? 'plumb' : undefined,
    })),
  ]);

  await seedDraws(whitfield, 2, 1, 41800, '118432');

  await db.withTenant(TENANT_ID, async (c) => {
    const permit = await c.query<{ id: string }>(
      `INSERT INTO projects.permits
         (tenant_id, project_id, jurisdiction_id, permit_type, permit_number, applied_on, issued_on)
       VALUES ($1,$2,$3,'Building','BLD-26-4471', CURRENT_DATE - 27, CURRENT_DATE - 18)
       RETURNING id`,
      [TENANT_ID, whitfield, ids.jurisdictions['City of Richmond']],
    );
    await c.query(
      `INSERT INTO projects.permit_milestones
         (tenant_id, permit_id, sequence_number, name, owner_role, due_on, status, completed_at)
       SELECT t.tenant_id, $1, t.sequence_number, t.name, t.owner_role,
              CURRENT_DATE - 27 + COALESCE(t.offset_days, t.sequence_number * 3),
              CASE WHEN t.sequence_number <= 8 THEN 'complete'::projects.milestone_status
                   ELSE 'pending'::projects.milestone_status END,
              CASE WHEN t.sequence_number <= 8 THEN now() - interval '15 days' END
         FROM projects.permit_milestone_templates t WHERE t.tenant_id = $2`,
      [permit.rows[0]!.id, TENANT_ID],
    );

    // Cardinal Painting is scheduled but its GL lapsed — proposed rather than
    // confirmed, because the trigger will not allow confirmed and that is the
    // behaviour being demonstrated.
    const schedule: Array<[string, string, number, number, string, string | null]> = [
      ['Set tile', 'tile', 0, 3, 'confirmed', 'Waterproofing and finishes'],
      ['Plumbing finish set', 'plumb', 4, 5, 'proposed', 'Installation and trim'],
      ['Interior painting', 'paint', 8, 11, 'proposed', 'Installation and trim'],
      ['Countertop template', 'counter', 6, 6, 'proposed', null],
    ];
    const scheduleIds = new Map<string, string>();
    for (const [title, vendorKey, startOffset, endOffset, status, phase] of schedule) {
      const inserted = await c.query<{ id: string }>(
        `INSERT INTO projects.schedule_items
           (tenant_id, project_id, title, vendor_id, window_start, window_end, status, phase)
         VALUES ($1,$2,$3,$4, CURRENT_DATE + $5::int, CURRENT_DATE + $6::int, $7::projects.sched_status, $8)
         RETURNING id`,
        [TENANT_ID, whitfield, title, vendors[vendorKey], startOffset, endOffset, status, phase],
      );
      scheduleIds.set(title, inserted.rows[0]!.id);
    }
    await c.query(
      `INSERT INTO projects.schedule_dependencies
         (tenant_id, project_id, schedule_item_id, predecessor_id, lag_days)
       VALUES ($1,$2,$3,$4,0)`,
      [TENANT_ID, whitfield, scheduleIds.get('Plumbing finish set'), scheduleIds.get('Set tile')],
    );
  });
  log('project: Whitfield — Primary Bath (1 code over, 1 draw uninvoiced, 1 vendor blocked)');
  await db.withTenant(TENANT_ID, (c) =>
    c.query(
      `UPDATE projects.projects
          SET st_status_id = '221978475',
              st_status_name = 'Hold',
              st_substatus_id = NULL,
              st_substatus_name = NULL,
              st_status_synced_at = now(),
              st_status_modified_on = now(),
              st_status_write_result = 'ok',
              st_status_gate_warning = $2
        WHERE id = $1`,
      [
        whitfield,
        'ServiceTitan moved this project from precon to execution, outside the one-step stage sequence. Stage gates were not approved.',
      ],
    ),
  );

  // Goals and milestones whose stored status is deliberately stale. The plan
  // screen calculates over those values: milestone status from linked tasks,
  // goal percent from milestones that are done.
  await db.withTenant(TENANT_ID, async (c) => {
    const asOf = today();
    const on = (days: number) => {
      const date = new Date(asOf + 'T12:00:00Z');
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };
    const insert = async (kind: string, data: Record<string, unknown>) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO projects.project_controls (tenant_id, project_id, kind, data)
         VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
        [TENANT_ID, whitfield, kind, JSON.stringify(data)],
      );
      return rows[0]!.id;
    };
    const bath = await insert('goal', {
      title: 'Finish the primary bath',
      description: 'The room is ready for the customer to use.',
      owner_id: ids.staff.pm,
      due_on: on(21),
      state: 'complete',
      key_results: [
        { name: 'Open punch items', start: 12, target: 0, current: 4, unit: 'items' },
      ],
    });
    const signoff = await insert('goal', {
      title: 'Homeowner sign-off',
      description: 'The customer has walked the finished room.',
      owner_id: ids.staff.pm,
      due_on: on(24),
      state: 'in_progress',
      key_results: [],
    });
    const milestone = async (
      title: string,
      goalId: string,
      due: string,
      criteria: string,
      stored: string,
    ) =>
      insert('milestone', {
        title,
        description: '',
        owner_id: ids.staff.pm,
        due_on: due,
        state: stored,
        completed_on: null,
        goal_id: goalId,
        success_criteria: criteria,
      });
    const work = async (
      title: string,
      milestoneId: string,
      start: string,
      due: string,
      state: string,
      order: number,
    ) =>
      insert('task', {
        title,
        description: '',
        owner_id: ids.staff.pm,
        start_on: start,
        due_on: due,
        completed_on: state === 'complete' ? on(-1) : null,
        state,
        parent_id: null,
        dependency_ids: [],
        milestone_id: milestoneId,
        resource_id: null,
        job_link_id: null,
        sort_order: order,
      });
    const demo = await milestone(
      'Demo and protection',
      bath,
      on(-2),
      'Room is protected and the old fixtures are out.',
      'not_started',
    );
    await work('Protect floors and remove the vanity', demo, on(-12), on(-6), 'complete', 1);
    await work('Haul debris', demo, on(-8), on(-4), 'complete', 2);
    const tile = await milestone(
      'Tile and fixtures',
      bath,
      on(5),
      'Walls are tiled and the new fixtures are set.',
      'complete',
    );
    await work('Set wall tile', tile, on(-2), on(4), 'complete', 1);
    await work('Set the vanity and toilet', tile, on(1), on(6), 'in_progress', 2);
    const inspection = await milestone(
      'Final inspection',
      bath,
      on(3),
      'The inspector has signed the bath.',
      'in_progress',
    );
    await work('Schedule the inspection', inspection, on(-10), on(-4), 'in_progress', 1);
    await work('Close the punch list', inspection, on(-1), on(4), 'not_started', 2);
    const selections = await milestone(
      'Material selections',
      signoff,
      on(8),
      'The customer has approved the remaining finishes.',
      'not_started',
    );
    await work('Confirm the faucet finish', selections, on(-1), on(6), 'blocked', 1);
    await milestone(
      'Weekly check-in',
      signoff,
      on(10),
      'A walkthrough is on the calendar. No tasks are linked yet.',
      'complete',
    );
  });
  log('project controls: Whitfield goals and milestones roll up from tasks');

  await db.withTenant(TENANT_ID, async (c) => {
    const start = (
      await c.query<{ scheduled_start: string | null }>(
        `SELECT scheduled_start::text AS scheduled_start FROM projects.projects WHERE id = $1`,
        [whitfield],
      )
    ).rows[0]?.scheduled_start ?? null;
    await seedPreconTasks(c, TENANT_ID, whitfield, start);
    const asOf = today();
    await c.query(
      `UPDATE projects.precon_tasks
          SET due_on = $2::date - 1
        WHERE project_id = $1 AND title = 'Materials ordered'`,
      [whitfield, asOf],
    );
    await c.query(
      `UPDATE projects.precon_tasks
          SET due_on = $2::date
        WHERE project_id = $1 AND title = 'Subs booked'`,
      [whitfield, asOf],
    );
  });
  log('precon: Whitfield checklist, with materials overdue and subs due today');

  await db.withTenant(TENANT_ID, async (c) => {
    const laborCode = ids.costCodes.get('MHM.25PLFE');
    if (!laborCode) throw new Error('demo seed missing MHM.25PLFE');
    await c.query(
      `INSERT INTO projects.technician_labor_rates
         (tenant_id, external_technician_id, technician_name, active,
          hourly_rate, burden_rate, pay_basis, burden_unset, is_field_tech)
       VALUES
         ($1, 'tech-casey', 'Casey Nguyen', true, NULL, NULL, 'commission', false, true),
         ($1, 'tech-justin', 'Justin M.', true, NULL, NULL, 'hourly', true, true),
         ($1, 'tech-mason', 'Mason', true, NULL, NULL, 'missing', true, false),
         ($1, 'tech-riley', 'Riley Cho', true, NULL, NULL, 'missing', true, true),
         ($1, 'tech-office', 'Office Notes', true, NULL, NULL, 'missing', true, false),
         ($1, 'tech-req', 'Project Requirements', true, NULL, NULL, 'missing', true, false),
         ($1, 'tech-sub', 'Subcontractor', true, NULL, NULL, 'missing', true, false),
         ($1, '11000041', 'Wesley M', true, NULL, NULL, NULL, false, true)`,
      [TENANT_ID],
    );
    // 4 h × $188 × 25% = $188 labor, 4 h × $12 burden = $48.
    // Justin is hourly: 2 h × $36 = $72, burden not set.
    // Wesley M (technician 11000041) is an active ServiceTitan technician.
    // The rates themselves are not stored.
    await c.query(
      `INSERT INTO projects.labor_actuals
         (tenant_id, project_id, external_job_id, external_timesheet_id,
          external_technician_id, technician_name, work_date, hours, source,
          cost_code_id, observed_at, labor_amount, burden_amount, pay_basis,
          burden_unset, priced_billable_rate)
       VALUES
         ($1,$2,'demo-job','demo-ts-casey','tech-casey','Casey Nguyen',
          CURRENT_DATE - 2, 4.00, 'timesheet', $3, now(), 188.00, 48.00,
          'commission', false, 188),
         ($1,$2,'demo-job','demo-ts-justin','tech-justin','Justin M.',
          CURRENT_DATE - 1, 2.00, 'timesheet', $3, now(), 72.00, NULL,
          'hourly', true, NULL),
         ($1,$2,'demo-job','demo-ts-wesley','11000041', NULL,
          CURRENT_DATE - 1, 2.07, 'timesheet', $3, now(), NULL, NULL,
          NULL, false, NULL)`,
      [TENANT_ID, whitfield, laborCode],
    );
    await c.query(
      `UPDATE projects.projects
          SET labor_refreshed_at = now() - interval '25 minutes',
              labor_refresh_source = 'scheduled'
        WHERE id = $1`,
      [whitfield],
    );
    await c.query(
      `INSERT INTO projects.st_invoice_lines
         (tenant_id, project_id, external_invoice_id, external_job_id, line_key,
          sku, kind, quantity, total)
       VALUES
         ($1, $2, 'demo-inv-labor', '900184', 'labor', 'MHM.25PLFE', 'labor', 4, 752.00),
         ($1, $2, 'demo-inv-labor', '900184', 'materials', 'TILE', 'material', 1, 1200.00)`,
      [TENANT_ID, whitfield],
    );
    await c.query(
      `INSERT INTO projects.st_material_expenses
         (tenant_id, project_id, external_job_id, external_po_id, total)
       VALUES ($1, $2, '900184', 'demo-po-1', 400.00)`,
      [TENANT_ID, whitfield],
    );
    await c.query(
      `INSERT INTO projects.st_financial_reconciliation
         (tenant_id, project_id, observed_at, lines, technicians, error)
       VALUES ($1, $2, now(), '[]'::jsonb, '[]'::jsonb, NULL)`,
      [TENANT_ID, whitfield],
    );
    await c.query(
      `INSERT INTO projects.st_project_summary
         (tenant_id, project_id, contract_value, total_budgeted_expense, change_orders,
          cost_adjustments, budgeted_labor_expense, budgeted_labor_hours, budgeted_materials,
          invoice_billed, open_invoices, retainage, estimates_read, invoices_read, observed_at)
       VALUES ($1, $2, 41800, 25920, 2400, 0, 4800, 32, 8000, 27480, 14940, 4180, true, true, now())`,
      [TENANT_ID, whitfield],
    );
    await c.query(
      `INSERT INTO projects.project_closeout
         (project_id, tenant_id, punch_done_at, punch_note, photos_done_at, photos_note)
       VALUES ($2, $1, now(), 'Tile edge and caulk', now(), 'Filed in the photos folder')`,
      [TENANT_ID, whitfield],
    );
    await c.query(
      `INSERT INTO projects.st_plan_appointments
         (tenant_id, project_id, external_job_id, external_appointment_id,
          job_number, appointment_number, job_status, starts_at, ends_at,
          status, active, technicians)
       VALUES (
         $1, $2, '900184', 'appt-184', '900184', '1', 'Scheduled',
         (date_trunc('day', now() AT TIME ZONE 'America/New_York')
            + interval '1 day' + interval '9 hours') AT TIME ZONE 'America/New_York',
         (date_trunc('day', now() AT TIME ZONE 'America/New_York')
            + interval '1 day' + interval '12 hours') AT TIME ZONE 'America/New_York',
         'Scheduled', true, $3::jsonb
       )`,
      [
        TENANT_ID,
        whitfield,
        JSON.stringify([{ id: 'tech-casey', name: 'Casey Nguyen' }]),
      ],
    );
    const system = await c.query<{ id: string }>(
      `SELECT id FROM projects.external_systems ORDER BY display_name LIMIT 1`,
    );
    const systemId = system.rows[0]?.id;
    if (systemId) {
      const linked = await c.query<{ id: string }>(
        `INSERT INTO projects.project_job_links
           (tenant_id, project_id, external_system_id, external_job_id, title, source_active)
         VALUES ($1,$2,$3,'900184','Whitfield field job', true)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [TENANT_ID, whitfield, systemId],
      );
      const linkId =
        linked.rows[0]?.id ??
        (
          await c.query<{ id: string }>(
            `SELECT id FROM projects.project_job_links
              WHERE project_id = $1 AND external_job_id = '900184'`,
            [whitfield],
          )
        ).rows[0]?.id;
      if (linkId) {
        await c.query(
          `UPDATE projects.schedule_items
              SET job_link_id = $1
            WHERE project_id = $2 AND title = 'Set tile'`,
          [linkId, whitfield],
        );
      }
      // A second visit is linked only through a WBS task that states no phase.
      // The Gantt leaves it Unphased until a PM picks a phase on that task.
      const wbsLinked = await c.query<{ id: string }>(
        `INSERT INTO projects.project_job_links
           (tenant_id, project_id, external_system_id, external_job_id, title, source_active, source_job_number)
         VALUES ($1,$2,$3,'900185','Whitfield trim visit', true, 'WBS-185')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [TENANT_ID, whitfield, systemId],
      );
      const wbsLinkId =
        wbsLinked.rows[0]?.id ??
        (
          await c.query<{ id: string }>(
            `SELECT id FROM projects.project_job_links
              WHERE project_id = $1 AND external_job_id = '900185'`,
            [whitfield],
          )
        ).rows[0]?.id;
      if (wbsLinkId) {
        const asOf = today();
        await c.query(
          `INSERT INTO projects.st_plan_appointments
             (tenant_id, project_id, external_job_id, external_appointment_id,
              job_number, appointment_number, job_status, starts_at, ends_at,
              status, active, technicians)
           VALUES (
             $1, $2, '900185', 'appt-wbs-185', 'WBS-185', '1', 'Scheduled',
             (date_trunc('day', now() AT TIME ZONE 'America/New_York')
                + interval '1 day' + interval '13 hours') AT TIME ZONE 'America/New_York',
             (date_trunc('day', now() AT TIME ZONE 'America/New_York')
                + interval '1 day' + interval '16 hours') AT TIME ZONE 'America/New_York',
             'Scheduled', true, $3::jsonb
           )`,
          [
            TENANT_ID,
            whitfield,
            JSON.stringify([{ id: 'tech-riley', name: 'Riley Cho' }]),
          ],
        );
        await c.query(
          `INSERT INTO projects.project_controls (tenant_id, project_id, kind, data)
           VALUES ($1,$2,'task',$3::jsonb)`,
          [
            TENANT_ID,
            whitfield,
            JSON.stringify({
              title: 'Trim crew visit',
              description: 'Linked to the ServiceTitan trim visit. No phase until one is chosen.',
              owner_id: null,
              start_on: asOf,
              due_on: asOf,
              completed_on: null,
              state: 'not_started',
              parent_id: null,
              dependency_ids: [],
              milestone_id: null,
              resource_id: null,
              job_link_id: wbsLinkId,
              sort_order: 0,
            }),
          ],
        );
      }
      await storeProjectAr(c, {
        tenantId: TENANT_ID,
        projectId: whitfield,
        externalSystemId: systemId,
        jobIds: ['900184'],
        read: {
          forbidden: false,
          invoices: [
            {
              externalInvoiceId: 'demo-inv-1',
              invoiceNumber: '118432-1',
              externalJobId: '900184',
              total: 12540,
              balance: 0,
              invoicedOn: '2026-10-01',
              paidOn: '2026-10-12',
            },
            {
              externalInvoiceId: 'demo-inv-2',
              invoiceNumber: '118432-2',
              externalJobId: '900184',
              total: 12540,
              balance: 12540,
              invoicedOn: '2026-10-15',
              paidOn: null,
            },
            {
              externalInvoiceId: 'demo-inv-3',
              invoiceNumber: 'ST-4401',
              externalJobId: '900184',
              total: 2400,
              balance: 2400,
              invoicedOn: '2026-10-20',
              paidOn: null,
            },
          ],
          payments: [],
          estimates: [
            {
              externalEstimateId: 'demo-est-9',
              name: 'Customer upgraded the tile',
              externalJobId: '900184',
              status: 'Sold',
              soldOn: '2026-10-18',
              customerAmount: 2400,
            },
          ],
        },
      });
    }
  });

  // --- Okonkwo: preconstruction, permit review overdue
  const okonkwoBudget: BudgetSpec[] = [
    { code: '110', budget: 1150, billed: 1150, committed: 0 },
    { code: '170', budget: 2400, billed: 2400, committed: 0 },
    { code: '210', budget: 3100, billed: 0, committed: 3100 },
    { code: '310', budget: 2800, billed: 0, committed: 0 },
    { code: '510', budget: 5600, billed: 0, committed: 5600 },
    { code: '610', budget: 6200, billed: 0, committed: 6200 },
    { code: '640', budget: 4400, billed: 0, committed: 4400 },
    { code: '1010', budget: 14800, billed: 7400, committed: 7400 },
    { code: '1030', budget: 5200, billed: 0, committed: 0 },
    { code: '1110', budget: 2900, billed: 0, committed: 0 },
    { code: '1310', budget: 6800, billed: 0, committed: 0 },
  ];

  const okonkwo = await buildProject({
    number: 'DMO-2026-0093',
    name: 'Okonkwo — Kitchen Remodel',
    address: '118 Chesapeake Avenue',
    city: 'Newport News',
    unit: ids.hampton,
    jurisdiction: ids.jurisdictions['City of Newport News']!,
    pm: ids.staff.pm2!,
    contract: 68400,
    target: 0.36,
    stage: 'precon',
    approvedGates: 2,
    startedDaysAgo: 15,
    lengthDays: 60,
    budget: okonkwoBudget,
    customer: 'Chidi Okonkwo',
  });
  await spendAgainst(
    okonkwo,
    'PO-O',
    okonkwoBudget.map((b) => ({ ...b, vendor: b.code === '610' ? 'elec' : undefined })),
  );

  await db.withTenant(TENANT_ID, async (c) => {
    const permit = await c.query<{ id: string }>(
      `INSERT INTO projects.permits
         (tenant_id, project_id, jurisdiction_id, permit_type, applied_on)
       VALUES ($1,$2,$3,'Building', CURRENT_DATE - 12) RETURNING id`,
      [TENANT_ID, okonkwo, ids.jurisdictions['City of Newport News']],
    );
    await c.query(
      `INSERT INTO projects.permit_milestones
         (tenant_id, permit_id, sequence_number, name, owner_role, due_on, status, completed_at)
       SELECT t.tenant_id, $1, t.sequence_number, t.name, t.owner_role,
              CURRENT_DATE - 12 + COALESCE(t.offset_days, t.sequence_number),
              CASE WHEN t.sequence_number <= 2 THEN 'complete'::projects.milestone_status
                   WHEN t.sequence_number = 3 THEN 'in_progress'::projects.milestone_status
                   ELSE 'pending'::projects.milestone_status END,
              CASE WHEN t.sequence_number <= 2 THEN now() - interval '9 days' END
         FROM projects.permit_milestone_templates t WHERE t.tenant_id = $2`,
      [permit.rows[0]!.id, TENANT_ID],
    );
    for (const [title, vendorKey, s, e, phase] of [
      ['Electrical rough', 'elec', 20, 22, 'Rough-in'],
      ['Plumbing rough', 'plumb', 21, 23, 'Rough-in'],
    ] as const) {
      await c.query(
        `INSERT INTO projects.schedule_items
           (tenant_id, project_id, title, vendor_id, window_start, window_end, status, phase)
         VALUES ($1,$2,$3,$4,CURRENT_DATE + $5::int, CURRENT_DATE + $6::int,'confirmed',$7)`,
        [TENANT_ID, okonkwo, title, vendors[vendorKey], s, e, phase],
      );
    }
  });
  await seedDraws(okonkwo, 1, 0, 68400, '119017');
log('project: Okonkwo — Kitchen Remodel (permit review overdue)');

  // --- Delaney: healthy, nothing blocking
  const delaneyBudget: BudgetSpec[] = [
    { code: '110', budget: 980, billed: 980, committed: 0 },
    { code: '120', budget: 1200, billed: 1080, committed: 0 },
    { code: '310', budget: 6400, billed: 6150, committed: 0 },
    { code: '320', budget: 3800, billed: 3640, committed: 0 },
    { code: '610', budget: 7200, billed: 7200, committed: 0 },
    { code: '710', budget: 4900, billed: 4900, committed: 0 },
    { code: '810', budget: 2600, billed: 2600, committed: 0 },
    { code: '820', budget: 8400, billed: 8400, committed: 0 },
    { code: '920', budget: 2900, billed: 2740, committed: 0 },
    { code: '930', budget: 5200, billed: 3900, committed: 1300 },
    { code: '1130', budget: 4100, billed: 4100, committed: 0 },
    { code: '1210', budget: 3600, billed: 0, committed: 3600 },
  ];

  const delaney = await buildProject({
    number: 'DMO-2026-0171',
    name: 'Delaney — Basement Finish',
    address: '7720 Ridgefield Road',
    city: 'Henrico',
    unit: ids.richmond,
    jurisdiction: ids.jurisdictions['Henrico County']!,
    pm: ids.staff.pm!,
    contract: 57200,
    target: 0.35,
    stage: 'execution',
    approvedGates: 3,
    startedDaysAgo: 31,
    lengthDays: 38,
    budget: delaneyBudget,
    customer: 'Pat Delaney',
  });
  await spendAgainst(
    delaney,
    'PO-D',
    delaneyBudget.map((b) => ({ ...b, vendor: b.code === '820' ? 'drywall' : undefined })),
  );

  await db.withTenant(TENANT_ID, async (c) => {
    await c.query(
      `INSERT INTO projects.daily_logs
         (tenant_id, project_id, log_date, author_id, work_completed, weather)
       VALUES ($1,$2,CURRENT_DATE - 1,$3,'Trim install continued in the north room.','Clear, 78F')`,
      [TENANT_ID, delaney, ids.staff.pm],
    );
    const permit = await c.query<{ id: string }>(
      `INSERT INTO projects.permits
         (tenant_id, project_id, jurisdiction_id, permit_type, permit_number, applied_on, issued_on)
       VALUES ($1,$2,$3,'Building','B-26-8812', CURRENT_DATE - 54, CURRENT_DATE - 42)
       RETURNING id`,
      [TENANT_ID, delaney, ids.jurisdictions['Henrico County']],
    );
    await c.query(
      `INSERT INTO projects.permit_milestones
         (tenant_id, permit_id, sequence_number, name, owner_role, due_on, status, completed_at)
       SELECT t.tenant_id, $1, t.sequence_number, t.name, t.owner_role,
              CURRENT_DATE + t.sequence_number,
              CASE WHEN t.sequence_number <= 10 THEN 'complete'::projects.milestone_status
                   ELSE 'pending'::projects.milestone_status END,
              CASE WHEN t.sequence_number <= 10 THEN now() - interval '20 days' END
         FROM projects.permit_milestone_templates t WHERE t.tenant_id = $2`,
      [permit.rows[0]!.id, TENANT_ID],
    );
    for (const [title, vendorKey, s, e, phase] of [
      ['Interior painting', 'paint', 6, 9, 'Waterproofing and finishes'],
      ['Flooring install', 'floor', 9, 11, 'Installation and trim'],
    ] as const) {
      await c.query(
        `INSERT INTO projects.schedule_items
           (tenant_id, project_id, title, vendor_id, window_start, window_end, status, phase)
         VALUES ($1,$2,$3,$4,CURRENT_DATE + $5::int, CURRENT_DATE + $6::int,'proposed',$7)`,
        [TENANT_ID, delaney, title, vendors[vendorKey], s, e, phase],
      );
    }
  });
  await seedDraws(delaney, 3, 0, 57200, '117980');
log('project: Delaney — Basement Finish (healthy)');

  // CSR hand-offs. Nguyen is still a draft on the form, prefilled from the
  // linked project. Brooks and Hale are submitted and waiting on Home.
  // Gate 0 is already complete on the two that were submitted.
  const nguyen = await buildProject({
    number: 'DMO-2026-0201',
    name: 'Nguyen — Hall Bath',
    address: '3102 Parkwood Avenue',
    city: 'Richmond',
    unit: ids.richmond,
    jurisdiction: ids.jurisdictions['City of Richmond']!,
    pm: ids.staff.pm!,
    contract: 18640,
    target: 0.35,
    stage: 'handoff',
    approvedGates: 0,
    startedDaysAgo: 0,
    lengthDays: 14,
    budget: [],
    customer: 'Linh Nguyen',
  });
  const brooks = await buildProject({
    number: 'DMO-2026-0202',
    name: 'Brooks — Powder Room',
    address: '18 Westover Avenue',
    city: 'Richmond',
    unit: ids.richmond,
    jurisdiction: ids.jurisdictions['City of Richmond']!,
    pm: ids.staff.pm!,
    contract: 7100,
    target: 0.34,
    stage: 'handoff',
    approvedGates: 1,
    startedDaysAgo: 0,
    lengthDays: 10,
    budget: [],
    customer: 'Mara Brooks',
  });
  const hale = await buildProject({
    number: 'DMO-2026-0203',
    name: 'Hale — Sunroom',
    address: '902 Mariners Boulevard',
    city: 'Newport News',
    unit: ids.hampton,
    jurisdiction: ids.jurisdictions['City of Newport News']!,
    pm: ids.staff.pm2!,
    contract: 24800,
    target: 0.33,
    stage: 'handoff',
    approvedGates: 1,
    startedDaysAgo: 0,
    lengthDays: 21,
    budget: [],
    customer: 'Ellis Hale',
  });

  await db.withTenant(TENANT_ID, async (c) => {
    await c.query(
      `UPDATE projects.projects
          SET actual_start = NULL,
              scheduled_start = (now() AT TIME ZONE 'America/New_York')::date + 21,
              scheduled_end = (now() AT TIME ZONE 'America/New_York')::date + 35,
              source_project_summary = $2
        WHERE id = $1`,
      [
        nguyen,
        'Replace the hall bath tub with a tiled shower. Keep the existing vanity.',
      ],
    );
    await c.query(
      `UPDATE projects.projects SET actual_start = NULL WHERE id = ANY($1::uuid[])`,
      [[brooks, hale]],
    );
    const system = await c.query<{ id: string }>(
      `SELECT id FROM projects.external_systems WHERE tenant_id = $1 ORDER BY display_name LIMIT 1`,
      [TENANT_ID],
    );
    const systemId = system.rows[0]?.id;
    const nguyenContacts = nguyenServiceTitanContacts();
    if (systemId) {
      await c.query(
        `INSERT INTO projects.st_project_connections
           (project_id, tenant_id, external_system_id, external_project_id, connection_key,
            snapshot, observed_at, linked_by)
         VALUES ($1,$2,$3,'44821','demo:handoff',$4::jsonb, now(), $5)`,
        [
          nguyen,
          TENANT_ID,
          systemId,
          JSON.stringify({
            id: '44821',
            number: '44821',
            summary: 'Replace the hall bath tub with a tiled shower. Keep the existing vanity.',
            leadSource: 'Referral',
            customer: {
              id: '300',
              name: 'Linh Nguyen',
              phone: nguyenContacts.picked.phone,
              email: nguyenContacts.picked.email,
              contacts: nguyenContacts.customerContacts,
            },
            location: {
              id: '400',
              name: 'Home',
              address: {
                street: '3102 Parkwood Avenue',
                city: 'Richmond',
                state: 'VA',
                zip: '23221',
              },
              contacts: nguyenContacts.locationContacts,
            },
          }),
          ids.staff.office!,
        ],
      );
      await c.query(
        `INSERT INTO projects.st_estimate_observations
           (tenant_id, project_id, external_system_id, external_estimate_id, name,
            status, customer_amount, classification)
         VALUES ($1,$2,$3,'est-nguyen-hall','Hall bath remodel','Open',17250,'original')`,
        [TENANT_ID, nguyen, systemId],
      );
    }
    await c.query(
      `INSERT INTO projects.csr_handoffs (
         project_id, tenant_id, customer_name, phone, email, service_address, office,
         lead_source, scope_summary, handoff_project_ref, handoff_estimate_amount,
         sold_amount, target_start_window, access_notes, decision_maker_notes,
         permits_likely, status, submitted_at, submitted_by
       ) VALUES
         ($1,$2,'Mara Brooks','757-555-0190','mara.brooks@example.test',
          '18 Westover Avenue, Richmond, VA 23225','richmond','Repeat customer',
          'Powder room. New vanity, toilet, and floor tile.','45002',6400,7100,
          'Next two weeks','Lockbox 1928. Park in the drive.','Mara Brooks is the owner.',
          'unknown','submitted', now() - interval '1 hour', $3),
         ($4,$2,'Ellis Hale','757-555-0166','ellis.hale@example.test',
          '902 Mariners Boulevard, Newport News, VA 23601','hampton_newport_news','Website',
          'Sunroom off the kitchen. Screens and a knee wall.','45110',22100,24800,
          'After Thanksgiving','Dog in the yard until noon.','Ellis and Jan Hale decide together.',
          'yes','submitted', now() - interval '5 hours', $3)`,
      [brooks, TENANT_ID, ids.staff.office!, hale],
    );
  });
  log('handoff: Nguyen hall bath (form, not submitted)');
  log('handoff: Brooks powder room and Hale sunroom (waiting on Home, Gate 0 complete)');

  // Segreto reads SEGRETO_DASHBOARD_FIXTURE only. Contract and budget stay
  // blank until someone enters them on Financials. The example budget is not seeded.
  const segretoFixture = SEGRETO_DASHBOARD_FIXTURE;
  const segretoTiles = segretoDashboardInput(segretoFixture);
  const segreto = await buildProject({
    number: segretoFixture.identity.number,
    name: segretoFixture.identity.name,
    address: segretoFixture.identity.address,
    city: segretoFixture.identity.city,
    unit: ids.richmond,
    jurisdiction: ids.jurisdictions['City of Richmond']!,
    pm: ids.staff.pm!,
    contract: segretoFixture.journeymanContract,
    target: segretoFixture.targetMargin,
    stage: 'execution',
    approvedGates: 0,
    startedDaysAgo: 8,
    lengthDays: 18,
    budget: [],
    customer: segretoFixture.identity.customer,
  });
  await db.withTenant(TENANT_ID, async (c) => {
    const jobId = segretoFixture.identity.linkedJobId;
    await c.query(
      `UPDATE projects.projects
          SET external_job_id = $2,
              actual_start = $3::date,
              scheduled_start = $3::date,
              scheduled_end = $4::date
        WHERE id = $1`,
      [segreto, jobId, segretoFixture.identity.startedOn, segretoFixture.identity.targetFinishOn],
    );
    for (const line of segretoInvoiceLines(segretoFixture)) {
      await c.query(
        `INSERT INTO projects.st_invoice_lines
           (tenant_id, project_id, external_invoice_id, external_job_id, line_key,
            sku, kind, quantity, total)
         VALUES ($1, $2, 'segreto-inv', $3, $4, $5, $6, 1, $7)`,
        [TENANT_ID, segreto, jobId, line.lineKey, line.sku, line.kind, line.total],
      );
    }
    if (segretoFixture.actuals.materialsExpense != null) {
      await c.query(
        `INSERT INTO projects.st_material_expenses
           (tenant_id, project_id, external_job_id, external_po_id, total)
         VALUES ($1, $2, $3, 'segreto-po-1', $4)`,
        [TENANT_ID, segreto, jobId, segretoFixture.actuals.materialsExpense],
      );
    }
    await c.query(
      `INSERT INTO projects.st_financial_reconciliation
         (tenant_id, project_id, observed_at, lines, technicians, error)
       VALUES ($1, $2, now(), '[]'::jsonb, '[]'::jsonb, $3)`,
      [TENANT_ID, segreto, segretoReadNotes(segretoFixture)],
    );
    const st = segretoTiles.serviceTitan;
    await c.query(
      `INSERT INTO projects.st_project_summary
         (tenant_id, project_id, contract_value, total_budgeted_expense, change_orders,
          cost_adjustments, budgeted_labor_expense, budgeted_labor_hours, budgeted_materials,
          invoice_billed, open_invoices, retainage, estimates_read, invoices_read,
          materials_expense_read, labor_burden, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())`,
      [
        TENANT_ID,
        segreto,
        st.contractValue,
        st.totalBudgetedExpense,
        st.changeOrders,
        st.costAdjustments,
        st.budgetedLaborExpense,
        st.budgetedLaborHours,
        st.budgetedMaterials,
        st.billed,
        st.openInvoices,
        st.retainage,
        st.estimatesRead,
        st.invoicesRead,
        segretoFixture.actuals.materialsExpense != null,
        segretoFixture.actuals.laborBurden,
      ],
    );
  });
  log('project: Segreto (invoice actuals; contract, budget, and materials expense not returned)');

}
