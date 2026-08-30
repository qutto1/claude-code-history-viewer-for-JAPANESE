/**
 * Per-message API cost.
 *
 * Modern Claude Code stopped writing `costUSD` into its JSONL rows — across a
 * 43k-row corpus not a single assistant row carried one — so in practice the
 * cost always has to be reconstructed from the token counts. This module owns
 * that reconstruction so the message gutter and anything else that wants a
 * price agree on one answer.
 *
 * The subtle part is the cache write split. A row reports its cache writes both
 * as a flat aggregate (`cache_creation_input_tokens`) and as a nested
 * 5-minute/1-hour breakdown (`cache_creation.ephemeral_*_input_tokens`), and
 * the one-hour TTL bills at roughly 1.6x the five-minute rate. Real sessions are
 * dominated by one-hour writes, so collapsing the two into a single rate is
 * materially wrong, not a rounding difference.
 */

import {
  calculateModelPrice,
  hasExplicitModelPricing,
} from "@/components/AnalyticsDashboard/utils/calculations";
import type { ProviderId } from "@/types/core/session";

/** The `usage` payload shape shared by every assistant message type. */
export interface MessageUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation_input_tokens_5m?: number;
  cache_creation_input_tokens_1h?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  cache_read_input_tokens?: number;
  reasoning_tokens?: number;
  service_tier?: string;
}

export interface MessageCostInput {
  model?: string;
  usage?: MessageUsageLike;
  costUSD?: number | null;
  provider?: ProviderId;
}

export interface MessageCost {
  /** Total price in USD. */
  cost: number;
  /** True when derived from the pricing table rather than read off the row. */
  isEstimated: boolean;
  /** Cache writes billed at the five-minute rate. */
  cacheCreationTokens5m: number;
  /** Cache writes billed at the one-hour rate. */
  cacheCreationTokens1h: number;
  /** Both TTLs together — what the row calls `cache_creation_input_tokens`. */
  cacheCreationTokens: number;
  /** Everything that counted toward the context window for tier selection. */
  contextTokens: number;
}

/** The cache-write breakdown, independent of whether a price can be found. */
export interface CacheCreationSplit {
  cacheCreationTokens5m: number;
  cacheCreationTokens1h: number;
  cacheCreationTokens: number;
  contextTokens: number;
}

/**
 * Reconcile the flat aggregate against the nested per-TTL counts.
 *
 * The flat total wins when both are present: it is what the API billed. The 1h
 * figure is trusted as reported and the 5m share is whatever the total has left
 * over, so a row whose nested numbers disagree with its aggregate still prices
 * out to the aggregate.
 */
export const splitCacheCreation = (usage?: MessageUsageLike): CacheCreationSplit => {
  const nested5m = usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const nested1h = usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;

  const cacheCreationTokens1h = usage?.cache_creation_input_tokens_1h ?? nested1h;
  const reported5m = usage?.cache_creation_input_tokens_5m ?? nested5m;
  const cacheCreationTokens =
    usage?.cache_creation_input_tokens ?? reported5m + cacheCreationTokens1h;
  const cacheCreationTokens5m =
    usage?.cache_creation_input_tokens_5m ??
    (usage?.cache_creation_input_tokens == null
      ? reported5m
      : Math.max(cacheCreationTokens - cacheCreationTokens1h, 0));

  return {
    cacheCreationTokens5m,
    cacheCreationTokens1h,
    cacheCreationTokens,
    contextTokens:
      (usage?.input_tokens ?? 0) +
      cacheCreationTokens +
      (usage?.cache_read_input_tokens ?? 0),
  };
};

/**
 * Price one message, or return null when it cannot be priced — a user turn, a
 * `<synthetic>` model, or a provider whose rates we do not publish.
 */
export const calculateMessageCost = ({
  model,
  usage,
  costUSD,
  provider,
}: MessageCostInput): MessageCost | null => {
  const split = splitCacheCreation(usage);

  if (costUSD != null) {
    return { cost: costUSD, isEstimated: false, ...split };
  }

  if (!model || !usage || !hasExplicitModelPricing(model, provider)) {
    return null;
  }

  const options = {
    providerId: provider,
    serviceTier: usage.service_tier,
    contextTokens: split.contextTokens,
    reasoningTokens: usage.reasoning_tokens,
  };

  const baseCost = calculateModelPrice(
    model,
    usage.input_tokens ?? 0,
    usage.output_tokens ?? 0,
    split.cacheCreationTokens5m,
    usage.cache_read_input_tokens ?? 0,
    { ...options, cacheWriteTtl: "5m" },
  );
  // A second pass so the one-hour writes bill at the one-hour rate; everything
  // else is already accounted for in the first pass and is zeroed out here.
  const oneHourCost =
    split.cacheCreationTokens1h > 0
      ? calculateModelPrice(model, 0, 0, split.cacheCreationTokens1h, 0, {
        ...options,
        cacheWriteTtl: "1h",
        reasoningTokens: 0,
      })
      : 0;

  if (baseCost == null || oneHourCost == null) {
    return null;
  }

  return { cost: baseCost + oneHourCost, isEstimated: true, ...split };
};

/**
 * The exact figure, for the details tooltip. Small costs keep more decimals so
 * a fraction of a cent is still visible.
 */
export const formatCostExact = (usd: number): string => {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
};

/** The at-a-glance figure for the gutter: one decimal, so it steps by $0.1. */
export const formatCostCompact = (usd: number): string => `$${usd.toFixed(1)}`;

/** Above this the gutter shows the cost in red so an expensive turn stands out. */
export const EXPENSIVE_MESSAGE_COST_USD = 3;
