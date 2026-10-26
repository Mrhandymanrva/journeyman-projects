/**
 * Communications stays in the app and its records stay.
 * The nav hides it until the tab folds into the Updates feed.
 * Set this to true to put the tab back.
 */
export const SHOW_COMMUNICATIONS_TAB = false;

/** Hash for Precon & permits. Older links use the aliases and redirect here. */
export const PROJECT_PAGE_ID = "precon-permits";
export const PROJECT_PAGE_ALIASES = ["project", "project-details"];

/** Coordinator work first, then the rest of the project record. */
export const PROJECT_PAGE_ORDER = [
  "precon",
  "permits",
  "gates",
  "stagebar",
  "blockers",
  "project-facts",
];

export const LABOR_PAGE_ID = "financials";

export const PRECON_ROLE_NOTE =
  "The Project Coordinator owns preconstruction steps, permit steps, and Gate 2 approval. The Richmond GM leads the Richmond field team.";

export const workspacePages = {
  dashboard: ["Dashboard", "Your project, at a glance."],
  plan: [
    "Plan",
    "Scheduled work, crews, tasks, milestones and project reporting.",
  ],
  documents: ["Documents", "Project files, templates and working forms."],
  risks: ["Risks", "Identify, assess and manage project risks."],
  communications: [
    "Communications",
    "Updates, delivery logs and scheduled check-ins.",
  ],
  bids: [
    "Bids",
    "Request quotes and track subcontractor responses for this project.",
  ],
  resources: [
    "Resources",
    "Your company-wide subcontractors, technicians and trade crews.",
  ],
  financials: [
    "Financials",
    "Review budgets, purchase orders, change orders, draws, and labor.",
  ],
  logs: ["Daily logs", "Keep a clear record of work completed on site."],
  users: ["Users", "Manage staff access and login credentials."],
  settings: [
    "Setup",
    "Company settings for the labor cost code, QuickBooks cost-type accounts, and the subcontract agreement window.",
  ],
  [PROJECT_PAGE_ID]: [
    "Precon & permits",
    "Preconstruction steps, permit steps, and Gate 2 approval. The Project Coordinator owns this work. The Richmond GM leads the Richmond field team.",
  ],
  offices: [
    "Permit offices",
    "Municipality offices, contacts, and how to file.",
  ],
};

export function navEntries(showCommunications = SHOW_COMMUNICATIONS_TAB) {
  return Object.entries(workspacePages).filter(
    ([id]) => showCommunications || id !== "communications",
  );
}
