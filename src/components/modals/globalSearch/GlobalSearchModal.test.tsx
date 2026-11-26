import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, type InputHTMLAttributes, type ReactNode } from "react";
import { toast } from "sonner";
import { GlobalSearchModal } from "./GlobalSearchModal";

type MockProps = {
    children?: ReactNode;
    open?: boolean;
    [key: string]: unknown;
};

vi.mock("@/components/ui", () => ({
    Dialog: ({ open, children }: MockProps) => (open ? <div>{children}</div> : null),
    DialogContent: ({ children, ...props }: MockProps) => {
        delete props.showCloseButton;
        delete props.overlayClassName;
        return <div {...props}>{children}</div>;
    },
    Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Select: ({ children }: MockProps) => <div>{children}</div>,
    SelectContent: ({ children }: MockProps) => <div>{children}</div>,
    SelectItem: ({ children, ...props }: MockProps) => <div {...props}>{children}</div>,
    SelectTrigger: ({ children, ...props }: MockProps) => <button {...props}>{children}</button>,
    SelectValue: ({ children }: MockProps) => <span>{children}</span>,
    Badge: ({ children, ...props }: MockProps) => <div {...props}>{children}</div>,
}));

// The modal imports Select from "@/components/ui/select" (Radix); swap in a
// native <select> so presets can be chosen in jsdom.
vi.mock("@/components/ui/select", () => ({
    Select: ({
        value,
        onValueChange,
        children,
    }: MockProps & { value?: string; onValueChange?: (value: string) => void }) => (
        <select value={value} onChange={(e) => onValueChange?.(e.target.value)}>
            {children}
        </select>
    ),
    SelectContent: ({ children }: MockProps) => <>{children}</>,
    SelectItem: ({ children, value }: MockProps & { value?: string }) => <option value={value}>{children}</option>,
    SelectTrigger: () => null,
    SelectValue: () => null,
}));

const { mockApi, storeState, translate, useAppStoreMock } = vi.hoisted(() => {
    const state = {
        claudePath: "",
        projects: [],
        selectProject: vi.fn(),
        selectSession: vi.fn(),
        sessions: [],
        getSessionDisplayName: vi.fn(),
        activeProviders: ["claude"],
        navigateToMessage: vi.fn(),
        clearTargetMessage: vi.fn(),
        setAnalyticsCurrentView: vi.fn(),
        userMetadata: {
            settings: {
                wsl: {
                    enabled: true,
                    excludedDistros: [],
                },
            },
        },
    };

    const store = Object.assign(() => state, {
        getState: () => state,
    });

    return {
        mockApi: vi.fn(),
        storeState: state,
        translate: (key: string, fallback?: unknown) => (typeof fallback === "string" ? fallback : key),
        useAppStoreMock: store,
    };
});

vi.mock("@/services/api", () => ({
    api: mockApi,
}));

vi.mock("@/store/useAppStore", () => ({
    useAppStore: useAppStoreMock,
}));

vi.mock("react-i18next", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-i18next")>();
    return {
        ...actual,
        useTranslation: () => ({
            t: translate,
        }),
    };
});

vi.mock("sonner", () => ({
    toast: {
        error: vi.fn(),
    },
}));

// "global-search:<uuid v4>"
const CANCEL_GROUP_PATTERN = /^global-search:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cancelArgs = () => ({
    cancelGroup: expect.stringMatching(CANCEL_GROUP_PATTERN),
    cancelSeq: expect.any(Number),
});

describe("GlobalSearchModal WSL search routing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockApi.mockResolvedValue([]);
        storeState.claudePath = "";
        storeState.activeProviders = ["claude"];
        storeState.userMetadata.settings.wsl.enabled = true;
    });

    it("searches WSL when no native Claude path is configured", async () => {
        storeState.activeProviders = ["claude", "codex"];
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);

        fireEvent.change(screen.getByPlaceholderText("globalSearch.placeholder"), {
            target: { value: "hello" },
        });

        await waitFor(() => {
            expect(mockApi).toHaveBeenCalledWith(
                "search_all_providers",
                expect.objectContaining({
                    claudePath: undefined,
                    query: "hello",
                    activeProviders: ["claude", "codex"],
                    wslEnabled: true,
                    wslProviders: ["claude"],
                    ...cancelArgs(),
                }),
            );
        });
    });

    it("searches a Codex-only installation without a native Claude path", async () => {
        storeState.activeProviders = ["codex"];
        storeState.userMetadata.settings.wsl.enabled = false;

        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);

        fireEvent.change(screen.getByPlaceholderText("globalSearch.placeholder"), {
            target: { value: "hello" },
        });

        await waitFor(() => {
            expect(mockApi).toHaveBeenCalledWith(
                "search_all_providers",
                expect.objectContaining({
                    claudePath: undefined,
                    query: "hello",
                    activeProviders: ["codex"],
                    wslEnabled: false,
                    ...cancelArgs(),
                }),
            );
        });
    });

    it("keeps the native search path when native Claude is available", async () => {
        storeState.claudePath = "/home/user/.claude";
        storeState.userMetadata.settings.wsl.enabled = false;

        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);

        fireEvent.change(screen.getByPlaceholderText("globalSearch.placeholder"), {
            target: { value: "hello" },
        });

        await waitFor(() => {
            expect(mockApi).toHaveBeenCalledWith(
                "search_messages",
                expect.objectContaining({
                    claudePath: "/home/user/.claude",
                    query: "hello",
                    ...cancelArgs(),
                }),
            );
        });
    });
});

describe("GlobalSearchModal date filter", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    type SearchCallArgs = { filters?: { dateRange?: [string, string] } };
    const searchCalls = () =>
        mockApi.mock.calls
            .filter(([command]) => command === "search_messages")
            .map(([, args]) => args as SearchCallArgs);

    beforeEach(() => {
        vi.clearAllMocks();
        mockApi.mockResolvedValue([]);
        storeState.claudePath = "/home/user/.claude";
        storeState.activeProviders = ["claude"];
        storeState.userMetadata.settings.wsl.enabled = false;
    });

    const typeQuery = async () => {
        fireEvent.change(screen.getByPlaceholderText("globalSearch.placeholder"), {
            target: { value: "hello" },
        });
        await waitFor(() => expect(searchCalls().length).toBeGreaterThan(0));
    };

    it("sends no dateRange by default", async () => {
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        await typeQuery();
        expect(searchCalls()[0]?.filters?.dateRange).toBeUndefined();
    });

    it("re-searches with a 2-day dateRange when the preset is selected", async () => {
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        await typeQuery();

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "2d" } });

        await waitFor(() => {
            const range = searchCalls().at(-1)?.filters?.dateRange;
            expect(range).toHaveLength(2);
        });
        const [start, end] = searchCalls().at(-1)!.filters!.dateRange!;
        expect(Date.parse(end) - Date.parse(start)).toBe(2 * DAY_MS);
        expect(Math.abs(Date.parse(end) - Date.now())).toBeLessThan(60_000);
    });

    it("clears the searching state when closed mid-search", async () => {
        mockApi.mockReturnValue(new Promise(() => {}));
        const { rerender } = render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        await typeQuery();
        rerender(<GlobalSearchModal isOpen={false} onClose={vi.fn()} />);
        rerender(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        expect(screen.getByText("globalSearch.hint")).toBeTruthy();
        expect(document.querySelector(".animate-pulse")).toBeNull();
    });

    it("does not search with an inverted custom range and shows a warning", async () => {
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        await typeQuery();

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
        fireEvent.change(screen.getByLabelText("globalSearch.dateFilter.from"), {
            target: { value: "2020-01-10" },
        });
        await waitFor(() => expect(searchCalls().at(-1)?.filters?.dateRange).toHaveLength(2));
        const callsBeforeInvalid = searchCalls().length;

        fireEvent.change(screen.getByLabelText("globalSearch.dateFilter.to"), {
            target: { value: "2020-01-01" },
        });

        expect((await screen.findByRole("alert")).textContent).toBe("globalSearch.dateFilter.invalidRange");
        expect(searchCalls().length).toBe(callsBeforeInvalid);
        for (const call of searchCalls()) {
            const range = call.filters?.dateRange;
            if (range) expect(Date.parse(range[0])).toBeLessThanOrEqual(Date.parse(range[1]));
        }
    });

    it("does not re-search while a date year is only partially typed", async () => {
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        await typeQuery();
        fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
        await waitFor(() => expect(searchCalls().length).toBeGreaterThan(1));
        await new Promise((resolve) => setTimeout(resolve, 20));
        const callsBefore = searchCalls().length;

        const from = screen.getByLabelText("globalSearch.dateFilter.from");
        for (const value of ["0002-11-12", "0020-11-12", "0202-11-12"]) {
            fireEvent.change(from, { target: { value } });
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(searchCalls().length).toBe(callsBefore);

        fireEvent.change(from, { target: { value: "2020-11-12" } });
        await waitFor(() => expect(searchCalls().at(-1)?.filters?.dateRange).toHaveLength(2));
    });

    it("shows a dedicated warning for a future from-date with no to-date", async () => {
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        await typeQuery();
        const callsBefore = searchCalls().length;

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
        fireEvent.change(screen.getByLabelText("globalSearch.dateFilter.from"), {
            target: { value: "2999-01-01" },
        });

        expect((await screen.findByRole("alert")).textContent).toBe("globalSearch.dateFilter.futureStart");
        // Switching to "custom" with no dates re-searches once without a range;
        // the future from-date must not reach the backend.
        for (const call of searchCalls().slice(callsBefore)) {
            expect(call.filters?.dateRange).toBeUndefined();
        }
    });
});

describe("GlobalSearchModal keyboard ownership and pending searches", () => {
    const RESULT = {
        uuid: "u1",
        sessionId: "s1",
        timestamp: "2026-11-12T00:00:00Z",
        type: "user",
        projectName: "p",
        content: "hello world",
    };
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    type SearchCallArgs = { query?: string; filters?: { dateRange?: [string, string] } };
    const searchCalls = () =>
        mockApi.mock.calls
            .filter(([command]) => command === "search_messages")
            .map(([, args]) => args as SearchCallArgs);
    const searchInput = () => screen.getByPlaceholderText("globalSearch.placeholder") as HTMLInputElement;

    beforeAll(() => {
        // jsdom has no layout; the modal scrolls the selected row into view.
        Element.prototype.scrollIntoView ??= () => {};
    });

    beforeEach(() => {
        vi.clearAllMocks();
        storeState.claudePath = "/home/user/.claude";
        storeState.activeProviders = ["claude"];
        storeState.userMetadata.settings.wsl.enabled = false;
    });

    const renderWithResult = async (onClose = vi.fn()) => {
        mockApi.mockResolvedValue([RESULT]);
        render(<GlobalSearchModal isOpen onClose={onClose} />);
        fireEvent.change(searchInput(), { target: { value: "hello" } });
        // Result navigation only runs when there is at least one result.
        await screen.findByText(/world/);
        return onClose;
    };

    it("leaves arrow/Enter/Escape inside the date inputs and selects to those controls", async () => {
        const onClose = await renderWithResult();
        fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
        await screen.findByText(/world/);

        for (const control of [
            screen.getByLabelText("globalSearch.dateFilter.from"),
            screen.getByLabelText("globalSearch.dateFilter.to"),
            screen.getByRole("combobox"),
        ]) {
            for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) {
                // fireEvent returns false when the handler called preventDefault.
                expect(fireEvent.keyDown(control, { key })).toBe(true);
            }
        }
        await sleep(20);
        expect(onClose).not.toHaveBeenCalled();
    });

    it("still drives the result list from the search input and filter buttons", async () => {
        const onClose = await renderWithResult();
        expect(fireEvent.keyDown(searchInput(), { key: "ArrowDown" })).toBe(false);
        expect(fireEvent.keyDown(screen.getByRole("button", { name: "globalSearch.filterType.user" }), { key: "ArrowUp" })).toBe(
            false,
        );
        fireEvent.keyDown(searchInput(), { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(searchInput(), { key: "Enter" });
        // Enter opens the selected result (not found here), which also closes.
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
    });

    it("keeps previews/highlights on the searched query while a new query is typed", async () => {
        await renderWithResult();
        expect(document.querySelector("mark")?.textContent).toBe("hello");
        // Before the debounce fires, the shown results still belong to "hello".
        fireEvent.change(searchInput(), { target: { value: "zz" } });
        expect(document.querySelector("mark")?.textContent).toBe("hello");
    });

    it("a filter change during the debounce window supersedes the pending keystroke search", async () => {
        mockApi.mockResolvedValue([]);
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        fireEvent.change(searchInput(), { target: { value: "hello" } });
        await sleep(50);
        fireEvent.change(screen.getByRole("combobox"), { target: { value: "2d" } });
        await sleep(450);

        // Exactly one search, and it carries the new date range (the stale
        // timer must neither win nor fire a duplicate).
        expect(searchCalls()).toHaveLength(1);
        expect(searchCalls()[0]?.query).toBe("hello");
        expect(searchCalls()[0]?.filters?.dateRange).toHaveLength(2);
    });

    it("closing within the debounce window cancels the pending search", async () => {
        mockApi.mockResolvedValue([RESULT]);
        const { rerender } = render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        fireEvent.change(searchInput(), { target: { value: "hello" } });
        rerender(<GlobalSearchModal isOpen={false} onClose={vi.fn()} />);
        await sleep(450);
        rerender(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        await sleep(20);

        expect(searchInput().value).toBe("");
        expect(screen.queryAllByText(/world/)).toHaveLength(0);
        expect(searchCalls()).toHaveLength(0);
    });

    it("the clear button cancels the pending search", async () => {
        await renderWithResult();
        const callsBefore = searchCalls().length;
        fireEvent.change(searchInput(), { target: { value: "hello again" } });
        fireEvent.click(screen.getByRole("button", { name: "globalSearch.clearSearch" }));
        await sleep(450);

        expect(searchInput().value).toBe("");
        expect(screen.queryAllByText(/world/)).toHaveLength(0);
        expect(searchCalls()).toHaveLength(callsBefore);
    });
});

describe("GlobalSearchModal search cancellation", () => {
    const resultFor = (content: string) => ({
        uuid: content,
        sessionId: "s1",
        timestamp: "2026-11-12T00:00:00Z",
        type: "user",
        projectName: "p",
        content,
    });
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    type CallArgs = { query?: string; cancelGroup: string; cancelSeq: number };
    type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };

    // Searches stay in flight until the test settles them.
    let pendingSearches: Pending[] = [];
    const holdSearches = (onCancel: () => Promise<unknown> = () => Promise.resolve(null)) => {
        mockApi.mockImplementation((command: string) => {
            if (command === "cancel_search") return onCancel();
            if (command !== "search_messages" && command !== "search_all_providers") {
                return Promise.resolve([]);
            }
            return new Promise((resolve, reject) => {
                pendingSearches.push({ resolve, reject });
            });
        });
    };

    const callLog = () =>
        mockApi.mock.calls.map(([command, args]) => ({ command: command as string, args: args as CallArgs }));
    const searchCalls = () =>
        callLog().filter((c) => c.command === "search_messages" || c.command === "search_all_providers");
    const cancelCalls = () => callLog().filter((c) => c.command === "cancel_search");

    const searchInput = () => screen.getByPlaceholderText("globalSearch.placeholder") as HTMLInputElement;
    const type = (value: string) => fireEvent.change(searchInput(), { target: { value } });
    const spinner = () => document.querySelector(".animate-spin");
    const waitForSearches = (count: number) => waitFor(() => expect(searchCalls()).toHaveLength(count));
    const startSearch = async (value: string) => {
        const count = searchCalls().length + 1;
        type(value);
        await waitForSearches(count);
        return searchCalls()[count - 1]!.args;
    };
    const settle = async (action: () => void) => {
        await act(async () => {
            action();
        });
    };

    /** Every search issued after a cancel must carry a higher seq than it. */
    const expectLaterSearchesToOutrankCancels = () => {
        let highestCancelled = -1;
        for (const { command, args } of callLog()) {
            if (command === "cancel_search") highestCancelled = Math.max(highestCancelled, args.cancelSeq);
            else if (command.startsWith("search_")) expect(args.cancelSeq).toBeGreaterThan(highestCancelled);
        }
    };

    beforeAll(() => {
        Element.prototype.scrollIntoView ??= () => {};
    });

    beforeEach(() => {
        vi.clearAllMocks();
        pendingSearches = [];
        storeState.claudePath = "/home/user/.claude";
        storeState.activeProviders = ["claude"];
        storeState.userMetadata.settings.wsl.enabled = false;
        holdSearches();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each([
        ["search_messages", ["claude"]],
        ["search_all_providers", ["claude", "codex"]],
    ])("passes one cancel group per mount and a rising seq to %s", async (command, providers) => {
        storeState.activeProviders = providers;
        const first = render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        const one = await startSearch("hello");
        const two = await startSearch("hello again");

        expect(searchCalls().map((c) => c.command)).toEqual([command, command]);
        expect(one.cancelGroup).toMatch(CANCEL_GROUP_PATTERN);
        expect(two.cancelGroup).toBe(one.cancelGroup);
        expect(Number.isSafeInteger(one.cancelSeq)).toBe(true);
        expect(two.cancelSeq).toBeGreaterThan(one.cancelSeq);
        first.unmount();

        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        const other = await startSearch("hello");
        expect(other.cancelGroup).toMatch(CANCEL_GROUP_PATTERN);
        expect(other.cancelGroup).not.toBe(one.cancelGroup);
    });

    it("builds a cancel group where crypto.randomUUID is missing (WebUI over plain HTTP)", async () => {
        const realCrypto = globalThis.crypto;
        vi.stubGlobal("crypto", {
            getRandomValues: (array: Uint8Array) => realCrypto.getRandomValues(array),
        });
        const first = render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        const one = await startSearch("hello");
        first.unmount();
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        const other = await startSearch("hello");

        expect(one.cancelGroup).toMatch(CANCEL_GROUP_PATTERN);
        expect(other.cancelGroup).toMatch(CANCEL_GROUP_PATTERN);
        expect(other.cancelGroup).not.toBe(one.cancelGroup);
    });

    it("cancels the running search as soon as the input changes", async () => {
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        const running = await startSearch("hello");
        expect(cancelCalls()).toHaveLength(0);

        type("hello w");
        // Before the debounce fires, and exactly once however much is typed.
        type("hello wo");
        expect(cancelCalls().map((c) => c.args)).toEqual([
            { cancelGroup: running.cancelGroup, cancelSeq: running.cancelSeq },
        ]);
        expect(searchCalls()).toHaveLength(1);

        await waitForSearches(2);
        expect(searchCalls()[1]!.args.cancelSeq).toBeGreaterThan(running.cancelSeq);
        expect(cancelCalls()).toHaveLength(1);
        expectLaterSearchesToOutrankCancels();
    });

    it("cancels the running search when the input drops below the minimum length", async () => {
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        const running = await startSearch("hello");

        type("h");

        expect(cancelCalls().map((c) => c.args.cancelSeq)).toEqual([running.cancelSeq]);
        await waitFor(() => expect(spinner()).toBeNull());
        expect(searchCalls()).toHaveLength(1);
        expect(screen.getByText("globalSearch.tips.minChars", { selector: "div" })).toBeTruthy();
    });

    it.each([
        [
            "the date preset",
            () => fireEvent.change(screen.getByRole("combobox"), { target: { value: "2d" } }),
        ],
        [
            "the message type",
            () => fireEvent.click(screen.getByRole("button", { name: "globalSearch.filterType.user" })),
        ],
    ])("cancels the running search when %s changes", async (_name, changeFilter) => {
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        const running = await startSearch("hello");

        changeFilter();

        await waitForSearches(2);
        expect(cancelCalls().map((c) => c.args)).toEqual([
            { cancelGroup: running.cancelGroup, cancelSeq: running.cancelSeq },
        ]);
        expect(searchCalls()[1]!.args.cancelSeq).toBeGreaterThan(running.cancelSeq);
        expectLaterSearchesToOutrankCancels();
    });

    it("cancels the running search when a filter makes the search impossible", async () => {
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        await startSearch("hello");
        fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
        await waitForSearches(2);
        const running = searchCalls()[1]!.args;

        fireEvent.change(screen.getByLabelText("globalSearch.dateFilter.from"), {
            target: { value: "2999-01-01" },
        });

        await screen.findByRole("alert");
        expect(cancelCalls()).toHaveLength(2);
        expect(cancelCalls()[1]!.args.cancelSeq).toBe(running.cancelSeq);
        expect(searchCalls()).toHaveLength(2);
        expect(spinner()).toBeNull();
    });

    it("cancels the running search on close, and the next one outranks it", async () => {
        const { rerender } = render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        const running = await startSearch("hello");

        rerender(<GlobalSearchModal isOpen={false} onClose={vi.fn()} />);
        expect(cancelCalls().map((c) => c.args)).toEqual([
            { cancelGroup: running.cancelGroup, cancelSeq: running.cancelSeq },
        ]);

        rerender(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        const next = await startSearch("hello");
        expect(next.cancelGroup).toBe(running.cancelGroup);
        expect(next.cancelSeq).toBeGreaterThan(running.cancelSeq);
        expectLaterSearchesToOutrankCancels();
    });

    it("cancels the running search on unmount", async () => {
        const { unmount } = render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        const running = await startSearch("hello");

        unmount();

        expect(cancelCalls().map((c) => c.args)).toEqual([
            { cancelGroup: running.cancelGroup, cancelSeq: running.cancelSeq },
        ]);
    });

    it("shows nothing for a search that fails after unmount", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const { unmount } = render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        await startSearch("hello");
        unmount();

        await settle(() => pendingSearches[0]!.reject(new Error("disk error")));

        expect(toast.error).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
    });

    it("keeps its seq invariant under StrictMode's extra effect run", async () => {
        render(
            <StrictMode>
                <GlobalSearchModal isOpen onClose={vi.fn()} />
            </StrictMode>,
        );
        const running = await startSearch("hello");
        type("hello again");
        await waitForSearches(2);

        expect(searchCalls()[1]!.args.cancelGroup).toBe(running.cancelGroup);
        expect(cancelCalls().map((c) => c.args.cancelSeq)).toEqual([running.cancelSeq]);
        expectLaterSearchesToOutrankCancels();
    });

    it("does not call cancel_search when no search is running", async () => {
        const { rerender, unmount } = render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        // Inside the debounce window nothing has been sent yet.
        type("he");
        type("hello");
        await waitForSearches(1);
        await settle(() => pendingSearches[0]!.resolve([resultFor("hello world")]));

        type("hello again");
        fireEvent.click(screen.getByRole("button", { name: "globalSearch.clearSearch" }));
        fireEvent.change(screen.getByRole("combobox"), { target: { value: "2d" } });
        rerender(<GlobalSearchModal isOpen={false} onClose={vi.fn()} />);
        rerender(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        type("hello");
        unmount();
        await sleep(20);

        expect(cancelCalls()).toHaveLength(0);
    });

    it("does not call cancel_search after a search has failed", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { unmount } = render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        await startSearch("hello");
        await settle(() => pendingSearches[0]!.reject(new Error("disk error")));

        // Other errors are still reported.
        expect(toast.error).toHaveBeenCalledWith("globalSearch.searchFailed");
        expect(spinner()).toBeNull();
        unmount();
        expect(cancelCalls()).toHaveLength(0);
    });

    it("swallows a failing cancel_search", async () => {
        holdSearches(() => Promise.reject(new Error("cancel failed")));
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const { unmount } = render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        await startSearch("hello");
        await startSearch("hello again");
        unmount();
        // An unhandled rejection here would fail the test run.
        await sleep(20);

        expect(cancelCalls()).toHaveLength(2);
        expect(toast.error).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
    });

    // Tauri's invoke rejects with the string itself; the WebUI api() wraps it.
    const CANCEL_ERRORS: [string, () => unknown][] = [
        ["Tauri string", () => "search cancelled"],
        ["WebUI Error", () => new Error("search cancelled")],
    ];

    it.each(CANCEL_ERRORS)(
        "leaves the newer search alone when the old one ends as cancelled (%s)",
        async (_name, cancelError) => {
            const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
            render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
            await startSearch("hello");
            await startSearch("world");

            await settle(() => pendingSearches[0]!.reject(cancelError()));

            expect(spinner()).not.toBeNull();
            expect(toast.error).not.toHaveBeenCalled();
            expect(consoleError).not.toHaveBeenCalled();

            await settle(() => pendingSearches[1]!.resolve([resultFor("world peace")]));
            expect(spinner()).toBeNull();
            expect(screen.getByText(/peace/)).toBeTruthy();
        },
    );

    it.each(CANCEL_ERRORS)(
        "reports no error when the current search ends as cancelled (%s)",
        async (_name, cancelError) => {
            const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
            const { unmount } = render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
            await startSearch("hello");

            await settle(() => pendingSearches[0]!.reject(cancelError()));

            expect(spinner()).toBeNull();
            expect(toast.error).not.toHaveBeenCalled();
            expect(consoleError).not.toHaveBeenCalled();
            unmount();
            expect(cancelCalls()).toHaveLength(0);
        },
    );

    it("keeps loading while typing even if the old search ends inside the debounce window", async () => {
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        await startSearch("hello");
        type("world");

        await settle(() => pendingSearches[0]!.reject("search cancelled"));

        expect(spinner()).not.toBeNull();
        expect(screen.queryByText("globalSearch.noResults")).toBeNull();
        await waitForSearches(2);
    });

    it("sends the cancel keys through the WebUI api() and recognises its cancelled error", async () => {
        const { api: webUiApi } = await vi.importActual<typeof import("@/services/api")>("@/services/api");
        mockApi.mockImplementation(webUiApi);
        const requests: { command: string; body: CallArgs; respond: (response: Response) => void }[] = [];
        vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
            new Promise<Response>((respond) => {
                const command = url.split("/api/")[1]!;
                requests.push({ command, body: JSON.parse(init.body as string) as CallArgs, respond });
            }),
        );
        const sent = (name: string) => requests.filter((r) => r.command === name);
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);

        type("hello");
        await waitFor(() => expect(sent("search_messages")).toHaveLength(1));
        type("world");
        await waitFor(() => expect(sent("search_messages")).toHaveLength(2));
        const [first, second] = sent("search_messages");
        expect(first!.body.cancelGroup).toMatch(CANCEL_GROUP_PATTERN);
        expect(sent("cancel_search").map((r) => r.body)).toEqual([
            { cancelGroup: first!.body.cancelGroup, cancelSeq: first!.body.cancelSeq },
        ]);

        // The shape of the server's ApiError response.
        await settle(() =>
            second!.respond(new Response(JSON.stringify({ error: "search cancelled" }), { status: 500 })),
        );

        await waitFor(() => expect(spinner()).toBeNull());
        expect(toast.error).not.toHaveBeenCalled();
        // api() logs every failed request itself; the modal adds nothing.
        expect(consoleError.mock.calls.map(([message]) => message)).toEqual(["API error [search_messages]:"]);
    });

    it("ignores results of a cancelled search that finished anyway", async () => {
        render(<GlobalSearchModal isOpen onClose={vi.fn()} />);
        await startSearch("hello");
        await startSearch("world");

        await settle(() => pendingSearches[0]!.resolve([resultFor("hello stale")]));
        expect(screen.queryByText(/stale/)).toBeNull();
        expect(spinner()).not.toBeNull();

        // The late answer must not make the newer search look finished.
        type("world peace");
        expect(cancelCalls()).toHaveLength(2);
        expect(cancelCalls()[1]!.args.cancelSeq).toBe(searchCalls()[1]!.args.cancelSeq);
    });
});
