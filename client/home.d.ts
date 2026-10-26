export function landingChoice(input: {
  search?: string;
  hash?: string;
  rememberedProjectId?: string | null;
  projectPages?: string[];
}): { kind: "home" | "project"; projectId?: string };

export function revealLinkedItem(): void;

export function homeShellHtml(): string;

export function projectTableHtml(
  projects: Array<Record<string, unknown>>,
  esc: (value: unknown) => string,
): string;

export function dueListHtml(
  items: Array<Record<string, unknown>>,
  esc: (value: unknown) => string,
): string;
