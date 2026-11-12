/**
 * Date filter for the global search modal.
 *
 * The backend search commands accept `filters.dateRange = [start, end]` as two
 * RFC 3339 strings and reject `start > end`, so the range is computed and
 * validated here before it is sent.
 */

export const DATE_FILTER_PRESETS = ["all", "24h", "2d", "7d", "30d", "90d", "custom"] as const;
export type DateFilterPreset = (typeof DATE_FILTER_PRESETS)[number];

export interface DateFilterSelection {
    preset: DateFilterPreset;
    /** `<input type="date">` value ("YYYY-MM-DD") or empty. */
    from: string;
    /** `<input type="date">` value ("YYYY-MM-DD") or empty. */
    to: string;
}

export const DEFAULT_DATE_FILTER: DateFilterSelection = { preset: "all", from: "", to: "" };

/**
 * - `invalidRange`: the from-date is after the to-date.
 * - `futureStart`: only a from-date is given and it lies in the future.
 */
export type DateRangeError = "invalidRange" | "futureStart";

export interface DateRangeResult {
    range: [string, string] | null;
    error?: DateRangeError;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const RELATIVE_PRESET_DAYS: Record<Exclude<DateFilterPreset, "all" | "custom">, number> = {
    "24h": 1,
    "2d": 2,
    "7d": 7,
    "30d": 30,
    "90d": 90,
};

/**
 * Years below this are rejected: `toISOString` would emit an expanded
 * (6-digit, signed) year that is not valid RFC 3339, and partially typed years
 * (e.g. "0002" while typing "2026") would otherwise trigger a search.
 */
const MIN_YEAR = 1000;

/** Lower bound used when only an end date is given. */
const EPOCH_START = new Date("1970-01-01T00:00:00.000Z");

export const isDateFilterPreset = (value: string): value is DateFilterPreset =>
    (DATE_FILTER_PRESETS as readonly string[]).includes(value);

/**
 * Parse a "YYYY-MM-DD" string as a LOCAL calendar date. `new Date("YYYY-MM-DD")`
 * is parsed as UTC and would shift the day, so the date is assembled field by
 * field. Returns null for empty, malformed or non-existent dates (e.g. 02-30)
 * and for years below {@link MIN_YEAR}.
 */
export const parseLocalDate = (value: string, endOfDay: boolean): Date | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (year < MIN_YEAR) return null;
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    if (endOfDay) date.setHours(23, 59, 59, 999);
    else date.setHours(0, 0, 0, 0);
    if (
        Number.isNaN(date.getTime()) ||
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day
    ) {
        return null;
    }
    return date;
};

/**
 * Canonical form of a selection: only the fields that affect the range are
 * kept, and unparsable dates (empty, malformed, partially typed years) become
 * "". Two selections with the same canonical form yield the same range, so the
 * modal keys its re-search on this to skip searches for intermediate input.
 */
export const normalizeDateFilter = (selection: DateFilterSelection): DateFilterSelection => {
    if (selection.preset !== "custom") return { preset: selection.preset, from: "", to: "" };
    return {
        preset: "custom",
        from: parseLocalDate(selection.from, false) != null ? selection.from.trim() : "",
        to: parseLocalDate(selection.to, true) != null ? selection.to.trim() : "",
    };
};

/**
 * Compute the backend `dateRange` for a selection.
 *
 * - `all` (or `custom` with no valid date) → `{ range: null }` (no filter).
 * - Relative presets → `[now - N×24h, now]`.
 * - `custom` → start of the from-day (local) … end of the to-day (local);
 *   a missing side defaults to 1970-01-01 / `now`.
 * - A from-date later than the to-date → `{ range: null, error: "invalidRange" }`.
 * - A future from-date with no to-date → `{ range: null, error: "futureStart" }`.
 * - Start equal to end is valid. On any error the caller must not search.
 */
export const buildDateRange = (selection: DateFilterSelection, now: Date): DateRangeResult => {
    const { preset } = selection;
    if (preset === "all") return { range: null };

    if (preset !== "custom") {
        const start = new Date(now.getTime() - RELATIVE_PRESET_DAYS[preset] * DAY_MS);
        return { range: [start.toISOString(), now.toISOString()] };
    }

    const from = parseLocalDate(selection.from, false);
    const to = parseLocalDate(selection.to, true);
    if (from == null && to == null) return { range: null };

    const start = from ?? EPOCH_START;
    const end = to ?? now;
    if (start.getTime() > end.getTime()) {
        return { range: null, error: to == null ? "futureStart" : "invalidRange" };
    }
    return { range: [start.toISOString(), end.toISOString()] };
};
