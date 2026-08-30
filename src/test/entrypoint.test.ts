import { describe, expect, it } from "vitest";

import {
  ENTRYPOINT_BADGE_META,
  ENTRYPOINT_FILTER_LABEL_KEYS,
  ENTRYPOINT_FILTER_OPTIONS,
  matchesEntrypointFilter,
  normalizeEntrypoint,
} from "@/utils/entrypoint";

describe("normalizeEntrypoint", () => {
  it("maps Claude Code client values", () => {
    expect(normalizeEntrypoint("cli")).toBe("cli");
    expect(normalizeEntrypoint("claude-vscode")).toBe("vscode");
    expect(normalizeEntrypoint("claude-desktop")).toBe("desktop");
  });

  it("keeps headless Agent SDK runs out of the cli category", () => {
    expect(normalizeEntrypoint("sdk-cli")).toBe("sdk");
  });

  it("maps copilot entrypoint values", () => {
    expect(normalizeEntrypoint("copilot-cli")).toBe("cli");
    expect(normalizeEntrypoint("copilot-vscode")).toBe("vscode");
    expect(normalizeEntrypoint("copilot-desktop")).toBe("desktop");
  });

  it("maps kimi entrypoint values derived from kimi-code state", () => {
    expect(normalizeEntrypoint("kimi-code-cli")).toBe("cli");
    expect(normalizeEntrypoint("kimi-code-vscode")).toBe("vscode");
  });

  it("degrades unknown and missing values to null", () => {
    expect(normalizeEntrypoint("some-future-client")).toBeNull();
    expect(normalizeEntrypoint("")).toBeNull();
    expect(normalizeEntrypoint(null)).toBeNull();
    expect(normalizeEntrypoint(undefined)).toBeNull();
  });

  it("provides badge metadata for every category", () => {
    for (const category of ["cli", "sdk", "vscode", "desktop"] as const) {
      const meta = ENTRYPOINT_BADGE_META[category];
      expect(meta.i18nKey).toBeTruthy();
      expect(meta.badgeClass).toBeTruthy();
    }
  });

  it("offers a filter option and label for every category", () => {
    expect(ENTRYPOINT_FILTER_OPTIONS).toContain("sdk");
    for (const option of ENTRYPOINT_FILTER_OPTIONS) {
      expect(ENTRYPOINT_FILTER_LABEL_KEYS[option]).toBeTruthy();
    }
  });
});

describe("matchesEntrypointFilter", () => {
  it("passes everything under the all filter", () => {
    expect(matchesEntrypointFilter("kimi-code-vscode", "all")).toBe(true);
    expect(matchesEntrypointFilter(null, "all")).toBe(true);
  });

  it("matches kimi values against their normalized category", () => {
    expect(matchesEntrypointFilter("kimi-code-vscode", "vscode")).toBe(true);
    expect(matchesEntrypointFilter("kimi-code-vscode", "cli")).toBe(false);
    expect(matchesEntrypointFilter("kimi-code-cli", "cli")).toBe(true);
  });

  it("excludes sessions without an entrypoint from category filters", () => {
    expect(matchesEntrypointFilter(null, "cli")).toBe(false);
  });

  it("separates headless SDK runs from interactive CLI sessions", () => {
    expect(matchesEntrypointFilter("sdk-cli", "sdk")).toBe(true);
    expect(matchesEntrypointFilter("sdk-cli", "cli")).toBe(false);
    expect(matchesEntrypointFilter("cli", "sdk")).toBe(false);
    expect(matchesEntrypointFilter("sdk-cli", "all")).toBe(true);
  });
});
