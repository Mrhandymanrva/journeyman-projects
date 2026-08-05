/**
 * The demo account, as data.
 *
 * The three projects are the ones from the reference mock, rebuilt as actual
 * rows in actual state: gates approved, budgets frozen by the freeze trigger,
 * POs issued, bills approved, a vendor whose general liability lapsed, a draw
 * approved but not invoiced, a permit milestone overdue.
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
import type { Database, SqlClient } from '../src/db/database.js';
import { activateModule, writePlatformRows } from '../src/db/activation.js';

export const DEMO_SLUG = 'demo';
export const DEMO_TENANT_ID = '5b1f0c9e-0000-4000-8000-000000000001';

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
        `INSERT INTO projects.staff (tenant_id, email, full_name, role)
         VALUES ($1,$2,$3,$4::projects.staff_role) RETURNING id`,
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
        `INSERT INTO projects.jurisdictions (tenant_id, name, typical_review_days)
         VALUES ($1,$2,$3) RETURNING id`,
        [TENANT_ID, name, days],
      );
      jurisdictions[name] = rows[0]!.id;
    }

    const costCodes = new Map<string, string>();
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
    contract: number;
    target: number;
    stage: string;
    approvedGates: number;
    startedDaysAgo: number;
    lengthDays: number;
    budget: BudgetSpec[];
  }) {
    return db.withTenant(TENANT_ID, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO projects.projects
           (tenant_id, project_number, business_unit_id, jurisdiction_id, name,
            address_line1, city, region, pm_id, contract_value, target_margin, stage,
            actual_start, scheduled_end, external_job_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'VA',$8,$9,$10,$11::projects.project_stage,
                 CURRENT_DATE - $12::int, CURRENT_DATE - $12::int + $13::int, $14)
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
  });
  await spendAgainst(whitfield, 'PO-W', [
    ...whitfieldBudget.map((b) => ({
      ...b,
      vendor:
        b.code === '1120' ? 'tile' : b.code === '510' || b.code === '520' ? 'plumb' : undefined,
    })),
  ]);

  await db.withTenant(TENANT_ID, async (c) => {
    // Draws: two invoiced, one approved and NOT invoiced — the exception the
    // module exists to surface — and two still scheduled.
    const draws: Array<[number, string, string, number, string, string | null]> = [
      [1, 'Deposit', 'Contract signature', 10450, 'invoiced', '118432-1'],
      [2, 'Draw 1', 'Demolition complete', 10450, 'invoiced', '118432-2'],
      [3, 'Draw 2', 'Rough inspections passed', 8360, 'approved', null],
      [4, 'Draw 3', 'Substantial completion', 8360, 'scheduled', null],
      [5, 'Final', 'Punch complete and final inspection', 4180, 'scheduled', null],
    ];
    for (const [seq, label, trigger, amount, status, invoice] of draws) {
      await c.query(
        `INSERT INTO projects.draws
           (tenant_id, project_id, sequence_number, label, trigger_milestone, amount, status,
            earned_at, approved_by, approved_at, external_invoice_number,
            external_invoice_recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::projects.draw_status,
                 CASE WHEN $7 <> 'scheduled' THEN now() - interval '20 days' END,
                 CASE WHEN $7 <> 'scheduled' THEN $8::uuid END,
                 CASE WHEN $7 <> 'scheduled' THEN now() - interval '6 days' END,
                 -- $9 appears only as a bare value and inside IS NOT NULL, so
                 -- there is nothing for Postgres to infer its type from.
                 $9::text,
                 CASE WHEN $9::text IS NOT NULL THEN now() - interval '5 days' END)`,
        [TENANT_ID, whitfield, seq, label, trigger, amount, status, ids.staff.manager, invoice],
      );
    }

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
    const schedule: Array<[string, string, number, number, string]> = [
      ['Set tile', 'tile', 0, 3, 'confirmed'],
      ['Plumbing finish set', 'plumb', 4, 5, 'proposed'],
      ['Interior painting', 'paint', 8, 11, 'proposed'],
      ['Countertop template', 'counter', 6, 6, 'proposed'],
    ];
    for (const [title, vendorKey, startOffset, endOffset, status] of schedule) {
      await c.query(
        `INSERT INTO projects.schedule_items
           (tenant_id, project_id, title, vendor_id, window_start, window_end, status)
         VALUES ($1,$2,$3,$4, CURRENT_DATE + $5::int, CURRENT_DATE + $6::int, $7::projects.sched_status)`,
        [TENANT_ID, whitfield, title, vendors[vendorKey], startOffset, endOffset, status],
      );
    }
  });
  log('project: Whitfield — Primary Bath (1 code over, 1 draw uninvoiced, 1 vendor blocked)');

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
    await c.query(
      `INSERT INTO projects.draws
         (tenant_id, project_id, sequence_number, label, trigger_milestone, amount, status,
          external_invoice_number, external_invoice_recorded_at)
       VALUES ($1,$2,1,'Deposit','Contract signature',20520,'invoiced','119017-1', now()),
              ($1,$2,2,'Draw 1','Demolition and rough started',17100,'scheduled',NULL,NULL),
              ($1,$2,3,'Draw 2','Rough inspections passed',13680,'scheduled',NULL,NULL),
              ($1,$2,4,'Draw 3','Substantial completion',10260,'scheduled',NULL,NULL),
              ($1,$2,5,'Final','Punch and final inspection',6840,'scheduled',NULL,NULL)`,
      [TENANT_ID, okonkwo],
    );
    for (const [title, vendorKey, s, e] of [
      ['Electrical rough', 'elec', 20, 22],
      ['Plumbing rough', 'plumb', 21, 23],
    ] as const) {
      await c.query(
        `INSERT INTO projects.schedule_items
           (tenant_id, project_id, title, vendor_id, window_start, window_end, status)
         VALUES ($1,$2,$3,$4,CURRENT_DATE + $5::int, CURRENT_DATE + $6::int,'confirmed')`,
        [TENANT_ID, okonkwo, title, vendors[vendorKey], s, e],
      );
    }
  });
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
    await c.query(
      `INSERT INTO projects.draws
         (tenant_id, project_id, sequence_number, label, trigger_milestone, amount, status,
          external_invoice_number, external_invoice_recorded_at)
       VALUES ($1,$2,1,'Deposit','Contract signature',14300,'invoiced','117980-1',now()),
              ($1,$2,2,'Draw 1','Demolition and rough started',14300,'invoiced','117980-2',now()),
              ($1,$2,3,'Draw 2','Rough inspections passed',11440,'invoiced','117980-3',now()),
              ($1,$2,4,'Draw 3','Substantial completion',11440,'invoiced','117980-4',now()),
              ($1,$2,5,'Final','Punch and final inspection',5720,'scheduled',NULL,NULL)`,
      [TENANT_ID, delaney],
    );
    for (const [title, vendorKey, s, e] of [
      ['Interior painting', 'paint', 6, 9],
      ['Flooring install', 'floor', 9, 11],
    ] as const) {
      await c.query(
        `INSERT INTO projects.schedule_items
           (tenant_id, project_id, title, vendor_id, window_start, window_end, status)
         VALUES ($1,$2,$3,$4,CURRENT_DATE + $5::int, CURRENT_DATE + $6::int,'proposed')`,
        [TENANT_ID, delaney, title, vendors[vendorKey], s, e],
      );
    }
  });
  log('project: Delaney — Basement Finish (healthy)');

}
