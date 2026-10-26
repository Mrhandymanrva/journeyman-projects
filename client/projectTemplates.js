export const projectTemplates = {
  charter: {
    name: "Project charter",
    folder: "charter_scope",
    sections: [
      "Project purpose and customer expectations",
      "Scope included",
      "Scope excluded",
      "Deliverables and acceptance criteria",
      "Project sponsor and decision makers",
      "Project manager and trade leads",
      "Target milestones and completion date",
      "Budget authorization and contingency",
      "Assumptions and constraints",
      "Top risks and permit requirements",
      "Communication and escalation plan",
      "Approval names, dates and references",
    ],
  },
  change_request: {
    name: "Change request / order worksheet",
    folder: "contracts_changes",
    sections: [
      "Change request number and date",
      "Customer and project reference",
      "Requested by",
      "Reason for change",
      "Original scope affected",
      "Proposed scope and drawings",
      "Labor, materials and subcontractor cost breakdown",
      "Price adjustment and tax assumptions",
      "Schedule impact and dependencies",
      "Permits, inspections and risk impacts",
      "Customer decision and approval reference",
      "Approved change order reference (record approval in Financials)",
    ],
  },
  scope: {
    name: "Scope of work",
    folder: "charter_scope",
    sections: [
      "Work area and existing conditions",
      "Demolition and protection",
      "Trade-by-trade work breakdown",
      "Materials and selections",
      "Allowances and exclusions",
      "Permits and inspections",
      "Quality standards and acceptance",
      "Cleanup, closeout and warranty handoff",
    ],
  },
  weekly_status: {
    name: "Weekly project update",
    folder: "reports",
    sections: [
      "Reporting period",
      "Overall RAG status and reason",
      "Work completed",
      "Next two weeks",
      "Schedule and milestone changes",
      "Budget, changes and reserves",
      "Open risks and decisions needed",
      "Owner actions and due dates",
    ],
  },
  site_check: {
    name: "Site check-in / inspection",
    folder: "reports",
    sections: [
      "Visit date and attendees",
      "Work observed by trade",
      "Safety and site protection observations",
      "Quality checks and photos",
      "Inspection and permit status",
      "Deficiencies, responsible person and due dates",
      "Decisions and next check-in",
    ],
  },
  closeout: {
    name: "Project closeout checklist",
    folder: "closeout",
    sections: [
      "Final walkthrough date and attendees",
      "Punch-list items and completion evidence",
      "Final inspection approvals",
      "Warranties, manuals and as-built drawings",
      "Customer training and handoff",
      "Financial closeout reference in ServiceTitan",
      "Customer acceptance reference",
      "Lessons learned and follow-up",
    ],
  },
  communication: {
    name: "Communication plan",
    folder: "reports",
    sections: [
      "Stakeholders and contacts",
      "Regular updates: audience, owner, channel and cadence",
      "Site check-ins and trade coordination",
      "Decisions and approval turnaround expectations",
      "Urgent issues and escalation contacts",
      "Document storage and distribution",
      "Meeting agenda and action tracking",
    ],
  },
  risk_review: {
    name: "Risk review",
    folder: "reports",
    sections: [
      "Review date and attendees",
      "New and changed risks",
      "Probability and impact assessment",
      "ROAM: Resolved, Owned, Accepted or Mitigated",
      "Mitigation actions and due dates",
      "Contingency triggers and reserve requirements",
      "Decisions and next review date",
    ],
  },
};
function text(value) {
  return value == null ? "" : String(value).trim();
}

function dayText(value) {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function money(value) {
  if (value === null || value === undefined || value === "") return "";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function estimateText(project) {
  if (Array.isArray(project.sold_estimates) && project.sold_estimates.length) {
    return project.sold_estimates
      .map((row) =>
        [text(row.name), money(row.customer_amount)].filter(Boolean).join(" · "),
      )
      .filter(Boolean)
      .join("; ");
  }
  return money(project.estimate_amount);
}

function permitText(project) {
  const rows = Array.isArray(project.permit_summary) ? project.permit_summary : [];
  return rows
    .map((permit) => {
      const status = permit.not_required
        ? "not required"
        : permit.issued_on
          ? "issued " + dayText(permit.issued_on)
          : "not issued";
      return [text(permit.permit_type), text(permit.permit_number), status]
        .filter(Boolean)
        .join(" · ");
    })
    .join("; ");
}

/** Facts the project already has. Unknown values stay blank. Sections are not removed. */
export function knownProjectFacts(project) {
  const p = project ?? {};
  const address = [p.address_line1, p.city, p.region, p.postal_code]
    .map(text)
    .filter(Boolean)
    .join(", ");
  return [
    ["Customer", text(p.source_customer_name)],
    ["Service address", address],
    ["Contract amount", money(p.contract_value)],
    ["Estimate amount", estimateText(p)],
    ["Logged start", dayText(p.scheduled_start)],
    ["Field start", dayText(p.field_start?.date)],
    ["Target completion", dayText(p.scheduled_end)],
    ["Actual start", dayText(p.actual_start)],
    ["Permits", permitText(p)],
  ]
    .map(([label, value]) => `- ${label}: ${value}`)
    .join("\n");
}

export const templateContent = (key, project) => {
  const template = projectTemplates[key];
  return `# ${template.name}\n\nProject: ${project?.project_number ?? ""} — ${project?.name ?? ""}\n\n## Known from this project\n\n${knownProjectFacts(project)}\n\n${template.sections.map((s) => "## " + s + "\n\n").join("\n")}\nDraft working document. Record required approvals through the project approval workflow.\n`;
};
