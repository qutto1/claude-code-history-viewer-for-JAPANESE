/**
 * Tests for the per-project execution-environment metadata.
 *
 * Projects are classified automatically from their dominant entrypoint;
 * these cover the hand-set override that the user can put on top of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/useAppStore";
import type { UserMetadata } from "../types";

const mockInvoke = vi.fn();
vi.mock("@/services/api", () => ({
  api: (...args: unknown[]) => mockInvoke(...args),
}));

const emptyMetadata = (): UserMetadata => ({
  version: 1,
  sessions: {},
  projects: {},
  settings: {},
});

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(emptyMetadata());
  useAppStore.setState({
    userMetadata: emptyMetadata(),
    isMetadataLoaded: true,
    isMetadataLoading: false,
    metadataError: null,
  });
});

describe("isProjectRoutine", () => {
  it("classifies headless SDK projects as routine work", () => {
    const { isProjectRoutine } = useAppStore.getState();

    expect(isProjectRoutine("/home/me/market-forecast", "sdk-cli")).toBe(true);
    expect(isProjectRoutine("/home/me/notes", "claude-desktop")).toBe(false);
    expect(isProjectRoutine("/home/me/notes", "cli")).toBe(false);
  });

  it("treats an unknown or missing entrypoint as not routine", () => {
    const { isProjectRoutine } = useAppStore.getState();

    expect(isProjectRoutine("/home/me/legacy")).toBe(false);
    expect(isProjectRoutine("/home/me/legacy", null)).toBe(false);
    expect(isProjectRoutine("/home/me/legacy", "some-future-client")).toBe(
      false
    );
  });

  it("lets a hand-set override win in both directions", () => {
    useAppStore.setState({
      userMetadata: {
        ...emptyMetadata(),
        projects: {
          "/home/me/market-forecast": { routine: false },
          "/home/me/notes": { routine: true },
        },
      },
    });

    const { isProjectRoutine } = useAppStore.getState();
    expect(isProjectRoutine("/home/me/market-forecast", "sdk-cli")).toBe(false);
    expect(isProjectRoutine("/home/me/notes", "claude-desktop")).toBe(true);
  });
});

describe("setProjectRoutine", () => {
  it("persists the override and clears it again", async () => {
    await useAppStore.getState().setProjectRoutine("/home/me/notes", true);

    expect(mockInvoke).toHaveBeenLastCalledWith("update_project_metadata", {
      projectPath: "/home/me/notes",
      update: { routine: true },
    });

    await useAppStore.getState().setProjectRoutine("/home/me/notes", undefined);

    expect(mockInvoke).toHaveBeenLastCalledWith("update_project_metadata", {
      projectPath: "/home/me/notes",
      update: { routine: undefined },
    });
  });

  it("keeps the project's other metadata", async () => {
    useAppStore.setState({
      userMetadata: {
        ...emptyMetadata(),
        projects: { "/home/me/notes": { alias: "Notes" } },
      },
    });

    await useAppStore.getState().setProjectRoutine("/home/me/notes", true);

    expect(mockInvoke).toHaveBeenLastCalledWith("update_project_metadata", {
      projectPath: "/home/me/notes",
      update: { alias: "Notes", routine: true },
    });
  });
});

describe("setProjectEnvironmentLabel", () => {
  it("trims the label and drops a blank one", async () => {
    const { setProjectEnvironmentLabel } = useAppStore.getState();

    await setProjectEnvironmentLabel("/home/me/notes", "  cloud VM  ");
    expect(mockInvoke).toHaveBeenLastCalledWith("update_project_metadata", {
      projectPath: "/home/me/notes",
      update: { environmentLabel: "cloud VM" },
    });

    await setProjectEnvironmentLabel("/home/me/notes", "   ");
    expect(mockInvoke).toHaveBeenLastCalledWith("update_project_metadata", {
      projectPath: "/home/me/notes",
      update: { environmentLabel: undefined },
    });
  });
});
