import { api } from "@/services/api";

/** The error the backend returns for a search that was superseded or cancelled. */
const SEARCH_CANCELLED = "search cancelled";

/**
 * UUID v4. `crypto.randomUUID` exists in secure contexts only, and the WebUI
 * may be served over plain HTTP, so fall back to `crypto.getRandomValues`.
 */
const createUuid = (): string => {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * A cancel group no other search box shares. The backend remembers the highest
 * seq per group for as long as it runs, so a reload or a second tab must not
 * reuse a name.
 */
export const createSearchCancelGroup = (): string => `global-search:${createUuid()}`;

/** Tauri rejects with the message itself; the WebUI `api()` wraps it in an Error. */
export const isSearchCancelledError = (error: unknown): boolean =>
    (error instanceof Error ? error.message : error) === SEARCH_CANCELLED;

/**
 * Stop the searches of `cancelGroup` started with a seq up to `cancelSeq`.
 * Best effort: if it fails, the old search runs to its end and the caller
 * drops its response anyway.
 */
export const requestSearchCancel = async (cancelGroup: string, cancelSeq: number): Promise<void> => {
    try {
        await api("cancel_search", { cancelGroup, cancelSeq });
    } catch {
        // Nothing for the user to act on.
    }
};
