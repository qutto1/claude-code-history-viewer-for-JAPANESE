/**
 * Where a project's work actually ran.
 *
 * Nothing in the history files records a hostname, so the only automatic
 * signal is the project's dominant `entrypoint` (see `./entrypoint.ts`). That
 * answers "desktop / CLI / VS Code / headless SDK" and nothing more, which is
 * why a hand-written label always wins: a second machine or a cloud runner can
 * only be named by the user.
 *
 * The same asymmetry drives "routine" work. A headless SDK run has nobody at
 * the keyboard, so `sdk` is the automatic guess, and an explicit override —
 * including an explicit "no" — replaces it.
 */

import type { ClaudeProject, ProjectMetadata } from "../types";
import {
  ENTRYPOINT_FILTER_LABEL_KEYS,
  ENTRYPOINT_FILTER_OPTIONS,
  normalizeEntrypoint,
  type EntrypointCategory,
} from "./entrypoint";

/** Environment filter value that lets every project through. */
export const ALL_ENVIRONMENTS = "all";

/**
 * Prefix marking an id as a hand-written label, so a project labelled "sdk"
 * cannot collide with the automatic `sdk` category.
 */
const MANUAL_ID_PREFIX = "label:";

/** Id used by projects whose entrypoint says nothing. */
const UNKNOWN_ENVIRONMENT_ID = "unknown";

/** Project metadata keyed by project path, as held in `userMetadata.projects`. */
export type ProjectMetadataMap = Record<string, ProjectMetadata>;

/** How a single project's environment was decided. */
export interface ProjectEnvironment {
  /** Stable id, usable as a dropdown value. */
  id: string;
  source: "manual" | "auto" | "unknown";
  /** Set when `source` is "auto". */
  category?: EntrypointCategory;
  /** Set when `source` is "manual". */
  label?: string;
}

/** The automatic categories, in the order the source filter already lists them. */
const CATEGORY_ORDER = ENTRYPOINT_FILTER_OPTIONS.filter(
  (option): option is EntrypointCategory => option !== ALL_ENVIRONMENTS
);

/**
 * Key a project's metadata is stored under. Hiding, aliasing and the
 * environment overrides all address a project by its real location.
 */
export function getProjectMetadataKey(project: ClaudeProject): string {
  return project.actual_path || project.path;
}

/**
 * The environment the entrypoint alone implies, ignoring any manual label.
 * The override UI shows this as the placeholder, so the user can see what they
 * are about to replace.
 */
export function getAutomaticEnvironment(
  project: ClaudeProject
): ProjectEnvironment {
  const category = normalizeEntrypoint(project.entrypoint);
  if (category) {
    return { id: category, source: "auto", category };
  }

  return { id: UNKNOWN_ENVIRONMENT_ID, source: "unknown" };
}

/** Resolve a project's environment: the hand-written label first, then the entrypoint. */
export function getProjectEnvironment(
  project: ClaudeProject,
  metadata: ProjectMetadataMap
): ProjectEnvironment {
  const label = metadata[getProjectMetadataKey(project)]?.environmentLabel?.trim();
  if (label) {
    return { id: `${MANUAL_ID_PREFIX}${label}`, source: "manual", label };
  }

  return getAutomaticEnvironment(project);
}

/** English fallbacks, for the same reason every other `t()` call carries one. */
const CATEGORY_FALLBACKS: Record<EntrypointCategory, string> = {
  cli: "CLI",
  sdk: "SDK",
  vscode: "VS Code",
  desktop: "Desktop",
};

/** Human-readable name for an environment, translated where it is not user-written. */
export function describeEnvironment(
  environment: ProjectEnvironment,
  translate: (key: string, fallback: string) => string
): string {
  if (environment.source === "manual") {
    return environment.label ?? "";
  }

  if (environment.category) {
    return translate(
      ENTRYPOINT_FILTER_LABEL_KEYS[environment.category],
      CATEGORY_FALLBACKS[environment.category]
    );
  }

  return translate("project.environment.unknown", "Unspecified");
}

/**
 * Whether a project counts as automated/routine work. Shared by the store and
 * the project list so both answer the question the same way.
 */
export function resolveProjectRoutine(
  override: boolean | undefined,
  entrypoint: string | null | undefined
): boolean {
  if (override !== undefined) {
    return override;
  }

  return normalizeEntrypoint(entrypoint) === "sdk";
}

/** `resolveProjectRoutine` for a project whose metadata is at hand. */
export function isProjectRoutine(
  project: ClaudeProject,
  metadata: ProjectMetadataMap
): boolean {
  return resolveProjectRoutine(
    metadata[getProjectMetadataKey(project)]?.routine,
    project.entrypoint
  );
}

/**
 * Every environment present in the given projects, deduplicated. The dropdown
 * offers exactly what the loaded history contains — there is no fixed list,
 * because a hand-written label can name anything.
 */
export function collectProjectEnvironments(
  projects: ClaudeProject[],
  metadata: ProjectMetadataMap
): ProjectEnvironment[] {
  const byId = new Map<string, ProjectEnvironment>();

  for (const project of projects) {
    const environment = getProjectEnvironment(project, metadata);
    if (!byId.has(environment.id)) {
      byId.set(environment.id, environment);
    }
  }

  // Automatic categories in their canonical order, then hand-written labels
  // alphabetically, then whatever could not be placed at all.
  const ordered: ProjectEnvironment[] = [];

  for (const category of CATEGORY_ORDER) {
    const environment = byId.get(category);
    if (environment) {
      ordered.push(environment);
    }
  }

  ordered.push(
    ...[...byId.values()]
      .filter((environment) => environment.source === "manual")
      .sort((a, b) => (a.label ?? "").localeCompare(b.label ?? ""))
  );

  const unknown = byId.get(UNKNOWN_ENVIRONMENT_ID);
  if (unknown) {
    ordered.push(unknown);
  }

  return ordered;
}
