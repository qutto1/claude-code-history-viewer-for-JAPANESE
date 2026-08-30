import { describe, expect, it } from "vitest";

import { getShortModelName } from "./model";

describe("getShortModelName", () => {
  it("shortens dated ids", () => {
    expect(getShortModelName("claude-haiku-4-5-20251001")).toBe("haiku-4.5");
    expect(getShortModelName("claude-sonnet-4-20250514")).toBe("sonnet-4");
    expect(getShortModelName("claude-3-5-sonnet-20241022")).toBe("sonnet-3.5");
  });

  it("shortens the date-less ids modern logs actually contain", () => {
    expect(getShortModelName("claude-opus-5")).toBe("opus-5");
    expect(getShortModelName("claude-sonnet-5")).toBe("sonnet-5");
    expect(getShortModelName("claude-fable-5")).toBe("fable-5");
    expect(getShortModelName("claude-opus-4-8")).toBe("opus-4.8");
    expect(getShortModelName("claude-sonnet-4-6")).toBe("sonnet-4.6");
  });

  it("drops the vendor prefix from anything else Claude-branded", () => {
    expect(getShortModelName("claude-mythos-preview")).toBe("mythos-preview");
  });

  it("leaves non-Claude and synthetic ids alone", () => {
    expect(getShortModelName("gpt-5.6")).toBe("gpt-5.6");
    expect(getShortModelName("gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(getShortModelName("<synthetic>")).toBe("<synthetic>");
    expect(getShortModelName("")).toBe("");
  });
});
