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
import pricingTable from "@/data/model-pricing.json";
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
  /**
   * The usage covers only part of the turn. Copilot records the tokens of the
   * last model call only, so a turn that called tools (one model call per
   * round) reports far fewer tokens than it used.
   */
  partialUsage?: boolean;
}

export interface MessageCost {
  /** Total price in USD. */
  cost: number;
  /** True when derived from the pricing table rather than read off the row. */
  isEstimated: boolean;
  /** True when priced at the API list price for a subscription provider. */
  isListPriceEstimate: boolean;
  /** True when the usage covered only part of the turn: the real cost is higher. */
  isLowerBound: boolean;
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
 * Providers whose per-message figure is an API list-price equivalent rather
 * than a reconstruction of what the user was charged.
 *
 * The analytics dashboard deliberately refuses to price these providers (see
 * `SOURCE_COST_ONLY_PROVIDER_IDS` in `calculations.ts`): subscriptions and
 * premium-request multipliers cannot be rebuilt from token counts, and totals
 * there must stay authoritative. The message gutter is a different surface —
 * a per-turn hint labelled as an estimate — so it opts in here, pricing the
 * underlying model at the vendor's published API rate. The analytics gate is
 * left untouched.
 */
const LIST_PRICE_ESTIMATE_PROVIDER_IDS: ReadonlySet<string> = new Set(["copilot"]);

/** True when the gutter prices this provider at the API list price. */
export const isListPriceEstimateProvider = (provider?: ProviderId): boolean =>
  provider != null && LIST_PRICE_ESTIMATE_PROVIDER_IDS.has(provider);

const PRICING_TABLE_KEYS: ReadonlySet<string> = new Set(
  Object.keys((pricingTable as { models: Record<string, unknown> }).models),
);

/** A pricing key itself, or a pricing key followed by a `-YYYYMMDD` snapshot date. */
const DATED_SNAPSHOT_SUFFIX = /-\d{8}$/;

const isExactPricingKey = (modelSegment: string): boolean =>
  PRICING_TABLE_KEYS.has(modelSegment) ||
  PRICING_TABLE_KEYS.has(modelSegment.replace(DATED_SNAPSHOT_SUFFIX, ""));

/**
 * Candidate spellings of a model id to look up in the pricing table.
 *
 * Copilot reports Claude models with a dotted version (`claude-haiku-4.5`)
 * while the table keys them with a hyphen (`claude-haiku-4-5`). GPT keys keep
 * their dots (`gpt-4.1-mini`), so the conversion is limited to Claude names
 * and the raw spelling is always tried first.
 *
 * The converted spelling is used only when it names a pricing key exactly
 * (optionally with a `-YYYYMMDD` date). The table lookup matches by prefix, so
 * an unknown version such as `claude-opus-4.9` would otherwise fall back to
 * `claude-opus-4`, and `claude-opus-4.6-fast` would lose its fast-mode premium.
 */
const listPriceModelCandidates = (model: string): string[] => {
  const segments = model.trim().split("/");
  const last = (segments.at(-1) ?? "").toLowerCase();
  const candidates = [model];
  if (last.startsWith("claude-") && /\d\.\d/.test(last)) {
    const hyphenated = last.replace(/(\d+)\.(\d+)/g, "$1-$2");
    if (isExactPricingKey(hyphenated)) {
      candidates.push([...segments.slice(0, -1), hyphenated].join("/"));
    }
  }
  return candidates;
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
  partialUsage = false,
}: MessageCostInput): MessageCost | null => {
  const split = splitCacheCreation(usage);

  if (costUSD != null) {
    return {
      cost: costUSD,
      isEstimated: false,
      isListPriceEstimate: false,
      isLowerBound: false,
      ...split,
    };
  }

  if (!model || !usage) {
    return null;
  }

  const isListPriceEstimate = isListPriceEstimateProvider(provider);
  // A list-price estimate needs the prompt side too: pricing only the output
  // of a turn whose input is unknown (or reported as zero) would understate it
  // badly (Copilot CLI records output tokens only).
  if (isListPriceEstimate && !((usage.input_tokens ?? 0) > 0)) {
    return null;
  }

  // List-price estimates look the model up as a bare model id, bypassing the
  // provider-level billing gate that the analytics dashboard relies on.
  const pricingProviderId = isListPriceEstimate ? undefined : provider;
  const pricedModel = isListPriceEstimate
    ? listPriceModelCandidates(model).find((candidate) =>
      hasExplicitModelPricing(candidate, undefined),
    )
    : hasExplicitModelPricing(model, provider)
      ? model
      : undefined;
  if (pricedModel == null) {
    return null;
  }

  const priced = priceWithPricingTable(pricedModel, usage, split, pricingProviderId);
  if (priced == null) {
    return null;
  }
  return {
    ...priced,
    isListPriceEstimate,
    isLowerBound: isListPriceEstimate && partialUsage,
  };
};

const priceWithPricingTable = (
  model: string,
  usage: MessageUsageLike,
  split: CacheCreationSplit,
  pricingProviderId: ProviderId | undefined,
): Omit<MessageCost, "isListPriceEstimate" | "isLowerBound"> | null => {
  const options = {
    providerId: pricingProviderId,
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

/**
 * Prefix for figures that are not what the user was charged: `≥` when the
 * usage covered only part of the turn, `~` for any other list-price estimate.
 */
const listPricePrefix = (cost: MessageCost): string => {
  if (cost.isLowerBound) return "≥";
  if (cost.isListPriceEstimate) return "~";
  return "";
};

/**
 * The gutter's compact cost label. List-price estimates carry `~`, lower
 * bounds `≥`; every other provider keeps the plain `$0.0` figure.
 */
export const formatCostCompactLabel = (cost: MessageCost): string =>
  `${listPricePrefix(cost)}${formatCostCompact(cost.cost)}`;

/**
 * The details card's cost figure: `~` for any table-derived estimate, with
 * `≥` in front when the figure is a lower bound (`≥~$0.026`).
 */
export const formatCostDetailLabel = (cost: MessageCost): string => {
  const exact = formatCostExact(cost.cost);
  if (!cost.isEstimated) return exact;
  return `${cost.isLowerBound ? "≥" : ""}~${exact}`;
};

/** Above this the gutter shows the cost in red so an expensive turn stands out. */
export const EXPENSIVE_MESSAGE_COST_USD = 3;

/**
 * Below this the gutter greys the cost out. Most turns in a real session land
 * here, and a column of equally-loud sub-dollar figures buries the few turns
 * that actually cost something — the point of the line is the outlier.
 */
export const NEGLIGIBLE_MESSAGE_COST_USD = 1;
