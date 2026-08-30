// src/components/ProjectTree/types.ts
import type { ClaudeProject, ClaudeSession } from "../../types";
import type { GroupingMode } from "../../types/metadata.types";
import type { WorktreeGroup, DirectoryGroup } from "../../utils/worktreeUtils";
import type { Boundary } from "../../utils/contextMenu";

export interface ContextMenuState {
  project: ClaudeProject;
  position: { x: number; y: number; boundary?: Boundary | null };
}

export interface ProjectTreeProps {
  projects: ClaudeProject[];
  sessions: ClaudeSession[];
  sessionsTotal?: number;
  hasMoreSessions?: boolean;
  selectedProject: ClaudeProject | null;
  selectedSession: ClaudeSession | null;
  onProjectSelect: (project: ClaudeProject) => void;
  onSessionSelect: (session: ClaudeSession) => void;
  onSessionHover?: (session: ClaudeSession) => void;
  onLoadMoreSessions?: () => void;
  onGlobalStatsClick: () => void;
  isLoading: boolean;
  isLoadingMoreSessions?: boolean;
  isViewingGlobalStats: boolean;
  width?: number;
  isResizing?: boolean;
  onResizeStart?: (e: React.MouseEvent<HTMLElement>) => void;
  // Grouping props
  groupingMode?: GroupingMode;
  worktreeGroups?: WorktreeGroup[];
  directoryGroups?: DirectoryGroup[];
  ungroupedProjects?: ClaudeProject[];
  onGroupingModeChange?: (mode: GroupingMode) => void;
  // Project visibility props
  onHideProject?: (projectPath: string) => void;
  onUnhideProject?: (projectPath: string) => void;
  isProjectHidden?: (projectPath: string) => boolean;
  // Manual environment classification — the logs record no hostname, so a
  // second machine or a cloud runner can only be named by hand.
  onSetProjectEnvironmentLabel?: (projectPath: string, label: string) => void;
  onSetProjectRoutine?: (
    projectPath: string,
    routine: boolean | undefined
  ) => void;
  // Collapse props
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  asideId?: string;
  // Mobile drawer close callback
  onClose?: () => void;
}

export type GroupingStrategy = "none" | "directory" | "worktree";

export interface ProjectItemProps {
  project: ClaudeProject;
  isExpanded: boolean;
  isSelected: boolean;
  ariaLevel?: number;
  onToggle: () => void;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  variant?: "default" | "main" | "worktree";
  showProviderBadge?: boolean;
}

export interface SessionListProps {
  sessions: ClaudeSession[];
  sessionsTotal?: number;
  hasMoreSessions?: boolean;
  selectedSession: ClaudeSession | null;
  isLoading: boolean;
  isLoadingMoreSessions?: boolean;
  onSessionSelect: (session: ClaudeSession) => void;
  onSessionHover?: (session: ClaudeSession) => void;
  onLoadMoreSessions?: () => void;
  formatTimeAgo: (date: string) => string;
  variant?: "default" | "main" | "worktree";
  /**
   * Path of the project this list belongs to. Several lists can be on screen
   * at once, so multi-select — which can delete sessions — is confined to the
   * list it was started from.
   */
  selectionProjectPath?: string;
}

export interface GroupHeaderProps {
  groupKey: string;
  label: string;
  icon: React.ReactNode;
  count: number;
  isExpanded: boolean;
  ariaLevel?: number;
  onToggle: () => void;
  variant: "directory" | "worktree" | "unavailable";
}
