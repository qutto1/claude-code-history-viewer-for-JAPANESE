import { describe, expect, it } from "vitest";

import {
  calculateMessageCost,
  formatCostCompact,
  formatCostExact,
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
    expect(
      calculateMessageCost({
        model: OPUS_5,
        provider: "copilot",
        usage: { input_tokens: 100, output_tokens: 100 },
      }),
    ).toBeNull();
  });

  it("returns null without a model or without usage", () => {
    expect(calculateMessageCost({ usage: { input_tokens: 10 } })).toBeNull();
    expect(calculateMessageCost({ model: OPUS_5 })).toBeNull();
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
});
