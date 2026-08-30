import { describe, expect, it } from "vitest";

import type { ClaudeMessage } from "../../../types";
import { collectModelChangeUuids } from "./modelChangeHelpers";

const assistant = (uuid: string, model?: string): ClaudeMessage => ({
  uuid,
  type: "assistant",
  role: "assistant",
  timestamp: "2026-08-30T10:00:00.000Z",
  content: [{ type: "text", text: "ok" }],
  model,
} as unknown as ClaudeMessage);

const user = (uuid: string): ClaudeMessage => ({
  uuid,
  type: "user",
  role: "user",
  timestamp: "2026-08-30T10:00:00.000Z",
  content: "hello",
} as unknown as ClaudeMessage);

describe("collectModelChangeUuids", () => {
  it("counts the first modelled message as a change", () => {
    // Nothing precedes it, so there is no run for it to belong to.
    const messages = [user("u1"), assistant("a1", "claude-sonnet-5")];

    expect(collectModelChangeUuids(messages)).toEqual(new Set(["a1"]));
  });

  it("marks a switch and leaves the run that follows it unmarked", () => {
    const messages = [
      assistant("a1", "claude-sonnet-5"),
      assistant("a2", "claude-opus-5"),
      assistant("a3", "claude-opus-5"),
      assistant("a4", "claude-sonnet-5"),
    ];

    expect(collectModelChangeUuids(messages)).toEqual(new Set(["a1", "a2", "a4"]));
  });

  it("looks past a user turn sitting between two same-model answers", () => {
    // The literal predecessor of a2 is a user row with no model. Comparing
    // against that would call every assistant turn a change.
    const messages = [
      assistant("a1", "claude-sonnet-5"),
      user("u1"),
      assistant("a2", "claude-sonnet-5"),
    ];

    expect(collectModelChangeUuids(messages)).toEqual(new Set(["a1"]));
  });

  it("treats two ids that shorten to the same label as a change", () => {
    // Both render as "sonnet-4" in the gutter, but they are different models
    // and the switch has to stay visible.
    const messages = [
      assistant("a1", "claude-sonnet-4-20250514"),
      assistant("a2", "claude-sonnet-4"),
    ];

    expect(collectModelChangeUuids(messages)).toEqual(new Set(["a1", "a2"]));
  });

  it("omits messages with no model and lets them extend the run", () => {
    const messages = [
      assistant("a1", "claude-sonnet-5"),
      assistant("a2", undefined),
      user("u1"),
      assistant("a3", "claude-sonnet-5"),
    ];

    const changed = collectModelChangeUuids(messages);

    expect(changed.has("a2")).toBe(false);
    expect(changed).toEqual(new Set(["a1"]));
  });

  it("returns an empty set for a session with no modelled messages", () => {
    expect(collectModelChangeUuids([user("u1"), user("u2")])).toEqual(new Set());
  });

  it("emphasises the earliest loaded turn when the window starts mid-run", () => {
    // Pagination: the sonnet turn that preceded this window is not loaded, so
    // the first loaded turn is reported as a change rather than as "same".
    const messages = [assistant("a5", "claude-sonnet-5"), assistant("a6", "claude-sonnet-5")];

    expect(collectModelChangeUuids(messages)).toEqual(new Set(["a5"]));
  });
});
