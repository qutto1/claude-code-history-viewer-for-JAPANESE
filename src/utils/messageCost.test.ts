import { describe, expect, it } from "vitest";

import {
  calculateMessageCost,
  formatCostCompact,
  formatCostCompactLabel,
  formatCostDetailLabel,
  formatCostExact,
  isListPriceEstimateProvider,
  type MessageCost,
  splitCacheCreation,
} from "./messageCost";

// claude-opus-5 per 1M tokens: input 5, output 25, cache read 0.5,
// cache write 6.25 (5m) / 10 (1h).
const OPUS_5 = "claude-opus-5";

describe("splitCacheCreation", () => {
  it("reads the nested breakdown when the flat per-TTL keys are absent", () => {
    // Real rows only ever carry the nested object; the flat _5m/_1h keys are
    // part of the API surface but Claude Code never writes them.
    const split = splitCacheCreation({
      input_tokens: 4,
      cache_creation_input_tokens: 24_000,
      cache_read_input_tokens: 100_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 4_000,
        ephemeral_1h_input_tokens: 20_000,
      },
    });

    expect(split.cacheCreationTokens5m).toBe(4_000);
    expect(split.cacheCreationTokens1h).toBe(20_000);
    expect(split.cacheCreationTokens).toBe(24_000);
    expect(split.contextTokens).toBe(124_004);
  });

  it("lets the flat aggregate win when it disagrees with the nested counts", () => {
    // The aggregate is what was billed, so the 5m share absorbs the difference
    // rather than the total drifting away from the row.
    const split = splitCacheCreation({
      cache_creation_input_tokens: 30_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 4_000,
        ephemeral_1h_input_tokens: 20_000,
      },
    });

    expect(split.cacheCreationTokens).toBe(30_000);
    expect(split.cacheCreationTokens1h).toBe(20_000);
    expect(split.cacheCreationTokens5m).toBe(10_000);
  });

  it("never reports a negative 5m share when the 1h count exceeds the total", () => {
    const split = splitCacheCreation({
      cache_creation_input_tokens: 1_000,
      cache_creation: { ephemeral_1h_input_tokens: 5_000 },
    });

    expect(split.cacheCreationTokens5m).toBe(0);
  });

  it("sums the nested counts when there is no flat aggregate", () => {
    const split = splitCacheCreation({
      cache_creation: {
        ephemeral_5m_input_tokens: 1_500,
        ephemeral_1h_input_tokens: 2_500,
      },
    });

    expect(split.cacheCreationTokens).toBe(4_000);
  });
});

describe("calculateMessageCost", () => {
  it("prices a real corpus row whose cache writes are all 5-minute", () => {
    const cost = calculateMessageCost({
      model: OPUS_5,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 11_590,
        cache_read_input_tokens: 29_662,
        cache_creation: {
          ephemeral_5m_input_tokens: 11_590,
          ephemeral_1h_input_tokens: 0,
        },
        output_tokens: 1,
        service_tier: "standard",
      },
    });

    // 2*5 + 1*25 + 11590*6.25 + 29662*0.5, all per 1M.
    expect(cost?.cost).toBeCloseTo(0.0873035, 7);
    expect(cost?.isEstimated).toBe(true);
    expect(cost?.cacheCreationTokens1h).toBe(0);
  });

  it("bills one-hour cache writes at the one-hour rate", () => {
    const usage = {
      input_tokens: 2,
      cache_creation_input_tokens: 11_590,
      cache_read_input_tokens: 29_662,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 11_590,
      },
      output_tokens: 1,
      service_tier: "standard",
    };

    const cost = calculateMessageCost({ model: OPUS_5, usage });

    // Same tokens as above but 10/1M instead of 6.25/1M on the writes.
    expect(cost?.cost).toBeCloseTo(0.130766, 7);
  });

  it("charges each TTL its own rate on a mixed row", () => {
    const cost = calculateMessageCost({
      model: OPUS_5,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 20_000,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 8_000,
          ephemeral_1h_input_tokens: 12_000,
        },
      },
    });

    // 8000*6.25 + 12000*10, per 1M.
    expect(cost?.cost).toBeCloseTo(0.17, 7);
  });

  it("bills reasoning tokens at the output rate exactly once", () => {
    const cost = calculateMessageCost({
      model: OPUS_5,
      usage: {
        output_tokens: 1_000,
        reasoning_tokens: 1_000,
        cache_creation_input_tokens: 10_000,
        cache_creation: { ephemeral_1h_input_tokens: 10_000 },
      },
    });

    // 2000 billable output * 25 + 10000 * 10, per 1M. The 1h pass must not
    // charge the reasoning tokens a second time.
    expect(cost?.cost).toBeCloseTo(0.15, 7);
  });

  it("prefers an authoritative costUSD over the pricing table", () => {
    const cost = calculateMessageCost({
      model: OPUS_5,
      costUSD: 1.25,
      usage: { input_tokens: 10, output_tokens: 10 },
    });

    expect(cost?.cost).toBe(1.25);
    expect(cost?.isEstimated).toBe(false);
  });

  it("returns null for the synthetic model", () => {
    expect(
      calculateMessageCost({
        model: "<synthetic>",
        usage: { input_tokens: 100, output_tokens: 100 },
      }),
    ).toBeNull();
  });

  it("returns null for providers whose billing cannot be reconstructed", () => {
    // Copilot opts into list-price estimates (below); the other source-cost-only
    // providers keep the analytics gate.
    for (const provider of ["cursor", "opencode", "kilo"] as const) {
      expect(
        calculateMessageCost({
          model: OPUS_5,
          provider,
          usage: { input_tokens: 100, output_tokens: 100 },
        }),
      ).toBeNull();
    }
  });

  it("returns null without a model or without usage", () => {
    expect(calculateMessageCost({ usage: { input_tokens: 10 } })).toBeNull();
    expect(calculateMessageCost({ model: OPUS_5 })).toBeNull();
  });
});

describe("calculateMessageCost — Copilot list-price estimate", () => {
  // claude-haiku-4-5 per 1M tokens: input 1, output 5.
  it("prices a real VS Code Copilot turn at the API list price", () => {
    // Shape of a real `copilot/auto` request resolved via `result.details`
    // ("Claude Haiku 4.5 • 1x") by the backend.
    const cost = calculateMessageCost({
      model: "copilot/claude-haiku-4.5",
      provider: "copilot",
      usage: { input_tokens: 24_262, output_tokens: 370 },
    });

    // 24,262 * 1 / 1M + 370 * 5 / 1M = 0.024262 + 0.00185
    expect(cost?.cost).toBeCloseTo(0.026112, 9);
    expect(cost?.isEstimated).toBe(true);
    expect(isListPriceEstimateProvider("copilot")).toBe(true);
    expect(isListPriceEstimateProvider("claude")).toBe(false);
  });

  it("resolves dotted Claude versions, with or without a vendor prefix", () => {
    // claude-sonnet-4-5: input 3, output 15 per 1M.
    const expected = (1_000 * 3 + 100 * 15) / 1_000_000;
    for (const model of ["claude-sonnet-4.5", "copilot/claude-sonnet-4.5"]) {
      const cost = calculateMessageCost({
        model,
        provider: "copilot",
        usage: { input_tokens: 1_000, output_tokens: 100 },
      });
      expect(cost?.cost).toBeCloseTo(expected, 12);
    }
  });

  it("keeps dotted GPT ids as they are", () => {
    const cost = calculateMessageCost({
      model: "copilot/gpt-4.1",
      provider: "copilot",
      usage: { input_tokens: 1_000, output_tokens: 100 },
    });
    // gpt-4.1: input 2, output 8 per 1M. A hyphenated `gpt-4-1` would hit the
    // `gpt-4` key ($30/$60) by prefix instead.
    expect(cost?.cost).toBeCloseTo((1_000 * 2 + 100 * 8) / 1_000_000, 12);
    expect(cost?.isEstimated).toBe(true);
  });

  it("does not hyphenate dotted non-Claude ids missing from the table", () => {
    // `gpt-5-7` would match the `gpt-5` key by prefix.
    expect(
      calculateMessageCost({
        model: "copilot/gpt-5.7",
        provider: "copilot",
        usage: { input_tokens: 1_000, output_tokens: 100 },
      }),
    ).toBeNull();
  });

  it("accepts a converted Claude id only when it names a pricing key exactly", () => {
    for (const model of [
      // Unknown version: would fall back to `claude-opus-4` ($15/$75) by prefix.
      "claude-opus-4.9",
      "copilot/claude-opus-4.9",
      // Fast mode: would lose its premium and price as plain Opus 4.6.
      "claude-opus-4.6-fast",
    ]) {
      expect(
        calculateMessageCost({
          model,
          provider: "copilot",
          usage: { input_tokens: 1_000, output_tokens: 100 },
        }),
        model,
      ).toBeNull();
    }

    // A dated snapshot of a known key still resolves (sonnet 4-5: 3 / 15).
    const dated = calculateMessageCost({
      model: "claude-sonnet-4.5-20250929",
      provider: "copilot",
      usage: { input_tokens: 1_000, output_tokens: 100 },
    });
    expect(dated?.cost).toBeCloseTo((1_000 * 3 + 100 * 15) / 1_000_000, 12);
  });

  it("returns null when the input count is zero or missing", () => {
    for (const usage of [
      { input_tokens: 0, output_tokens: 370 },
      { output_tokens: 370 },
    ]) {
      expect(
        calculateMessageCost({
          model: "claude-haiku-4.5",
          provider: "copilot",
          usage,
        }),
      ).toBeNull();
    }
  });

  it("marks the cost a lower bound only when the usage is partial", () => {
    const usage = { input_tokens: 24_262, output_tokens: 370 };
    const whole = calculateMessageCost({
      model: "copilot/claude-haiku-4.5",
      provider: "copilot",
      usage,
    });
    expect(whole?.isListPriceEstimate).toBe(true);
    expect(whole?.isLowerBound).toBe(false);

    const partial = calculateMessageCost({
      model: "copilot/claude-haiku-4.5",
      provider: "copilot",
      usage,
      partialUsage: true,
    });
    expect(partial?.cost).toBeCloseTo(0.026112, 9);
    expect(partial?.isListPriceEstimate).toBe(true);
    expect(partial?.isLowerBound).toBe(true);
  });

  it("never marks other providers as list-price or lower-bound estimates", () => {
    const claude = calculateMessageCost({
      model: "claude-haiku-4-5",
      provider: "claude",
      usage: { input_tokens: 24_262, output_tokens: 370 },
      partialUsage: true,
    });
    expect(claude?.isListPriceEstimate).toBe(false);
    expect(claude?.isLowerBound).toBe(false);

    const reported = calculateMessageCost({
      model: "claude-haiku-4.5",
      provider: "copilot",
      costUSD: 0.5,
      partialUsage: true,
    });
    expect(reported?.isLowerBound).toBe(false);
    expect(reported?.isListPriceEstimate).toBe(false);
  });

  it("returns null when the model is the unresolved Auto selector", () => {
    expect(
      calculateMessageCost({
        model: "copilot/auto",
        provider: "copilot",
        usage: { input_tokens: 24_262, output_tokens: 370 },
      }),
    ).toBeNull();
  });

  it("returns null instead of an output-only partial cost", () => {
    // Copilot CLI records output tokens only.
    expect(
      calculateMessageCost({
        model: "claude-haiku-4.5",
        provider: "copilot",
        usage: { output_tokens: 370 },
      }),
    ).toBeNull();
  });

  it("does not change how other providers resolve model names", () => {
    // Without the Copilot opt-in a dotted Claude id is not in the table.
    expect(
      calculateMessageCost({
        model: "claude-haiku-4.5",
        provider: "claude",
        usage: { input_tokens: 24_262, output_tokens: 370 },
      }),
    ).toBeNull();
    const claude = calculateMessageCost({
      model: "claude-haiku-4-5",
      provider: "claude",
      usage: { input_tokens: 24_262, output_tokens: 370 },
    });
    expect(claude?.cost).toBeCloseTo(0.026112, 9);
  });
});

describe("cost formatting", () => {
  it("keeps sub-cent costs visible in the exact form", () => {
    expect(formatCostExact(0.0004)).toBe("$0.0004");
    expect(formatCostExact(0.0873035)).toBe("$0.087");
    expect(formatCostExact(3.14159)).toBe("$3.14");
  });

  it("steps the compact form in $0.1 units", () => {
    expect(formatCostCompact(0.0873035)).toBe("$0.1");
    expect(formatCostCompact(0.004)).toBe("$0.0");
    expect(formatCostCompact(1.44)).toBe("$1.4");
  });

  const costOf = (overrides: Partial<MessageCost>): MessageCost => ({
    cost: 0.026112,
    isEstimated: true,
    isListPriceEstimate: false,
    isLowerBound: false,
    cacheCreationTokens5m: 0,
    cacheCreationTokens1h: 0,
    cacheCreationTokens: 0,
    contextTokens: 0,
    ...overrides,
  });

  it("prefixes the compact label only for list-price estimates", () => {
    expect(formatCostCompactLabel(costOf({}))).toBe("$0.0");
    expect(formatCostCompactLabel(costOf({ isEstimated: false }))).toBe("$0.0");
    expect(formatCostCompactLabel(costOf({ isListPriceEstimate: true }))).toBe("~$0.0");
    expect(
      formatCostCompactLabel(costOf({ isListPriceEstimate: true, isLowerBound: true })),
    ).toBe("≥$0.0");
  });

  it("marks lower bounds in the detail label", () => {
    expect(formatCostDetailLabel(costOf({ isEstimated: false }))).toBe("$0.026");
    expect(formatCostDetailLabel(costOf({}))).toBe("~$0.026");
    expect(formatCostDetailLabel(costOf({ isListPriceEstimate: true }))).toBe("~$0.026");
    expect(
      formatCostDetailLabel(costOf({ isListPriceEstimate: true, isLowerBound: true })),
    ).toBe("≥~$0.026");
  });
});
