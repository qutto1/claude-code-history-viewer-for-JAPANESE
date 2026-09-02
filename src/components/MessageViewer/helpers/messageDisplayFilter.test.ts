import { describe, expect, it } from "vitest";
import type { ClaudeMessage } from "../../../types";
import type { MessageFilter } from "../../../store/slices/filterSlice";
import { applyMessageDisplayFilter } from "./messageDisplayFilter";

const makeMessage = (
  uuid: string,
  overrides: Record<string, unknown>,
): ClaudeMessage => ({
  uuid,
  type: "user",
  role: "user",
  timestamp: "2026-07-07T00:00:00.000Z",
  content: "",
  ...overrides,
} as unknown as ClaudeMessage);

const allShownFilter = (): MessageFilter => ({
  roles: { user: true, assistant: true },
  contentTypes: {
    text: true,
    thinking: true,
    toolCalls: true,
    commands: true,
    parallelTasks: true,
    compactSummary: true,
  },
});

describe("compact-summary display filter", () => {
  it("keeps the /compact summary row when the filter is on", () => {
    const messages = [
      makeMessage("normal", { content: "hello" }),
      makeMessage("compact", { isCompactSummary: true, content: "carried-over context" }),
    ];

    expect(applyMessageDisplayFilter(messages, allShownFilter())).toHaveLength(2);
  });

  it("drops only the /compact summary row when the filter is off", () => {
    const messages = [
      makeMessage("normal", { content: "hello" }),
      makeMessage("compact", { isCompactSummary: true, content: "carried-over context" }),
    ];
    const filter = allShownFilter();
    filter.contentTypes.compactSummary = false;

    const result = applyMessageDisplayFilter(messages, filter);
    expect(result.map((m) => m.uuid)).toEqual(["normal"]);
  });

  it("does not affect ordinary user rows that aren't a compact summary", () => {
    const messages = [makeMessage("normal", { content: "hello" })];
    const filter = allShownFilter();
    filter.contentTypes.compactSummary = false;

    expect(applyMessageDisplayFilter(messages, filter)).toHaveLength(1);
  });

  it("still hides the compact summary row when only the role filter differs (fast path bypass)", () => {
    // allRoles && allContent must NOT short-circuit past the compactSummary check.
    const messages = [
      makeMessage("compact", { isCompactSummary: true, content: "carried-over context" }),
    ];
    const filter = allShownFilter();
    filter.contentTypes.compactSummary = false;

    expect(applyMessageDisplayFilter(messages, filter)).toHaveLength(0);
  });
});
