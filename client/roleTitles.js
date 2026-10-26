/** Display titles. Role codes in the database stay as they are. */
export const ROLE_TITLES = {
  owner: "Owner",
  manager: "Richmond GM",
  project_manager: "Project Coordinator",
  estimator: "Estimator",
  office: "Office",
  bookkeeper: "Bookkeeper",
};

export function roleTitle(role) {
  const key = String(role ?? "").trim();
  if (!key) return "";
  return ROLE_TITLES[key] || key.replace(/_/g, " ");
}
