import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ClaudeProject } from "../../../../types";
import type { DirectoryGroup, WorktreeGroup } from "../../../../utils/worktreeUtils";
import { GroupedProjectList } from "../GroupedProjectList";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: string | { defaultValue?: string; [name: string]: unknown }
    ) => {
      if (typeof options === "string") {
        return options;
      }
      return options?.defaultValue ?? key;
    },
  }),
}));

vi.mock("../ProjectItem", () => ({
  ProjectItem: ({
    project,
    onToggle,
    onClick,
  }: {
    project: ClaudeProject;
    onToggle: () => void;
    onClick: () => void;
  }) => (
    <div data-testid={`project-item-${project.path}`}>
      <button data-testid={`project-toggle-${project.path}`} onClick={onToggle} type="button">
        toggle
      </button>
      <button data-testid={`project-row-${project.path}`} onClick={onClick} type="button">
        row
      </button>
    </div>
  ),
}));

vi.mock("../SessionList", () => ({
  SessionList: () => <div data-testid="session-list" />,
}));

function createProject(path: string, name: string): ClaudeProject {
  return {
    name,
    path,
    actual_path: path,
    session_count: 1,
    message_count: 1,
    last_modified: "2026-02-21T00:00:00Z",
    provider: "claude",
  };
}

describe("GroupedProjectList", () => {
  function renderList(options: {
    groupingMode: "none" | "directory" | "worktree";
    project: ClaudeProject;
    handleProjectClick: ReturnType<typeof vi.fn>;
    projects?: ClaudeProject[];
    directoryGroups?: DirectoryGroup[];
    worktreeGroups?: WorktreeGroup[];
    expandedProjects?: Set<string>;
  }) {
    render(
      <GroupedProjectList
        groupingMode={options.groupingMode}
        projects={options.projects ?? [options.project]}
        directoryGroups={options.directoryGroups ?? []}
        worktreeGroups={options.worktreeGroups ?? []}
        sessions={[]}
        selectedProject={null}
        selectedSession={null}
        isLoading={false}
        expandedProjects={options.expandedProjects ?? new Set<string>()}
        setExpandedProjects={vi.fn()}
        isProjectExpanded={() => false}
        handleProjectClick={options.handleProjectClick}
        handleContextMenu={vi.fn()}
        onSessionSelect={vi.fn()}
        formatTimeAgo={(date) => date}
      />
    );
  }

  it("routes chevron toggle through project click handler in flat mode", () => {
    const project = createProject("/tmp/project-a", "project-a");
    const handleProjectClick = vi.fn();

    renderList({
      groupingMode: "none",
      project,
      handleProjectClick,
    });

    fireEvent.click(screen.getByTestId(`project-toggle-${project.path}`));

    expect(handleProjectClick).toHaveBeenCalledTimes(1);
    expect(handleProjectClick).toHaveBeenCalledWith(project);
  });

  it("routes chevron toggle through project click handler in directory mode", () => {
    const project = createProject("/tmp/project-a", "project-a");
    const handleProjectClick = vi.fn();
    const directoryGroup: DirectoryGroup = {
      name: "tmp",
      path: "/tmp",
      displayPath: "/tmp",
      projects: [project],
    };

    renderList({
      groupingMode: "directory",
      project,
      handleProjectClick,
      projects: [],
      directoryGroups: [directoryGroup],
      expandedProjects: new Set<string>([`dir:${directoryGroup.path}`]),
    });

    fireEvent.click(screen.getByTestId(`project-toggle-${project.path}`));

    expect(handleProjectClick).toHaveBeenCalledTimes(1);
    expect(handleProjectClick).toHaveBeenCalledWith(project);
  });

  it("routes chevron toggle through project click handler in worktree mode", () => {
    const project = createProject("/tmp/project-a", "project-a");
    const handleProjectClick = vi.fn();
    const worktreeGroup: WorktreeGroup = {
      parent: project,
      children: [],
    };

    renderList({
      groupingMode: "worktree",
      project,
      handleProjectClick,
      projects: [],
      worktreeGroups: [worktreeGroup],
      expandedProjects: new Set<string>([`group:${project.path}`]),
    });

    fireEvent.click(screen.getByTestId(`project-toggle-${project.path}`));

    expect(handleProjectClick).toHaveBeenCalledTimes(1);
    expect(handleProjectClick).toHaveBeenCalledWith(project);
  });

  it("keeps unavailable projects in a collapsed, expandable group", () => {
    const project = {
      ...createProject("/tmp/deleted-worktree", "deleted-worktree"),
      path_status: "unavailable" as const,
    };

    renderList({
      groupingMode: "none",
      project,
      expandedProjects: new Set<string>(),
    });

    expect(screen.getByTestId("unavailable-projects-group")).toBeInTheDocument();
    expect(
      screen.getByRole("treeitem", { name: /expand unavailable locations group/i })
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId(`project-item-${project.path}`)).not.toBeInTheDocument();
  });

  it("shows unavailable projects after expanding the status group", () => {
    const project = {
      ...createProject("/tmp/deleted-worktree", "deleted-worktree"),
      path_status: "unavailable" as const,
    };

    renderList({
      groupingMode: "none",
      project,
      expandedProjects: new Set<string>(["group:unavailable-projects"]),
    });

    expect(screen.getByTestId(`project-item-${project.path}`)).toBeInTheDocument();
  });
});

describe("GroupedProjectList multi-expand", () => {
  const emptyPage = {
    sessions: [],
    total: 0,
    offset: 0,
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
  };

  function renderExpanded(expanded: string[], selectedPath: string | null) {
    const a = createProject("/tmp/project-a", "project-a");
    const b = createProject("/tmp/project-b", "project-b");
    const expandedSet = new Set(expanded);
    render(
      <GroupedProjectList
        groupingMode="none"
        projects={[a, b]}
        directoryGroups={[]}
        worktreeGroups={[]}
        sessions={[]}
        sessionsByProject={{
          [a.path]: { ...emptyPage },
          [b.path]: { ...emptyPage },
        }}
        selectedProject={
          selectedPath ? [a, b].find((p) => p.path === selectedPath) ?? null : null
        }
        selectedSession={null}
        isLoading={false}
        expandedProjects={expandedSet}
        setExpandedProjects={vi.fn()}
        isProjectExpanded={(path) => expandedSet.has(path)}
        handleProjectClick={vi.fn()}
        handleContextMenu={vi.fn()}
        onSessionSelect={vi.fn()}
        formatTimeAgo={(date) => date}
      />
    );
    return { a, b };
  }

  it("shows a session list for every expanded project, not just the selected one", () => {
    renderExpanded(["/tmp/project-a", "/tmp/project-b"], "/tmp/project-a");
    expect(screen.getAllByTestId("session-list")).toHaveLength(2);
  });

  it("shows a session list for an expanded project even with nothing selected", () => {
    renderExpanded(["/tmp/project-b"], null);
    expect(screen.getAllByTestId("session-list")).toHaveLength(1);
  });

  it("shows no session list for a collapsed project", () => {
    renderExpanded([], "/tmp/project-a");
    expect(screen.queryAllByTestId("session-list")).toHaveLength(0);
  });
});
