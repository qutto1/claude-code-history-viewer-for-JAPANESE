import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilterToolbar } from "@/components/MessageViewer/components/FilterToolbar";

const { toggleContentTypeMock, useAppStoreMock } = vi.hoisted(() => {
  const toggleContentType = vi.fn();
  const state = {
    messageFilter: {
      roles: { user: true, assistant: true },
      contentTypes: {
        text: true,
        thinking: true,
        toolCalls: true,
        commands: true,
        parallelTasks: true,
        compactSummary: true,
        system: true,
      },
    },
    toggleRole: vi.fn(),
    toggleContentType,
    resetMessageFilter: vi.fn(),
    isMessageFilterActive: () => false,
  };

  return {
    toggleContentTypeMock: toggleContentType,
    useAppStoreMock: () => state,
  };
});

vi.mock("@/store/useAppStore", () => ({
  useAppStore: useAppStoreMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("FilterToolbar", () => {
  it("only shows the Parallel Tasks filter for sessions containing that category", () => {
    const { rerender } = render(
      <FilterToolbar totalCount={2} filteredCount={2} hasParallelTasks={false} hasCompactSummary={false} hasSystemMessages={false} />,
    );

    expect(screen.queryByRole("button", {
      name: "filter.content.parallelTasks",
    })).not.toBeInTheDocument();

    rerender(
      <FilterToolbar totalCount={2} filteredCount={2} hasParallelTasks hasCompactSummary={false} hasSystemMessages={false} />,
    );
    const toggle = screen.getByRole("button", {
      name: "filter.content.parallelTasks",
    });
    fireEvent.click(toggle);
    expect(toggleContentTypeMock).toHaveBeenCalledWith("parallelTasks");
  });

  it("only shows the Compacted Context filter for sessions containing a /compact summary", () => {
    const { rerender } = render(
      <FilterToolbar totalCount={2} filteredCount={2} hasParallelTasks={false} hasCompactSummary={false} hasSystemMessages={false} />,
    );

    expect(screen.queryByRole("button", {
      name: "filter.content.compactSummary",
    })).not.toBeInTheDocument();

    rerender(
      <FilterToolbar totalCount={2} filteredCount={2} hasParallelTasks={false} hasCompactSummary hasSystemMessages={false} />,
    );
    const toggle = screen.getByRole("button", {
      name: "filter.content.compactSummary",
    });
    fireEvent.click(toggle);
    expect(toggleContentTypeMock).toHaveBeenCalledWith("compactSummary");
  });

  it("only shows the System & Other filter for sessions containing such rows", () => {
    const { rerender } = render(
      <FilterToolbar totalCount={2} filteredCount={2} hasParallelTasks={false} hasCompactSummary={false} hasSystemMessages={false} />,
    );

    expect(screen.queryByRole("button", {
      name: "filter.content.system",
    })).not.toBeInTheDocument();

    rerender(
      <FilterToolbar totalCount={2} filteredCount={2} hasParallelTasks={false} hasCompactSummary={false} hasSystemMessages />,
    );
    const toggle = screen.getByRole("button", {
      name: "filter.content.system",
    });
    fireEvent.click(toggle);
    expect(toggleContentTypeMock).toHaveBeenCalledWith("system");
  });

  it("keeps the System & Other filter reachable while it is off, even for a session without such rows", () => {
    const state = useAppStoreMock();
    state.messageFilter.contentTypes.system = false;
    try {
      render(
        <FilterToolbar totalCount={2} filteredCount={2} hasParallelTasks={false} hasCompactSummary={false} hasSystemMessages={false} />,
      );
      const toggle = screen.getByRole("button", { name: "filter.content.system" });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
    } finally {
      state.messageFilter.contentTypes.system = true;
    }
  });
});
