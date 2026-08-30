// src/components/ProjectTree/projectFilters.ts
/**
 * Filtering for the left pane's project list.
 *
 * The three grouping modes read three differently shaped inputs but must agree
 * on which projects exist, so the predicate is applied once, here, rather than
 * once per grouping mode — a filter that is added to only some of them looks
 * broken exactly when the user switches modes.
 */

import type { ClaudeProject } from "../../types";
import type { DirectoryGroup, WorktreeGroup } from "../../utils/worktreeUtils";
import {
  ALL_ENVIRONMENTS,
  getProjectEnvironment,
  isProjectRoutine,
  type ProjectMetadataMap,
} from "../../utils/projectEnvironment";

export interface EnvironmentFilterState {
  /** An environment id, or `ALL_ENVIRONMENTS` to accept every environment. */
  environment: string;
  /** Drop projects that count as automated/routine work. */
  hideRoutine: boolean;
  metadata: ProjectMetadataMap;
}

/** Whether a project survives the environment dropdown and the routine toggle. */
export function matchesEnvironmentFilters(
  project: ClaudeProject,
  { environment, hideRoutine, metadata }: EnvironmentFilterState
): boolean {
  if (hideRoutine && isProjectRoutine(project, metadata)) {
    return false;
  }

  if (environment === ALL_ENVIRONMENTS) {
    return true;
  }

  return getProjectEnvironment(project, metadata).id === environment;
}

export interface ProjectTreeFilterInput {
  projects: ClaudeProject[];
  directoryGroups: DirectoryGroup[];
  worktreeGroups: WorktreeGroup[];
  ungroupedProjects?: ClaudeProject[];
  /** The view filters: provider tabs, search text, environment, routine. */
  matches: (project: ClaudeProject) => boolean;
  /**
   * Per-project "hidden" exclusion. The store's group getters already drop
   * hidden projects, but the flat list is handed the raw project array, so
   * without this it kept showing what the other two modes had dropped.
   */
  isHidden?: (project: ClaudeProject) => boolean;
}

export interface FilteredProjectTree {
  projects: ClaudeProject[];
  directoryGroups: DirectoryGroup[];
  worktreeGroups: WorktreeGroup[];
  ungroupedProjects: ClaudeProject[];
}

/** Apply one predicate to all three grouping modes' inputs at once. */
export function filterProjectTree({
  projects,
  directoryGroups,
  worktreeGroups,
  ungroupedProjects,
  matches,
  isHidden,
}: ProjectTreeFilterInput): FilteredProjectTree {
  const keep = (project: ClaudeProject) =>
    !isHidden?.(project) && matches(project);

  const filteredDirectoryGroups = directoryGroups
    .map((group) => ({ ...group, projects: group.projects.filter(keep) }))
    .filter((group) => group.projects.length > 0);

  const nextWorktreeGroups: WorktreeGroup[] = [];
  const orphanedChildren: ClaudeProject[] = [];

  for (const group of worktreeGroups) {
    const matchingChildren = group.children.filter(keep);

    if (keep(group.parent)) {
      nextWorktreeGroups.push({ ...group, children: matchingChildren });
    } else if (matchingChildren.length > 0) {
      // The group's parent was filtered out but some worktrees survived, so
      // they move up rather than disappearing with their header.
      orphanedChildren.push(...matchingChildren);
    }
  }

  const baseUngrouped = (ungroupedProjects ?? projects).filter(keep);
  const seenPaths = new Set(baseUngrouped.map((project) => project.path));
  const rescuedChildren = orphanedChildren.filter((child) => {
    if (seenPaths.has(child.path)) {
      return false;
    }
    seenPaths.add(child.path);
    return true;
  });

  return {
    projects: projects.filter(keep),
    directoryGroups: filteredDirectoryGroups,
    worktreeGroups: nextWorktreeGroups,
    ungroupedProjects: [...baseUngrouped, ...rescuedChildren],
  };
}
