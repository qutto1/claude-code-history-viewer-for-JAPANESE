import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputHTMLAttributes, ReactNode } from "react";
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
