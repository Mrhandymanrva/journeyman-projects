/**
 * Blanton-shaped appointment window used by the committed-labor tests and
 * the demo Financials page.
 *
 * 40 stored appointments, 36 Scheduled and 4 Done, from Oct 29 through
 * Nov 25, 2026. The project that holds them has a null business unit.
 * Job 260260 is completed and invoiced, so its four Done visits are actuals
 * only. Jobs 261001 and 261002 stay committed. 261002 has Labor revenue
 * (MHM.25PLFE). 261001 does not, so its revenue is estimated.
 */

import {
  isWeekendDate,
  zonedLocalToUtc,
  type CommittedTechnician,
} from "../domain/committedLabor.js";

export const BLANTON_WINDOW_START = "2026-10-29";
export const BLANTON_WINDOW_END = "2026-11-25";
export const BLANTON_OPEN_JOB = "261001";
export const BLANTON_PRICED_JOB = "261002";
export const BLANTON_CLOSED_JOB = "260260";
export const BLANTON_CASEY = { id: "tech-casey", name: "Casey Nguyen" };
export const BLANTON_RILEY = { id: "tech-riley", name: "Riley Cho" };

export interface BlantonAppointmentRow {
  externalJobId: string;
  externalAppointmentId: string;
  jobNumber: string;
  appointmentNumber: string;
  jobStatus: string;
  startsAt: string;
  endsAt: string;
  status: "Scheduled" | "Done";
  technicians: CommittedTechnician[];
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function civilDays(start: string, end: string): string[] {
  const days: string[] = [];
  const [year, month, day] = start.split("-").map(Number);
  let cursor = new Date(Date.UTC(year!, month! - 1, day!, 12));
  for (let guard = 0; guard < 400; guard += 1) {
    const key = `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-${pad(cursor.getUTCDate())}`;
    days.push(key);
    if (key === end) break;
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return days;
}

export function blantonWeekdays(): string[] {
  return civilDays(BLANTON_WINDOW_START, BLANTON_WINDOW_END).filter((day) => !isWeekendDate(day));
}

function at(day: string, hour: number, minute: number): string {
  return zonedLocalToUtc(day, hour, minute);
}

function row(
  jobId: string,
  jobNumber: string,
  jobStatus: string,
  appointmentId: string,
  appointmentNumber: string,
  status: "Scheduled" | "Done",
  start: string,
  end: string,
  technicians: CommittedTechnician[],
): BlantonAppointmentRow {
  return {
    externalJobId: jobId,
    externalAppointmentId: appointmentId,
    jobNumber,
    appointmentNumber,
    jobStatus,
    startsAt: start,
    endsAt: end,
    status,
    technicians,
  };
}

/**
 * 30 scheduled visits on 261001 (Casey, 8:00–12:00), 6 scheduled visits on
 * 261002 (one multi-day, one with no technician, four single days), and
 * 4 Done visits on completed job 260260.
 */
export function blantonCommittedAppointments(): BlantonAppointmentRow[] {
  const weekdays = blantonWeekdays();
  const rows: BlantonAppointmentRow[] = [];
  let openCount = 0;
  for (const day of weekdays) {
    const second = openCount < 10;
    rows.push(
      row(
        BLANTON_OPEN_JOB,
        "261001",
        "Scheduled",
        `open-${day}-am`,
        String(rows.length + 1),
        "Scheduled",
        at(day, second ? 7 : 8, 0),
        at(day, second ? 11 : 12, 0),
        [BLANTON_CASEY],
      ),
    );
    openCount += 1;
    if (second) {
      rows.push(
        row(
          BLANTON_OPEN_JOB,
          "261001",
          "Scheduled",
          `open-${day}-pm`,
          String(rows.length + 1),
          "Scheduled",
          at(day, 11, 0),
          at(day, 15, 0),
          [BLANTON_CASEY],
        ),
      );
    }
  }

  const monday = weekdays.find((day) => day === "2026-11-02");
  const wednesday = weekdays.find((day) => day === "2026-11-04");
  if (!monday || !wednesday) throw new Error("Blanton window is missing Nov 2–4.");
  rows.push(
    row(
      BLANTON_PRICED_JOB,
      "261002",
      "InProgress",
      "priced-span",
      "1",
      "Scheduled",
      at(monday, 8, 0),
      at(wednesday, 12, 0),
      [BLANTON_CASEY, BLANTON_RILEY],
    ),
  );
  rows.push(
    row(
      BLANTON_PRICED_JOB,
      "261002",
      "InProgress",
      "priced-open",
      "2",
      "Scheduled",
      at("2026-11-06", 8, 0),
      at("2026-11-06", 12, 0),
      [],
    ),
  );
  for (const day of ["2026-11-09", "2026-11-10", "2026-11-12", "2026-11-13"]) {
    rows.push(
      row(
        BLANTON_PRICED_JOB,
        "261002",
        "InProgress",
        `priced-${day}`,
        String(rows.length),
        "Scheduled",
        at(day, 8, 0),
        at(day, 12, 0),
        [BLANTON_CASEY],
      ),
    );
  }

  for (const day of ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]) {
    rows.push(
      row(
        BLANTON_CLOSED_JOB,
        "260260",
        "Completed",
        `closed-${day}`,
        String(rows.length),
        "Done",
        at(day, 8, 0),
        at(day, 12, 0),
        [BLANTON_CASEY],
      ),
    );
  }

  return rows;
}
