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
    system: true,
  },
});

const allHiddenFilter = (): MessageFilter => ({
  roles: { user: false, assistant: false },
  contentTypes: {
    text: false,
    thinking: false,
    toolCalls: false,
    commands: false,
    parallelTasks: false,
    compactSummary: false,
    system: false,
  },
});

describe("system / other rows display filter", () => {
  // `api-request-blob` is the raw API payload newer Claude Code builds write;
  // the viewer receives it as a row with a content array and a role of "user".
  const messages = [
    makeMessage("user", { content: "hello" }),
    makeMessage("assistant", { type: "assistant", role: "assistant", content: "hi" }),
    makeMessage("blob", { type: "api-request-blob", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] }),
    makeMessage("env", { type: "attachment", content: "# Environment update" }),
    makeMessage("sys", { type: "system", subtype: "local_command", content: "ok" }),
    makeMessage("sum", { type: "summary", content: "a summary" }),
  ];

  it("keeps every row while the system filter is on", () => {
    expect(applyMessageDisplayFilter(messages, allShownFilter())).toHaveLength(messages.length);
  });

  it("drops only the non-user/assistant rows when the system filter is off", () => {
    const filter = allShownFilter();
    filter.contentTypes.system = false;

    const result = applyMessageDisplayFilter(messages, filter);
    expect(result.map((m) => m.uuid)).toEqual(["user", "assistant"]);
  });

  it("leaves nothing on screen when every toggle is off", () => {
    expect(applyMessageDisplayFilter(messages, allHiddenFilter())).toHaveLength(0);
  });

  it("keeps system rows when only the role and content toggles are off", () => {
    const filter = allHiddenFilter();
    filter.contentTypes.system = true;

    const result = applyMessageDisplayFilter(messages, filter);
    expect(result.map((m) => m.uuid)).toEqual(["blob", "env", "sys", "sum"]);
  });
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
