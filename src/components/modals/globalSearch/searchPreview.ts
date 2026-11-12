/**
 * Search-result preview building for the global search modal.
 *
 * The backend (`search_in_value`) matches a query against every string value
 * in `content`, `toolUse` and `toolUseResult`, at unlimited depth. The preview
 * must therefore be able to find the matching string wherever it lives, not
 * only in a joined/truncated summary of the message.
 *
 * Strings are collected in two tiers:
 * - `primary`: human-meaningful strings in display order (text, thinking,
 *   tool name + input, tool_result content, toolUse, toolUseResult, other
 *   items). Used first for matching and for the no-match fallback.
 * - `exhaustive`: every other string value under content / toolUse /
 *   toolUseResult (ids, signatures, `type` tags, ...) that is not already in
 *   `primary`. Only consulted when no primary string matches, so the backend's
 *   match scope is fully covered without letting ids or base64 blobs become the
 *   fallback preview, and without scanning the same string twice.
 */

/**
 * Node budget per tier and message (shared across all walked roots). Only
 * strings and containers count; numbers, booleans and null are free.
 */
export const PREVIEW_MAX_NODES = 20_000;
/** Characters shown on each side of the match. */
export const PREVIEW_CONTEXT_RADIUS = 60;
/** Length of the fallback preview when no string matches the query. */
export const PREVIEW_FALLBACK_LENGTH = 150;
/** Queries shorter than this are not searched (mirrors the modal). */
const MIN_QUERY_LENGTH = 2;

export interface PreviewSource {
    content?: unknown;
    toolUse?: unknown;
    toolUseResult?: unknown;
}

export interface SearchableStrings {
    primary: string[];
    exhaustive: string[];
    /** True when the node budget ran out before every value was visited. */
    truncated: boolean;
}

interface NodeBudget {
    remaining: number;
    truncated: boolean;
}

const isWalkable = (value: unknown): value is string | object =>
    typeof value === "string" || (value != null && typeof value === "object");

/** A container being walked: its children and the next child to visit. */
interface WalkFrame {
    children: readonly unknown[];
    next: number;
}

/**
 * Push every string value reachable from `root` onto `out`, in document order
 * (depth-first), without recursion. The stack holds one frame per open
 * container (children + cursor), never the pending children themselves, so a
 * huge array costs no stack space and the work stops as soon as the budget is
 * spent. Each visited string or container costs one unit; once the budget is
 * exhausted, the strings collected so far are kept.
 */
const walkStrings = (root: unknown, out: string[], budget: NodeBudget): void => {
    const frames: WalkFrame[] = [];
    /** Visit one value; false when the budget is exhausted. */
    const visit = (value: unknown): boolean => {
        if (!isWalkable(value)) return true;
        if (budget.remaining <= 0) {
            budget.truncated = true;
            return false;
        }
        budget.remaining--;
        if (typeof value === "string") {
            if (value.trim()) out.push(value);
        } else {
            const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
            frames.push({ children, next: 0 });
        }
        return true;
    };

    if (!visit(root)) return;
    while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        if (frame.next >= frame.children.length) {
            frames.pop();
            continue;
        }
        if (!visit(frame.children[frame.next++])) return;
    }
};

const pushIfText = (value: unknown, out: string[]): void => {
    if (typeof value === "string" && value.trim()) out.push(value);
};

/** Collect the query-independent searchable strings of a message. */
export const collectSearchableStrings = (
    message: PreviewSource,
    maxNodes: number = PREVIEW_MAX_NODES,
): SearchableStrings => {
    const primary: string[] = [];
    const primaryBudget: NodeBudget = { remaining: maxNodes, truncated: false };

    const content = message.content;
    if (typeof content === "string") {
        pushIfText(content, primary);
    } else if (Array.isArray(content)) {
        for (const raw of content) {
            if (raw == null || typeof raw !== "object") {
                walkStrings(raw, primary, primaryBudget);
                continue;
            }
            const item = raw as Record<string, unknown>;
            switch (item.type) {
                case "text":
                    pushIfText(item.text, primary);
                    break;
                case "thinking":
                    pushIfText(item.thinking, primary);
                    break;
                case "tool_use":
                    pushIfText(item.name, primary);
                    walkStrings(item.input, primary, primaryBudget);
                    break;
                case "tool_result":
                    walkStrings(item.content, primary, primaryBudget);
                    break;
                default:
                    walkStrings(item, primary, primaryBudget);
            }
        }
    }
    walkStrings(message.toolUse, primary, primaryBudget);
    walkStrings(message.toolUseResult, primary, primaryBudget);

    const everything: string[] = [];
    const exhaustiveBudget: NodeBudget = { remaining: maxNodes, truncated: false };
    walkStrings(message.content, everything, exhaustiveBudget);
    walkStrings(message.toolUse, everything, exhaustiveBudget);
    walkStrings(message.toolUseResult, everything, exhaustiveBudget);
    // Equal strings give equal match results, so skip the ones primary covers.
    const primarySet = new Set(primary);
    const exhaustive = everything.filter((text) => !primarySet.has(text));

    return {
        primary,
        exhaustive,
        truncated: primaryBudget.truncated || exhaustiveBudget.truncated,
    };
};

const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Regex source for a query: metacharacters escaped and every whitespace run
 * matching `\s+`, so a query typed with double spaces still matches (and can be
 * highlighted in) a snippet whose whitespace was collapsed.
 */
const queryPattern = (trimmedQuery: string): string =>
    trimmedQuery.split(/\s+/).map(escapeRegExp).join("\\s+");

/**
 * Case-insensitive highlighter regex for the preview (single capture group,
 * for `String.prototype.split`). Uses the same pattern as the preview matcher
 * so whatever the preview centers on can be marked. Null for a blank query.
 */
export const buildHighlightRegex = (query: string): RegExp | null => {
    const trimmed = query.trim();
    if (!trimmed) return null;
    return new RegExp(`(${queryPattern(trimmed)})`, "i");
};

const NON_ASCII = /[\u0080-\uffff]/;

/**
 * Locate the query in `text`, case-insensitively. Uses the same `i`-flag regex
 * as the modal's highlighter so the snippet window always contains something
 * the highlighter can mark. Falls back to Unicode lowercase containment (the
 * semantics of some non-Claude providers) only for text with non-ASCII
 * characters: for pure ASCII text the regex already covers that, and the
 * fallback would copy the whole string for nothing.
 */
const findMatch = (
    text: string,
    query: string,
    queryRegex: RegExp,
): { index: number; length: number } | null => {
    const m = queryRegex.exec(text);
    if (m) return { index: m.index, length: m[0].length };
    if (!NON_ASCII.test(text)) return null;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const idx = lowerText.indexOf(lowerQuery);
    if (idx === -1) return null;
    // toLowerCase can change string length for a few code points; only trust
    // the index when lengths are preserved, otherwise anchor at the start.
    return lowerText.length === text.length
        ? { index: idx, length: query.length }
        : { index: 0, length: 0 };
};

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Move a slice start back by one if it would split a surrogate pair. */
const safeSliceStart = (text: string, index: number): number =>
    index > 0 && index < text.length && isLowSurrogate(text.charCodeAt(index)) ? index - 1 : index;

/** Move a slice end forward by one if it would split a surrogate pair. */
const safeSliceEnd = (text: string, index: number): number =>
    index > 0 && index < text.length && isHighSurrogate(text.charCodeAt(index - 1)) ? index + 1 : index;

const snippetAround = (text: string, index: number, length: number): string => {
    const start = safeSliceStart(text, Math.max(0, index - PREVIEW_CONTEXT_RADIUS));
    const end = safeSliceEnd(text, Math.min(text.length, index + length + PREVIEW_CONTEXT_RADIUS));
    const prefix = start > 0 ? "..." : "";
    const suffix = end < text.length ? "..." : "";
    return prefix + normalizeWhitespace(text.slice(start, end)) + suffix;
};

/**
 * Build the preview line for already-collected strings.
 *
 * - First string (primary tier, then exhaustive tier) containing the query →
 *   the match with {@link PREVIEW_CONTEXT_RADIUS} characters of context.
 * - No match → the first primary string (or, if none, the first exhaustive
 *   string), truncated to {@link PREVIEW_FALLBACK_LENGTH} characters.
 * - No strings collected at all → `null` (the caller shows "No preview
 *   available"). A node-budget cut-off still previews the strings collected.
 */
export const buildPreviewFromStrings = (
    strings: SearchableStrings,
    query: string,
): string | null => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length >= MIN_QUERY_LENGTH) {
        const queryRegex = new RegExp(queryPattern(trimmedQuery), "i");
        for (const tier of [strings.primary, strings.exhaustive]) {
            for (const text of tier) {
                const match = findMatch(text, trimmedQuery, queryRegex);
                if (match) return snippetAround(text, match.index, match.length);
            }
        }
    }

    const fallbackSource = strings.primary[0] ?? strings.exhaustive[0];
    if (fallbackSource == null) return null;
    const normalized = normalizeWhitespace(fallbackSource);
    if (normalized.length <= PREVIEW_FALLBACK_LENGTH) return normalized;
    const end = safeSliceEnd(normalized, PREVIEW_FALLBACK_LENGTH);
    return end < normalized.length ? normalized.slice(0, end) + "..." : normalized;
};

/** Convenience: collect + build in one call. */
export const buildPreview = (message: PreviewSource, query: string): string | null =>
    buildPreviewFromStrings(collectSearchableStrings(message), query);
