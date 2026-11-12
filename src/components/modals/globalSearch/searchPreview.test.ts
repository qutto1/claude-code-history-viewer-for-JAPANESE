import { describe, expect, it } from "vitest";
import {
    buildHighlightRegex,
    buildPreview,
    buildPreviewFromStrings,
    collectSearchableStrings,
    PREVIEW_CONTEXT_RADIUS,
    PREVIEW_FALLBACK_LENGTH,
    PREVIEW_MAX_NODES,
} from "./searchPreview";

const nest = (depth: number, leaf: unknown): unknown => {
    let value = leaf;
    for (let i = 0; i < depth; i++) value = i % 2 === 0 ? { level: value } : [value];
    return value;
};

describe("buildPreview", () => {
    it("shows the match from plain string content with surrounding context", () => {
        const before = "a".repeat(100);
        const after = "b".repeat(100);
        const preview = buildPreview({ content: `${before}NEEDLE${after}` }, "needle");
        expect(preview).toBe(`...${"a".repeat(PREVIEW_CONTEXT_RADIUS)}NEEDLE${"b".repeat(PREVIEW_CONTEXT_RADIUS)}...`);
    });

    it("omits ellipses when the match window reaches both ends", () => {
        expect(buildPreview({ content: "find the needle here" }, "needle")).toBe("find the needle here");
    });

    it("matches case-insensitively", () => {
        expect(buildPreview({ content: "Hello World" }, "WORLD")).toBe("Hello World");
    });

    it("finds a match nested 8 levels deep in toolUseResult", () => {
        const preview = buildPreview(
            {
                content: [{ type: "text", text: "unrelated intro text" }],
                toolUseResult: nest(8, "deep payload with the 匿名化 keyword"),
            },
            "匿名化",
        );
        expect(preview).toContain("匿名化");
    });

    it("finds a match nested 5+ levels deep in tool_use input", () => {
        const preview = buildPreview(
            {
                content: [{ type: "tool_use", id: "toolu_1", name: "Edit", input: nest(6, "old_string target") }],
            },
            "target",
        );
        expect(preview).toBe("old_string target");
    });

    it("finds a match nested 5+ levels deep inside tool_result content", () => {
        // Regression: the old collector stopped at depth 4, so a hit this deep
        // inside tool_result.content fell back to the first 150 characters.
        const preview = buildPreview(
            {
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "toolu_1",
                        content: [
                            { type: "text", text: "first block without the term" },
                            { type: "nested", items: [{ deeper: [{ text: "deep block mentions preview" }] }] },
                        ],
                    },
                ],
            },
            "preview",
        );
        expect(preview).toBe("deep block mentions preview");
    });

    it("finds the match in a later string even when an earlier long string precedes it", () => {
        // Regression: the old collector joined everything and capped depth, so a
        // hit after large unrelated payloads fell back to the first 150 chars.
        const preview = buildPreview(
            {
                content: [{ type: "text", text: "x".repeat(10_000) }],
                toolUse: { input: { a: { b: { c: { d: { e: "needle in toolUse" } } } } } },
            },
            "needle",
        );
        expect(preview).toBe("needle in toolUse");
    });

    it("falls back to ids/type tags only when nothing human-readable matches", () => {
        const preview = buildPreview(
            { content: [{ type: "tool_use", id: "toolu_ABCDEF", name: "Bash", input: { command: "ls" } }] },
            "abcdef",
        );
        expect(preview).toBe("toolu_ABCDEF");
    });

    it("does not let an exhaustive-only string win the no-match fallback", () => {
        const preview = buildPreview(
            { content: [{ type: "thinking", thinking: "real thought", signature: "SIGNATURE_BLOB" }] },
            "zzz-no-match",
        );
        expect(preview).toBe("real thought");
    });

    it("uses the first 150 characters (whitespace normalized) when nothing matches", () => {
        const text = `line one\n\n   line two ${"y".repeat(300)}`;
        const preview = buildPreview({ content: text }, "absent");
        expect(preview).toBe(`line one line two ${"y".repeat(300)}`.slice(0, PREVIEW_FALLBACK_LENGTH) + "...");
    });

    it("uses the fallback for queries shorter than 2 characters", () => {
        expect(buildPreview({ content: "abc def" }, "d")).toBe("abc def");
    });

    it("normalizes whitespace inside the match snippet", () => {
        expect(buildPreview({ content: "foo\n\n\tneedle   bar" }, "needle")).toBe("foo needle bar");
    });

    it("returns null only when the message has no strings at all", () => {
        expect(buildPreview({ content: [] }, "needle")).toBeNull();
        expect(buildPreview({ content: "   \n " }, "needle")).toBeNull();
        expect(buildPreview({ content: [{ type: "image", source: { data: 1 } }] }, "needle")).toBe("image");
    });

    it("covers text, thinking, tool name, toolUse and other items", () => {
        const strings = collectSearchableStrings({
            content: [
                { type: "text", text: "T" },
                { type: "thinking", thinking: "TH" },
                { type: "tool_use", name: "NAME", input: { k: "IN" } },
                { type: "tool_result", content: "RES" },
                { type: "custom_block", payload: "OTHER" },
            ],
            toolUse: { x: "TU" },
            toolUseResult: "TUR",
        });
        expect(strings.primary).toEqual(["T", "TH", "NAME", "IN", "RES", "custom_block", "OTHER", "TU", "TUR"]);
        expect(strings.exhaustive).toEqual(expect.arrayContaining(["text", "thinking", "tool_use", "tool_result"]));
        expect(strings.truncated).toBe(false);
    });

    it("stops at the node budget and reports truncation", () => {
        const big = Array.from({ length: 100 }, (_, i) => `item ${i}`);
        big.push("needle at the end");
        const strings = collectSearchableStrings({ toolUseResult: big }, 50);
        expect(strings.truncated).toBe(true);
        expect(strings.primary.length).toBeLessThan(50);
        expect(buildPreviewFromStrings(strings, "needle")).toBe("item 0");
    });

    it("does not count numbers/booleans/null toward the budget", () => {
        const values: unknown[] = Array.from({ length: PREVIEW_MAX_NODES + 1 }, (_, i) => i);
        values.push(true, null, "needle after many numbers");
        const strings = collectSearchableStrings({ toolUseResult: values });
        expect(strings.truncated).toBe(false);
        expect(buildPreviewFromStrings(strings, "needle")).toBe("needle after many numbers");
    });

    it("collects strings inside a 100k array of objects within the budget", () => {
        // Regression guard: a breadth-first budget spent on the 100k sibling
        // objects would never reach their strings and yield no preview.
        const wide = { items: Array.from({ length: 100_000 }, (_, i) => ({ k: `value ${i}` })) };
        const strings = collectSearchableStrings({ toolUseResult: wide });
        expect(strings.truncated).toBe(true);
        expect(strings.primary.slice(0, 2)).toEqual(["value 0", "value 1"]);
        expect(strings.primary.length).toBeGreaterThan(PREVIEW_MAX_NODES / 2 - 10);
        expect(buildPreviewFromStrings(strings, "value 42")).toBe("value 42");
        expect(buildPreviewFromStrings(strings, "absent")).toBe("value 0");
    });

    it("stops a 100k string array at the budget", () => {
        const big = Array.from({ length: 100_000 }, (_, i) => `entry ${i}`);
        const strings = collectSearchableStrings({ toolUseResult: big });
        expect(strings.truncated).toBe(true);
        // Root container + strings never exceed the per-tier budget.
        expect(strings.primary.length).toBeLessThanOrEqual(PREVIEW_MAX_NODES);
        expect(strings.primary.length).toBeGreaterThan(PREVIEW_MAX_NODES - 10);
        expect(strings.primary[0]).toBe("entry 0");
    });

    it("previews the strings collected so far when the budget runs out (not null)", () => {
        const strings = collectSearchableStrings(
            { toolUseResult: { a: "kept string", b: Array.from({ length: 100 }, () => ({})) } },
            10,
        );
        expect(strings.truncated).toBe(true);
        expect(buildPreviewFromStrings(strings, "absent")).toBe("kept string");
    });

    it("does not repeat primary strings in the exhaustive tier", () => {
        const strings = collectSearchableStrings({
            content: [{ type: "tool_use", id: "toolu_X", name: "Bash", input: { command: "ls -la" } }],
        });
        expect(strings.primary).toEqual(["Bash", "ls -la"]);
        expect(strings.exhaustive).toEqual(["tool_use", "toolu_X"]);
    });

    it("finds a Unicode-lowercase-only match in non-ASCII text", () => {
        // 'İ' (U+0130) is not matched by the `i` regex for "i̇" but lowercases to it.
        expect(buildPreview({ content: "日本語 İstanbul" }, "i\u0307stanbul")).toBe("日本語 İstanbul");
    });

    it("never splits a surrogate pair at the context window edges", () => {
        const emoji = "\u{1F600}";
        const text = `${emoji.repeat(40)}aNEEDLE${"b".repeat(5)}${emoji.repeat(40)}`;
        const preview = buildPreview({ content: text }, "needle")!;
        const body = preview.replace(/^\.\.\./, "").replace(/\.\.\.$/, "");
        expect(preview.startsWith("...")).toBe(true);
        expect(preview.endsWith("...")).toBe(true);
        expect(body).toContain("NEEDLE");
        expect(body.charCodeAt(0)).toBe(emoji.charCodeAt(0));
        expect(body.charCodeAt(body.length - 1)).toBe(emoji.charCodeAt(1));
        expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    });

    it("never splits a surrogate pair in the 150-character fallback", () => {
        const text = "a" + "\u{1F600}".repeat(200);
        const preview = buildPreview({ content: text }, "absent")!;
        expect(preview.endsWith("...")).toBe(true);
        const body = preview.slice(0, -3);
        expect(body.length).toBe(PREVIEW_FALLBACK_LENGTH + 1);
        expect(body).not.toMatch(/[\uD800-\uDBFF]$/);
    });

    it("matches a query with repeated whitespace against collapsed preview text", () => {
        const preview = buildPreview({ content: "say foo \n\t bar here" }, "foo  bar")!;
        expect(preview).toBe("say foo bar here");
        const regex = buildHighlightRegex("foo  bar")!;
        expect(preview.split(regex)).toEqual(["say ", "foo bar", " here"]);
    });

    it("buildHighlightRegex escapes metacharacters and returns null for blank queries", () => {
        expect(buildHighlightRegex("   ")).toBeNull();
        expect("x foo(a+b) y".split(buildHighlightRegex("FOO(a+b)")!)).toEqual(["x ", "foo(a+b)", " y"]);
    });

    it("handles deeply nested values without recursion limits", () => {
        const deep = nest(5_000, "bottom needle");
        expect(buildPreview({ toolUseResult: deep }, "needle")).toBe("bottom needle");
    });

    it("escapes regex metacharacters in the query", () => {
        expect(buildPreview({ content: "call foo(a+b) now" }, "foo(a+b)")).toBe("call foo(a+b) now");
    });
});
