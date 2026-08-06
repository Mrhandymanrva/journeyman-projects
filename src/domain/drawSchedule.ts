import type { SqlClient } from '../db/database.js';

export interface SeededDraw {
  sequence_number: number;
  label: string;
  trigger_milestone: string;
  amount: number;
  is_retainage: boolean;
}

/**
 * Builds a draw schedule from the tenant's template against a contract value.
 *
 * The last draw takes the remainder rather than its own percentage. 30/30/30/10
 * of 41,800 divides exactly, but 30/30/30/10 of 41,833.33 does not, and three
 * rounded instalments plus a rounded retainage can miss the contract by a cent.
 * A statement that is a penny out is a statement somebody has to explain, so
 * the arithmetic is arranged to make that impossible rather than unlikely.
 *
 * Percentages are of the ORIGINAL contract value. An approved change order is
 * invoiced separately and does not reopen this schedule — Mason, August 2026.
 */
export function buildDrawSchedule(
  templates: Array<{
    sequence_number: number;
    label: string;
    trigger_milestone: string;
    percentage: number;
    is_retainage: boolean;
  }>,
  contractValue: number,
): SeededDraw[] {
  const ordered = [...templates].sort((a, b) => a.sequence_number - b.sequence_number);
  if (ordered.length === 0) return [];

  const draws: SeededDraw[] = [];
  let allocated = 0;

  ordered.forEach((template, index) => {
    const isLast = index === ordered.length - 1;
    const amount = isLast
      ? round2(contractValue - allocated)
      : round2(contractValue * template.percentage);
    allocated = round2(allocated + amount);

    draws.push({
      sequence_number: template.sequence_number,
      label: template.label,
      trigger_milestone: template.trigger_milestone,
      amount,
      is_retainage: template.is_retainage,
    });
  });

  // A draw of zero or less would violate the amount > 0 check on the table,
  // and it means the template does not describe this contract. Better to seed
  // nothing than to seed something that has to be deleted.
  return draws.every((d) => d.amount > 0) ? draws : [];
}

export async function seedDrawSchedule(
  db: SqlClient,
  tenantId: string,
  projectId: string,
  contractValue: number,
): Promise<number> {
  const templates = await db.query<{
    sequence_number: number;
    label: string;
    trigger_milestone: string;
    percentage: string;
    is_retainage: boolean;
  }>(
    `SELECT sequence_number, label, trigger_milestone, percentage, is_retainage
       FROM projects.draw_templates WHERE tenant_id = $1 ORDER BY sequence_number`,
    [tenantId],
  );

  const schedule = buildDrawSchedule(
    templates.rows.map((t) => ({ ...t, percentage: Number(t.percentage) })),
    contractValue,
  );

  for (const draw of schedule) {
    await db.query(
      `INSERT INTO projects.draws
         (tenant_id, project_id, sequence_number, label, trigger_milestone, amount, is_retainage)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        tenantId,
        projectId,
        draw.sequence_number,
        draw.label,
        draw.trigger_milestone,
        draw.amount,
        draw.is_retainage,
      ],
    );
  }
  return schedule.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
