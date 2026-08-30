import { describe, expect, it } from "vitest";
import type { ClaudeProject, ProjectMetadata } from "../../../../types";
import type { DirectoryGroup, WorktreeGroup } from "../../../../utils/worktreeUtils";
import {
  ALL_ENVIRONMENTS,
  collectProjectEnvironments,
  getProjectEnvironment,
  isProjectRoutine,
} from "../../../../utils/projectEnvironment";
import {
  filterProjectTree,
  matchesEnvironmentFilters,
} from "../../projectFilters";

function createProject(
  path: string,
  entrypoint?: string
): ClaudeProject {
  return {
    name: path.split("/").pop() ?? path,
    path,
    actual_path: path,
    session_count: 1,
    message_count: 1,
    last_modified: "2026-08-30T00:00:00Z",
    provider: "claude",
    entrypoint,
  };
}

const desktopProject = createProject("/repo/desktop-app", "claude-desktop");
const routineProject = createProject("/repo/nightly-batch", "sdk-cli");
const cliProject = createProject("/repo/cli-tool", "cli");

const noMetadata: Record<string, ProjectMetadata> = {};

/** Run one predicate through all three grouping modes' inputs. */
function filterAllModes(
  projects: ClaudeProject[],
  matches: (project: ClaudeProject) => boolean,
  isHidden?: (project: ClaudeProject) => boolean
) {
  const directoryGroups: DirectoryGroup[] = [
    {
      name: "repo",
      path: "/repo",
      displayPath: "/repo",
      projects,
    },
  ];
  const worktreeGroups: WorktreeGroup[] = [
    {
      parent: projects[0]!,
      children: projects.slice(1),
    },
  ];

  const flat = filterProjectTree({
    projects,
    directoryGroups: [],
    worktreeGroups: [],
    matches,
    isHidden,
  });
  const directory = filterProjectTree({
    projects,
    directoryGroups,
    worktreeGroups: [],
    matches,
    isHidden,
  });
  const worktree = filterProjectTree({
    projects,
    directoryGroups: [],
    worktreeGroups,
    ungroupedProjects: [],
    matches,
    isHidden,
  });

  return {
    none: flat.projects.map((project) => project.path),
    directory: directory.directoryGroups.flatMap((group) =>
      group.projects.map((project) => project.path)
    ),
    worktree: worktree.worktreeGroups.flatMap((group) => [
      group.parent.path,
      ...group.children.map((child) => child.path),
    ]),
  };
}

describe("project environment classification", () => {
  it("derives the environment from the entrypoint when nothing was set by hand", () => {
    expect(getProjectEnvironment(desktopProject, noMetadata)).toMatchObject({
      id: "desktop",
      source: "auto",
    });
    expect(getProjectEnvironment(routineProject, noMetadata)).toMatchObject({
      id: "sdk",
      source: "auto",
    });
  });

  it("falls back to an unknown environment when no entrypoint was recorded", () => {
    expect(
      getProjectEnvironment(createProject("/repo/legacy"), noMetadata)
    ).toMatchObject({ id: "unknown", source: "unknown" });
  });

  it("lets a hand-written label beat the automatic classification", () => {
    const metadata = {
      [routineProject.actual_path]: { environmentLabel: " cloud runner " },
    };

    expect(getProjectEnvironment(routineProject, metadata)).toMatchObject({
      id: "label:cloud runner",
      source: "manual",
      label: "cloud runner",
    });
  });

  it("classifies headless SDK runs as routine and interactive work as not", () => {
    expect(isProjectRoutine(routineProject, noMetadata)).toBe(true);
    expect(isProjectRoutine(desktopProject, noMetadata)).toBe(false);
  });

  it("lets a manual routine override beat the automatic classification both ways", () => {
    expect(
      isProjectRoutine(routineProject, {
        [routineProject.actual_path]: { routine: false },
      })
    ).toBe(false);
    expect(
      isProjectRoutine(desktopProject, {
        [desktopProject.actual_path]: { routine: true },
      })
    ).toBe(true);
  });

  it("offers only the environments the loaded projects actually contain", () => {
    const options = collectProjectEnvironments(
      [desktopProject, routineProject, cliProject, createProject("/repo/legacy")],
      { [cliProject.actual_path]: { environmentLabel: "work laptop" } }
    );

    expect(options.map((option) => option.id)).toEqual([
      "sdk",
      "desktop",
      "label:work laptop",
      "unknown",
    ]);
  });
});

describe("environment and routine filters", () => {
  const projects = [desktopProject, routineProject, cliProject];

  it("hides routine projects in every grouping mode when the toggle is on", () => {
    const result = filterAllModes(projects, (project) =>
      matchesEnvironmentFilters(project, {
        environment: ALL_ENVIRONMENTS,
        hideRoutine: true,
        metadata: noMetadata,
      })
    );

    for (const mode of ["none", "directory", "worktree"] as const) {
      expect(result[mode]).not.toContain(routineProject.path);
      expect(result[mode]).toContain(desktopProject.path);
    }
  });

  it("keeps routine projects while the toggle is off", () => {
    const result = filterAllModes(projects, (project) =>
      matchesEnvironmentFilters(project, {
        environment: ALL_ENVIRONMENTS,
        hideRoutine: false,
        metadata: noMetadata,
      })
    );

    expect(result.none).toContain(routineProject.path);
    expect(result.directory).toContain(routineProject.path);
    expect(result.worktree).toContain(routineProject.path);
  });

  it("keeps a project the user marked as not routine", () => {
    const metadata = {
      [routineProject.actual_path]: { routine: false },
    };
    const result = filterAllModes(projects, (project) =>
      matchesEnvironmentFilters(project, {
        environment: ALL_ENVIRONMENTS,
        hideRoutine: true,
        metadata,
      })
    );

    expect(result.none).toContain(routineProject.path);
    expect(result.directory).toContain(routineProject.path);
    expect(result.worktree).toContain(routineProject.path);
  });

  it("narrows the list to one environment in every grouping mode", () => {
    const result = filterAllModes(projects, (project) =>
      matchesEnvironmentFilters(project, {
        environment: "desktop",
        hideRoutine: false,
        metadata: noMetadata,
      })
    );

    expect(result.none).toEqual([desktopProject.path]);
    expect(result.directory).toEqual([desktopProject.path]);
    expect(result.worktree).toEqual([desktopProject.path]);
  });

  it("files a project under its manual label rather than its entrypoint", () => {
    const metadata = {
      [routineProject.actual_path]: { environmentLabel: "cloud runner" },
    };

    expect(
      matchesEnvironmentFilters(routineProject, {
        environment: "label:cloud runner",
        hideRoutine: false,
        metadata,
      })
    ).toBe(true);
    expect(
      matchesEnvironmentFilters(routineProject, {
        environment: "sdk",
        hideRoutine: false,
        metadata,
      })
    ).toBe(false);
  });
});

describe("filterProjectTree", () => {
  it("excludes hidden projects from the flat list too", () => {
    const result = filterAllModes(
      [desktopProject, routineProject, cliProject],
      () => true,
      (project) => project.path === cliProject.path
    );

    expect(result.none).not.toContain(cliProject.path);
    expect(result.directory).not.toContain(cliProject.path);
    expect(result.worktree).not.toContain(cliProject.path);
  });

  it("rescues surviving worktrees whose parent was filtered out", () => {
    const parent = createProject("/repo/main", "claude-desktop");
    const child = createProject("/repo/main-feature", "claude-desktop");

    const result = filterProjectTree({
      projects: [parent, child],
      directoryGroups: [],
      worktreeGroups: [{ parent, children: [child] }],
      ungroupedProjects: [],
      matches: (project) => project.path === child.path,
    });

    expect(result.worktreeGroups).toHaveLength(0);
    expect(result.ungroupedProjects.map((project) => project.path)).toEqual([
      child.path,
    ]);
  });
});
