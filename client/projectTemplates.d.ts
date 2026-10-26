export const projectTemplates: Record<
  string,
  { name: string; folder: string; sections: string[] }
>;

export function knownProjectFacts(project: Record<string, unknown> | null | undefined): string;

export function templateContent(
  key: string,
  project: Record<string, unknown> | null | undefined,
): string;
