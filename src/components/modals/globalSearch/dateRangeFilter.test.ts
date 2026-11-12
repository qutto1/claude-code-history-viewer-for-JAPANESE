import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    buildDateRange,
    isDateFilterPreset,
    normalizeDateFilter,
    parseLocalDate,
    type DateFilterSelection,
} from "./dateRangeFilter";
import { buildSearchFilters } from "./searchFilters";

// Local-time "now" so expectations hold in any test-runner timezone.
const NOW = new Date(2026, 10, 12, 10, 30, 0, 0); // 2026-11-12 10:30 local
const DAY_MS = 24 * 60 * 60 * 1000;

// Captured before any test switches process.env.TZ. Deleting TZ alone does not
// reset Node's cached zone on every platform, so restoring sets this first.
const RUNNER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const custom = (from: string, to: string): DateFilterSelection => ({ preset: "custom", from, to });
const localIso = (y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0) =>
    new Date(y, m - 1, d, h, mi, s, ms).toISOString();

describe("parseLocalDate", () => {
    it("parses as a local calendar date (not UTC)", () => {
        const start = parseLocalDate("2026-11-12", false);
        expect(start?.getFullYear()).toBe(2026);
        expect(start?.getMonth()).toBe(10);
        expect(start?.getDate()).toBe(12);
        expect(start?.getHours()).toBe(0);
        const end = parseLocalDate("2026-11-12", true);
        expect(end?.toISOString()).toBe(localIso(2026, 11, 12, 23, 59, 59, 999));
    });

    it.each(["", "  ", "2026-1-05", "2026/11/12", "20261112", "abcd-ef-gh", "2026-02-30", "2026-13-01", "2026-00-10"])(
        "rejects %j",
        (value) => {
            expect(parseLocalDate(value, false)).toBeNull();
        },
    );

    it.each(["0000-01-01", "0002-11-12", "0099-12-31", "0999-12-31"])(
        "rejects year below 1000 (%s): not RFC 3339 safe and a partially typed year",
        (value) => {
            expect(parseLocalDate(value, false)).toBeNull();
            expect(buildDateRange(custom(value, ""), NOW)).toEqual({ range: null });
        },
    );

    it("accepts year 1000 as the lowest year", () => {
        expect(parseLocalDate("1000-01-01", false)?.getFullYear()).toBe(1000);
    });

    it("accepts a leap day only in leap years", () => {
        expect(parseLocalDate("2028-02-29", false)).not.toBeNull();
        expect(parseLocalDate("2026-02-29", false)).toBeNull();
    });
});

describe("buildDateRange", () => {
    it("returns no range for 'all'", () => {
        expect(buildDateRange({ preset: "all", from: "2026-01-01", to: "" }, NOW)).toEqual({ range: null });
    });

    it.each([
        ["24h", 1],
        ["2d", 2],
        ["7d", 7],
        ["30d", 30],
        ["90d", 90],
    ] as const)("relative preset %s spans N×24h ending at now", (preset, days) => {
        const result = buildDateRange({ preset, from: "", to: "" }, NOW);
        expect(result.error).toBeUndefined();
        expect(result.range).toEqual([new Date(NOW.getTime() - days * DAY_MS).toISOString(), NOW.toISOString()]);
    });

    it("relative presets ignore stale custom dates", () => {
        const result = buildDateRange({ preset: "2d", from: "2030-01-01", to: "2020-01-01" }, NOW);
        expect(result.error).toBeUndefined();
        expect(result.range?.[1]).toBe(NOW.toISOString());
    });

    it("custom range covers the whole from-day through the whole to-day (local)", () => {
        expect(buildDateRange(custom("2026-11-01", "2026-11-10"), NOW)).toEqual({
            range: [localIso(2026, 11, 1), localIso(2026, 11, 10, 23, 59, 59, 999)],
        });
    });

    it("custom single day spans 00:00:00.000 to 23:59:59.999 of that day", () => {
        expect(buildDateRange(custom("2026-11-11", "2026-11-11"), NOW).range).toEqual([
            localIso(2026, 11, 11),
            localIso(2026, 11, 11, 23, 59, 59, 999),
        ]);
    });

    it("custom range across a month/year boundary", () => {
        expect(buildDateRange(custom("2025-12-31", "2026-01-01"), NOW).range).toEqual([
            localIso(2025, 12, 31),
            localIso(2026, 1, 1, 23, 59, 59, 999),
        ]);
    });

    it("from-only ends at now", () => {
        expect(buildDateRange(custom("2026-11-10", ""), NOW).range).toEqual([localIso(2026, 11, 10), NOW.toISOString()]);
    });

    it("from-only on today is still valid (start of today <= now)", () => {
        expect(buildDateRange(custom("2026-11-12", ""), NOW).error).toBeUndefined();
    });

    it("to-only starts at the Unix epoch", () => {
        expect(buildDateRange(custom("", "2026-11-10"), NOW).range).toEqual([
            "1970-01-01T00:00:00.000Z",
            localIso(2026, 11, 10, 23, 59, 59, 999),
        ]);
    });

    it("from after to is an invalid range with no range sent", () => {
        expect(buildDateRange(custom("2026-11-10", "2026-11-09"), NOW)).toEqual({ range: null, error: "invalidRange" });
    });

    it("a future from-date without a to-date reports futureStart (not invalidRange)", () => {
        expect(buildDateRange(custom("2026-11-13", ""), NOW)).toEqual({ range: null, error: "futureStart" });
        // An unparsable to-date is ignored, so it is still a from-only range.
        expect(buildDateRange(custom("2026-11-13", "2026-02-30"), NOW)).toEqual({ range: null, error: "futureStart" });
    });

    it("a future from-date with an earlier to-date reports invalidRange", () => {
        expect(buildDateRange(custom("2026-11-20", "2026-11-15"), NOW)).toEqual({ range: null, error: "invalidRange" });
    });

    it("start equal to end is a valid range (boundary is inclusive)", () => {
        // from-only with now exactly at local midnight of the from-day: start === end.
        const midnight = new Date(2026, 10, 12, 0, 0, 0, 0);
        expect(buildDateRange(custom("2026-11-12", ""), midnight)).toEqual({
            range: [midnight.toISOString(), midnight.toISOString()],
        });
        // One millisecond earlier the from-day is in the future.
        expect(buildDateRange(custom("2026-11-12", ""), new Date(midnight.getTime() - 1)).error).toBe("futureStart");
        // from === to on the same day is valid.
        expect(buildDateRange(custom("2026-11-12", "2026-11-12"), NOW).error).toBeUndefined();
    });

    it("custom with no valid dates means no filter", () => {
        expect(buildDateRange(custom("", ""), NOW)).toEqual({ range: null });
        expect(buildDateRange(custom("garbage", "2026-02-31"), NOW)).toEqual({ range: null });
    });

    it("an invalid side is ignored and the other side is used", () => {
        expect(buildDateRange(custom("not-a-date", "2026-11-10"), NOW).range?.[0]).toBe("1970-01-01T00:00:00.000Z");
        expect(buildDateRange(custom("2026-11-10", "2026-02-30"), NOW).range).toEqual([
            localIso(2026, 11, 10),
            NOW.toISOString(),
        ]);
    });
});

// The cases above compute expectations with local-time helpers, so they would
// still pass if parsing silently used UTC on a UTC runner (CI). These pin the
// exact UTC instants for non-UTC zones.
describe.each([
    {
        tz: "Asia/Tokyo",
        offsetMinutes: -540,
        day: ["2026-11-11T15:00:00.000Z", "2026-11-12T14:59:59.999Z"],
        // Japan has no DST; the same offset applies on 2026-03-08.
        dstDay: ["2026-03-07T15:00:00.000Z", "2026-03-08T14:59:59.999Z"],
    },
    {
        tz: "America/Los_Angeles",
        offsetMinutes: 480,
        day: ["2026-11-12T08:00:00.000Z", "2026-11-13T07:59:59.999Z"],
        // 2026-03-08 is the spring-forward day: starts PST (-8), ends PDT (-7).
        dstDay: ["2026-03-08T08:00:00.000Z", "2026-03-09T06:59:59.999Z"],
    },
])("local-date boundaries in $tz", ({ tz, offsetMinutes, day, dstDay }) => {
    let originalTz: string | undefined;
    let originalOffset = 0;

    beforeEach(() => {
        originalTz = process.env.TZ;
        originalOffset = new Date(2026, 10, 12).getTimezoneOffset();
        process.env.TZ = tz;
        // Guard: fail loudly if the runtime ignores the TZ switch.
        expect(new Date(2026, 10, 12).getTimezoneOffset()).toBe(offsetMinutes);
    });

    afterEach(() => {
        if (originalTz == null) {
            process.env.TZ = RUNNER_TIME_ZONE;
            delete process.env.TZ;
        } else {
            process.env.TZ = originalTz;
        }
        // The runner's zone must really be back for the other tests.
        expect(new Date(2026, 10, 12).getTimezoneOffset()).toBe(originalOffset);
    });

    it("parseLocalDate maps a day to local 00:00:00.000 and 23:59:59.999", () => {
        expect(parseLocalDate("2026-11-12", false)?.toISOString()).toBe(day[0]);
        expect(parseLocalDate("2026-11-12", true)?.toISOString()).toBe(day[1]);
    });

    it("custom single-day range covers exactly that local day", () => {
        const now = new Date("2026-12-01T00:00:00.000Z");
        expect(buildDateRange(custom("2026-11-12", "2026-11-12"), now)).toEqual({ range: day });
    });

    it("custom range on a DST transition day keeps the local day boundaries", () => {
        const now = new Date("2026-12-01T00:00:00.000Z");
        expect(buildDateRange(custom("2026-03-08", "2026-03-08"), now)).toEqual({ range: dstDay });
    });
});

describe("normalizeDateFilter", () => {
    it("drops unparsable or partially typed dates and fields a preset ignores", () => {
        expect(normalizeDateFilter(custom("0202-11-12", " 2026-11-10 "))).toEqual(custom("", "2026-11-10"));
        expect(normalizeDateFilter(custom("2026-02-30", ""))).toEqual(custom("", ""));
        expect(normalizeDateFilter({ preset: "7d", from: "2026-01-01", to: "2026-01-02" })).toEqual({
            preset: "7d",
            from: "",
            to: "",
        });
    });

    it("yields the same range as the raw selection", () => {
        for (const selection of [custom("0202-11-12", "2026-11-10"), custom("2026-11-01", "bad"), custom("2026-11-13", "")]) {
            expect(buildDateRange(normalizeDateFilter(selection), NOW)).toEqual(buildDateRange(selection, NOW));
        }
    });
});

describe("isDateFilterPreset", () => {
    it("narrows known presets only", () => {
        expect(isDateFilterPreset("2d")).toBe(true);
        expect(isDateFilterPreset("custom")).toBe(true);
        expect(isDateFilterPreset("3d")).toBe(false);
    });
});

describe("buildSearchFilters", () => {
    const base = { selectedProjectPath: "all", messageTypeFilter: "all" as const };

    it("sends no filters by default", () => {
        expect(buildSearchFilters({ ...base, dateFilter: { preset: "all", from: "", to: "" } }, NOW)).toEqual({
            filters: {},
        });
    });

    it("combines project (Windows path leaf), message type and date range", () => {
        const result = buildSearchFilters(
            {
                selectedProjectPath: "C:\\Users\\me\\.claude\\projects\\my-proj",
                messageTypeFilter: "user",
                dateFilter: { preset: "2d", from: "", to: "" },
            },
            NOW,
        );
        expect(result).toEqual({
            filters: {
                projects: ["my-proj"],
                messageType: "user",
                dateRange: [new Date(NOW.getTime() - 2 * DAY_MS).toISOString(), NOW.toISOString()],
            },
        });
    });

    it("reports an invalid range and omits dateRange", () => {
        const result = buildSearchFilters({ ...base, dateFilter: custom("2026-11-10", "2026-11-01") }, NOW);
        expect(result.error).toBe("invalidRange");
        expect(result.filters.dateRange).toBeUndefined();
    });

    it("passes futureStart through as the error", () => {
        const result = buildSearchFilters({ ...base, dateFilter: custom("2026-11-13", "") }, NOW);
        expect(result.error).toBe("futureStart");
        expect(result.filters.dateRange).toBeUndefined();
    });
});
