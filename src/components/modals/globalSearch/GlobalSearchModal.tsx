import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { api } from "@/services/api";
import { useTranslation } from "react-i18next";
import {
    Search,
    ArrowUp,
    ArrowDown,
    CornerDownLeft,
    X,
    Loader2,
    Filter,
    User,
    Bot,
    MessageSquare,
    Lightbulb,
    CalendarDays,
} from "lucide-react";
import { Dialog, DialogContent, Input } from "@/components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useAppStore } from "@/store/useAppStore";
import type { ClaudeMessage, ClaudeProject, ClaudeSession } from "@/types";
import {
    getProviderLabel,
    getWslSearchableProviderIds,
    hasNonDefaultProvider,
    getProviderBadgeStyle,
} from "@/utils/providers";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { getPathLeaf, getProjectDisplayName } from "@/utils/pathUtils";
import { getLocale } from "@/utils/time";
import {
    buildDateRange,
    DATE_FILTER_PRESETS,
    DEFAULT_DATE_FILTER,
    isDateFilterPreset,
    normalizeDateFilter,
    type DateFilterPreset,
    type DateFilterSelection,
    type DateRangeError,
} from "./dateRangeFilter";
import { buildSearchFilters, type MessageTypeFilter } from "./searchFilters";
import {
    buildHighlightRegex,
    buildPreviewFromStrings,
    collectSearchableStrings,
    type SearchableStrings,
} from "./searchPreview";

type GlobalSearchResult = ClaudeMessage;

const DATE_PRESET_LABEL_KEYS = {
    all: "globalSearch.dateFilter.all",
    "24h": "globalSearch.dateFilter.last24h",
    "2d": "globalSearch.dateFilter.last2d",
    "7d": "globalSearch.dateFilter.last7d",
    "30d": "globalSearch.dateFilter.last30d",
    "90d": "globalSearch.dateFilter.last90d",
    custom: "globalSearch.dateFilter.custom",
} as const satisfies Record<DateFilterPreset, string>;

const DATE_ERROR_LABEL_KEYS = {
    invalidRange: "globalSearch.dateFilter.invalidRange",
    futureStart: "globalSearch.dateFilter.futureStart",
} as const satisfies Record<DateRangeError, string>;

// Keys pressed inside these controls belong to them (date spin, select/listbox
// navigation, Enter to pick, Esc to close the popup) and must not drive the
// result list.
const OWN_KEYBOARD_SELECTOR =
    'input[type="date"], select, [role="combobox"], [role="listbox"], [role="option"]';

interface GlobalSearchModalProps {
    isOpen: boolean;
    onClose: () => void;
}

// Backend has no offset paging; results are truncated at this count and the
// footer says so, so the user knows to narrow the query.
const MAX_RESULTS = 250;

// Conversation titles per project, shared across modal opens. Keyed by
// path + last_modified so a rescan that touched the project refetches.
const sessionTitleCache = new Map<string, Record<string, string>>();
const titleCacheKey = (project: ClaudeProject) => `${project.path}@${project.last_modified}`;
const TITLE_FETCH_CONCURRENCY = 3;

type SearchResultGroup = {
    label: string;
    provider?: string;
    pathUnavailable: boolean;
    project?: ClaudeProject;
    items: GlobalSearchResult[];
};

export const GlobalSearchModal = ({
    isOpen,
    onClose,
}: GlobalSearchModalProps) => {
    const { t, i18n } = useTranslation();
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<GlobalSearchResult[]>([]);
    // The query that produced `results`. Previews and highlights use it (not
    // the live input), so typing does not rebuild every preview per keystroke.
    const [lastSearchedQuery, setLastSearchedQuery] = useState("");
    const [isSearching, setIsSearching] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    // sessionId / actual_session_id → summary, filled lazily per project so
    // results can show the conversation title instead of an id prefix.
    const [sessionTitles, setSessionTitles] = useState<Record<string, string>>({});
    // Bumped when the modal closes or results change; abandons a title sweep.
    const titleSweepTokenRef = useRef(0);
    const [messageTypeFilter, setMessageTypeFilter] = useState<MessageTypeFilter>("all");
    const [dateFilter, setDateFilter] = useState<DateFilterSelection>(DEFAULT_DATE_FILTER);
    // Searches depend on the canonical selection, so typing a date (or editing
    // dates that a relative preset ignores) does not re-search until the
    // effective range actually changes.
    const { preset: searchDatePreset, from: searchDateFrom, to: searchDateTo } = normalizeDateFilter(dateFilter);
    const searchDateFilter = useMemo<DateFilterSelection>(
        () => ({ preset: searchDatePreset, from: searchDateFrom, to: searchDateTo }),
        [searchDatePreset, searchDateFrom, searchDateTo],
    );
    // Bumped per search request and on close; a response whose token is stale
    // (a newer search started, e.g. while a date is being typed) is dropped.
    const searchRequestTokenRef = useRef(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const resultsContainerRef = useRef<HTMLDivElement>(null);
    const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Bumped on every result click and on close — cancels an in-flight
    // session-resolution sweep so it stops issuing project requests.
    const resolveTokenRef = useRef(0);

    const { claudePath, projects, selectProject, selectSession, sessions, getSessionDisplayName, activeProviders, navigateToMessage, clearTargetMessage, setAnalyticsCurrentView, userMetadata } =
        useAppStore();
    const [selectedProjectPath, setSelectedProjectPath] = useState<string>("all");

    // Group results by project name
    const groupedResults = useMemo(() => {
        const groups = new Map<string, SearchResultGroup>();

        for (const result of results) {
            const projectName =
                result.projectName || t("globalSearch.unknownProject");
            const resultProvider = result.provider ?? "claude";
            // The backend labels results with the store directory name; the
            // project list may carry a decoded display name instead.
            const matchingProject = projects.find(
                (project) =>
                    (project.provider ?? "claude") === resultProvider &&
                    (project.name === projectName || getPathLeaf(project.path) === projectName)
            );
            const providerLabel = getProviderLabel(
                (key, fallback) => t(key, fallback),
                result.provider,
            );
            const groupKey = `${resultProvider}::${projectName}`;
            const displayName = matchingProject ? getProjectDisplayName(matchingProject) : projectName;
            const groupLabel = `${displayName} (${providerLabel})`;

            if (!groups.has(groupKey)) {
                groups.set(groupKey, {
                    label: groupLabel,
                    provider: result.provider,
                    pathUnavailable: matchingProject?.path_status === "unavailable",
                    project: matchingProject,
                    items: [],
                });
            }
            groups.get(groupKey)!.items.push(result);
        }

        return groups;
    }, [projects, results, t]);

    // Resolve conversation titles for the projects that have results.
    // Sessions are fetched per project at most once per project version
    // (module cache keyed by path + last_modified), a few at a time, and the
    // sweep is abandoned when the modal closes or the result set changes.
    useEffect(() => {
        const token = ++titleSweepTokenRef.current;
        const { excludeSidechain } = useAppStore.getState();
        const pending: ClaudeProject[] = [];
        const cached: Record<string, string> = {};
        for (const group of groupedResults.values()) {
            const project = group.project;
            if (!project) continue;
            const hit = sessionTitleCache.get(titleCacheKey(project));
            if (hit) Object.assign(cached, hit);
            else if (!pending.some((p) => p.path === project.path)) pending.push(project);
        }
        if (Object.keys(cached).length > 0) {
            setSessionTitles((prev) => ({ ...prev, ...cached }));
        }
        if (pending.length === 0) return;

        const loadOne = async (project: ClaudeProject) => {
            const provider = project.provider ?? "claude";
            const projectSessions = await api<ClaudeSession[]>(
                provider !== "claude" ? "load_provider_sessions" : "load_project_sessions",
                provider !== "claude"
                    ? { provider, projectPath: project.path, excludeSidechain }
                    : { projectPath: project.path, excludeSidechain },
            );
            const titles: Record<string, string> = {};
            for (const s of projectSessions) {
                const title = s.summary?.trim();
                if (!title) continue;
                titles[s.session_id] = title;
                if (s.actual_session_id) titles[s.actual_session_id] = title;
            }
            sessionTitleCache.set(titleCacheKey(project), titles);
            return titles;
        };

        void (async () => {
            for (let i = 0; i < pending.length; i += TITLE_FETCH_CONCURRENCY) {
                if (token !== titleSweepTokenRef.current) return;
                const batch = pending.slice(i, i + TITLE_FETCH_CONCURRENCY);
                const settled = await Promise.allSettled(batch.map(loadOne));
                if (token !== titleSweepTokenRef.current) return;
                const merged: Record<string, string> = {};
                settled.forEach((outcome, idx) => {
                    if (outcome.status === "fulfilled") Object.assign(merged, outcome.value);
                    else console.error(`Failed to load session titles for ${batch[idx]!.name}:`, outcome.reason);
                });
                if (Object.keys(merged).length > 0) {
                    setSessionTitles((prev) => ({ ...prev, ...merged }));
                }
            }
        })();
    }, [groupedResults]);

    // Flatten grouped results for keyboard navigation
    const flattenedResults = useMemo(() => {
        const flat: GlobalSearchResult[] = [];
        for (const group of groupedResults.values()) {
            flat.push(...group.items);
        }
        return flat;
    }, [groupedResults]);

    // Get session display name for a search result
    const getSessionName = useCallback((result: GlobalSearchResult): string | undefined => {
        if (!result.sessionId || result.sessionId === "unknown-session") return undefined;
        const name = getSessionDisplayName(result.sessionId) ?? sessionTitles[result.sessionId];
        if (name) return name;
        // No custom/known name: show a short, stable conversation handle so results
        // from different conversations are still distinguishable (#420).
        return t("globalSearch.conversationId", { id: result.sessionId.slice(0, 8) });
    }, [getSessionDisplayName, sessionTitles, t]);

    // Debounced search
    const performSearch = useCallback(
        async (searchQuery: string) => {
            const trimmedQuery = searchQuery.trim();

            const hasNonClaudeProviders = hasNonDefaultProvider(activeProviders);
            const customClaudePaths = userMetadata?.settings?.customClaudePaths;
            const hasCustomPaths = (customClaudePaths?.length ?? 0) > 0;
            const wslEnabled = userMetadata?.settings?.wsl?.enabled ?? false;
            const hasAlternativeSource = hasNonClaudeProviders || hasCustomPaths || wslEnabled;
            const nativeClaudePath = claudePath || undefined;
            const wslProviders = wslEnabled ? getWslSearchableProviderIds(activeProviders) : undefined;
            const requestToken = ++searchRequestTokenRef.current;

            if (trimmedQuery.length < 2 || (!claudePath && !hasAlternativeSource)) {
                setResults([]);
                setLastSearchedQuery("");
                setIsSearching(false);
                return;
            }

            // Relative date presets are evaluated against the time of this search.
            const { filters, error: filterError } = buildSearchFilters(
                { selectedProjectPath, messageTypeFilter, dateFilter: searchDateFilter },
                new Date(),
            );
            if (filterError != null) {
                // The filter bar shows the warning; never send an inverted range.
                setResults([]);
                setLastSearchedQuery("");
                setIsSearching(false);
                return;
            }

            setIsSearching(true);
            try {
                const wslExcludedDistros = userMetadata?.settings?.wsl?.excludedDistros ?? [];
                const useAllProvidersSearch = hasNonClaudeProviders || hasCustomPaths || wslEnabled;
                const searchResults = await api<GlobalSearchResult[]>(
                    useAllProvidersSearch ? "search_all_providers" : "search_messages",
                    useAllProvidersSearch
                        ? {
                              claudePath: nativeClaudePath,
                              query: trimmedQuery,
                              activeProviders,
                              filters,
                              limit: MAX_RESULTS,
                              customClaudePaths: hasCustomPaths ? customClaudePaths : undefined,
                              wslEnabled,
                              wslProviders,
                              wslExcludedDistros,
                          }
                        : { claudePath: nativeClaudePath, query: trimmedQuery, filters, limit: MAX_RESULTS },
                );
                if (requestToken !== searchRequestTokenRef.current) return;
                setResults(searchResults);
                setLastSearchedQuery(trimmedQuery);
                setSelectedIndex(0);
            } catch (error) {
                if (requestToken !== searchRequestTokenRef.current) return;
                console.error("Global search failed:", error);
                setResults([]);
                setLastSearchedQuery("");
                toast.error(t("globalSearch.searchFailed"));
            } finally {
                if (requestToken === searchRequestTokenRef.current) setIsSearching(false);
            }
        },
        [claudePath, activeProviders, selectedProjectPath, messageTypeFilter, searchDateFilter, userMetadata, t],
    );

    // Latest performSearch for the debounce timer, so a timer armed before a
    // filter change never runs a search with the old filters.
    const performSearchRef = useRef(performSearch);
    useEffect(() => {
        performSearchRef.current = performSearch;
    }, [performSearch]);

    // Drop the pending debounced search and invalidate any in-flight response.
    const cancelPendingSearch = useCallback(() => {
        if (debounceTimeoutRef.current) {
            clearTimeout(debounceTimeoutRef.current);
            debounceTimeoutRef.current = null;
        }
        searchRequestTokenRef.current++;
    }, []);

    // Handle input change with debounce
    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setQuery(value);

        if (debounceTimeoutRef.current) {
            clearTimeout(debounceTimeoutRef.current);
        }

        debounceTimeoutRef.current = setTimeout(() => {
            debounceTimeoutRef.current = null;
            void performSearchRef.current(value);
        }, 300);
    }, []);

    // Navigate to selected result
    const handleSelectResult = useCallback(
        async (result: GlobalSearchResult) => {
            try {
                const targetSession = sessions.find(
                    (s) =>
                        s.session_id === result.sessionId ||
                        s.actual_session_id === result.sessionId,
                );

                if (targetSession) {
                    // Ensure the conversation pane is the active view — otherwise
                    // a result clicked while in analytics/tokenStats/etc. loads the
                    // session but stays hidden behind the other view (issue #390).
                    setAnalyticsCurrentView("messages");
                    await selectSession(targetSession);
                    if (result.uuid) {
                        navigateToMessage(result.uuid, { history: "replace" });
                    }
                    onClose();
                    return;
                }

                // Snapshot excludeSidechain once to keep requests consistent
                // across the scan and avoid repeated getState() calls. The
                // setting is user-configurable; taking a snapshot is intentional
                // so a mid-scan toggle does not change half the requests.
                const { excludeSidechain } = useAppStore.getState();
                const token = ++resolveTokenRef.current;

                // The search result carries the project name and provider —
                // rank matching projects first so the common case resolves in
                // ONE request instead of sweeping every project. The rest are
                // still tried (defensively) but in parallel batches with an
                // early exit, not one serial await per project.
                const resultProvider = result.provider ?? "claude";
                const rank = (project: (typeof projects)[number]): number => {
                    const projectProvider = project.provider ?? "claude";
                    if (projectProvider !== resultProvider) return 3;
                    if (result.projectName && project.name === result.projectName) return 0;
                    if (
                        result.projectName &&
                        (project.name.includes(result.projectName) ||
                            project.actual_path?.endsWith(result.projectName))
                    ) {
                        return 1;
                    }
                    return 2;
                };
                const candidates = [...projects].sort((a, b) => rank(a) - rank(b));

                const findInProject = async (
                    project: (typeof projects)[number],
                ): Promise<{ project: typeof project; session: ClaudeSession } | null> => {
                    try {
                        const projectProvider = project.provider ?? "claude";
                        const projectSessions = await api<ClaudeSession[]>(
                            projectProvider !== "claude" ? "load_provider_sessions" : "load_project_sessions",
                            projectProvider !== "claude"
                                ? { provider: projectProvider, projectPath: project.path, excludeSidechain }
                                : { projectPath: project.path, excludeSidechain },
                        );
                        const session = projectSessions.find(
                            (s) =>
                                s.session_id === result.sessionId ||
                                s.actual_session_id === result.sessionId,
                        );
                        return session ? { project, session } : null;
                    } catch (error) {
                        console.error(
                            `Failed to load sessions for project ${project.name}:`,
                            error,
                        );
                        return null;
                    }
                };

                const BATCH_SIZE = 4;
                for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
                    if (token !== resolveTokenRef.current) return; // cancelled
                    const batch = candidates.slice(i, i + BATCH_SIZE);
                    const found = (await Promise.all(batch.map(findInProject))).find(
                        (hit): hit is NonNullable<typeof hit> => hit !== null,
                    );
                    if (token !== resolveTokenRef.current) return; // cancelled
                    if (found) {
                        setAnalyticsCurrentView("messages");
                        await selectProject(found.project);
                        await selectSession(found.session);
                        if (result.uuid) {
                            navigateToMessage(result.uuid, { history: "replace" });
                        }
                        onClose();
                        return;
                    }
                }

                // Session not found in any project
                clearTargetMessage();
                toast.error(t("globalSearch.sessionNotFound"));
                onClose();
            } catch (error) {
                clearTargetMessage();
                console.error("Failed to navigate to search result:", error);
                toast.error(t("globalSearch.navigationFailed"));
                onClose();
            }
        },
        [projects, sessions, selectProject, selectSession, navigateToMessage, clearTargetMessage, setAnalyticsCurrentView, onClose, t],
    );

    // Keyboard navigation
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (flattenedResults.length === 0) return;
            const target = e.target;
            if (target instanceof Element && target.closest(OWN_KEYBOARD_SELECTOR) != null) return;

            switch (e.key) {
                case "ArrowDown":
                    e.preventDefault();
                    setSelectedIndex((prev) =>
                        prev < flattenedResults.length - 1 ? prev + 1 : 0,
                    );
                    break;
                case "ArrowUp":
                    e.preventDefault();
                    setSelectedIndex((prev) =>
                        prev > 0 ? prev - 1 : flattenedResults.length - 1,
                    );
                    break;
                case "Enter":
                    e.preventDefault();
                    if (flattenedResults[selectedIndex]) {
                        handleSelectResult(flattenedResults[selectedIndex]);
                    }
                    break;
                case "Escape":
                    e.preventDefault();
                    onClose();
                    break;
            }
        },
        [flattenedResults, selectedIndex, handleSelectResult, onClose],
    );

    // Scroll selected item into view
    useEffect(() => {
        if (resultsContainerRef.current && flattenedResults.length > 0) {
            const selectedElement = resultsContainerRef.current.querySelector(
                `[data-index="${selectedIndex}"]`,
            );
            selectedElement?.scrollIntoView({ block: "nearest" });
        }
    }, [selectedIndex, flattenedResults.length]);

    // Focus input when modal opens
    useEffect(() => {
        if (isOpen) {
            setTimeout(() => inputRef.current?.focus(), 0);
        } else {
            // Cancel any in-flight result-resolution sweep.
            resolveTokenRef.current++;
            // Drop the pending/in-flight search so it cannot repopulate a closed modal.
            cancelPendingSearch();
            setIsSearching(false);
            setQuery("");
            setResults([]);
            setLastSearchedQuery("");
            setSelectedIndex(0);
            setSelectedProjectPath("all");
            setMessageTypeFilter("all");
            setDateFilter(DEFAULT_DATE_FILTER);
            setSessionTitles({});
            titleSweepTokenRef.current++;
        }
    }, [isOpen, cancelPendingSearch]);

    // Re-search when filters change. `query` is intentionally omitted —
    // keystroke-driven searches go through handleInputChange's debounce.
    // This effect only fires when performSearch identity changes (i.e., filter deps).
    // It supersedes any pending debounced search, and also runs for short
    // queries so results of a longer, cancelled query do not linger.
    useEffect(() => {
        cancelPendingSearch();
        void performSearch(query);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [performSearch]);

    // Cleanup debounce on unmount
    useEffect(() => {
        return () => {
            if (debounceTimeoutRef.current) {
                clearTimeout(debounceTimeoutRef.current);
            }
        };
    }, []);

    // Searchable strings per result, collected once per result set rather than
    // on every keystroke/arrow re-render (250 rows × deep tool payload walks).
    const searchableTextByResult = useMemo(() => {
        const map = new WeakMap<GlobalSearchResult, SearchableStrings>();
        for (const result of results) map.set(result, collectSearchableStrings(result));
        return map;
    }, [results]);

    // Preview per result for the query that produced the results (same query
    // the highlighter uses); rebuilt only when a new result set arrives, not on
    // keystrokes or arrow-key re-renders.
    const previewByResult = useMemo(() => {
        const map = new WeakMap<GlobalSearchResult, string | null>();
        for (const result of results) {
            const strings = searchableTextByResult.get(result) ?? collectSearchableStrings(result);
            map.set(result, buildPreviewFromStrings(strings, lastSearchedQuery));
        }
        return map;
    }, [results, searchableTextByResult, lastSearchedQuery]);

    // Get preview text centered around the search term
    const getPreviewText = (message: GlobalSearchResult): string => {
        const preview = previewByResult.has(message)
            ? previewByResult.get(message)
            : buildPreviewFromStrings(collectSearchableStrings(message), lastSearchedQuery);
        return preview ?? t("globalSearch.noPreview");
    };

    // Derived (not stored) so a custom range that becomes valid clears it.
    const dateRangeError = buildDateRange(dateFilter, new Date()).error;

    const handleDatePresetChange = useCallback((value: string) => {
        if (!isDateFilterPreset(value)) return;
        setDateFilter((prev) => ({ ...prev, preset: value }));
    }, []);

    // Format timestamp
    const formatTimestamp = (timestamp: string): string => {
        try {
            const date = new Date(timestamp);
            return date.toLocaleDateString(getLocale(i18n.language || "en"), {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
            });
        } catch {
            return "";
        }
    };

    // Memoize regex to avoid re-creation per result item
    const highlightRegex = useMemo(() => buildHighlightRegex(lastSearchedQuery), [lastSearchedQuery]);

    const highlightText = (text: string): React.ReactNode => {
        if (!highlightRegex) return text;

        const parts = text.split(highlightRegex);
        return parts.map((part, index) =>
            highlightRegex.test(part) ? (
                <mark
                    key={index}
                    className="bg-highlight text-highlight-foreground rounded-sm px-0.5"
                >
                    {part}
                </mark>
            ) : (
                part
            ),
        );
    };

    let currentResultIndex = 0;

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                className="sm:max-w-2xl p-0 gap-0 overflow-hidden"
                onKeyDown={handleKeyDown}
                showCloseButton={false}
                aria-label={t("globalSearch.title")}
            >
                {/* Search Header */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
                    <Search className="w-4 h-4 text-muted-foreground shrink-0" />
                    <Input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={handleInputChange}
                        placeholder={t("globalSearch.placeholder")}
                        className="border-0 shadow-none focus-visible:ring-0 px-0 h-auto text-sm"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                    />
                    {isSearching && (
                        <Loader2 className="w-4 h-4 text-muted-foreground animate-spin shrink-0" />
                    )}
                    {query && !isSearching && (
                        <button
                            onClick={() => {
                                cancelPendingSearch();
                                setQuery("");
                                setResults([]);
                                setLastSearchedQuery("");
                                setIsSearching(false);
                                inputRef.current?.focus();
                            }}
                            className="p-1 hover:bg-muted rounded"
                            aria-label={t("globalSearch.clearSearch")}
                        >
                            <X className="w-3 h-3 text-muted-foreground" />
                        </button>
                    )}
                </div>

                {/* Filters Bar */}
                <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border bg-muted/20">
                    {/* Message Type Filter */}
                    <div className="flex items-center gap-1">
                        {(["all", "user", "assistant"] as const).map((type) => (
                            <button
                                key={type}
                                onClick={() => setMessageTypeFilter(type)}
                                className={cn(
                                    "flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
                                    messageTypeFilter === type
                                        ? "bg-foreground/10 text-foreground font-medium"
                                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                                )}
                                aria-label={t(`globalSearch.filterType.${type}`)}
                            >
                                {type === "all" && <MessageSquare className="w-3 h-3" />}
                                {type === "user" && <User className="w-3 h-3" />}
                                {type === "assistant" && <Bot className="w-3 h-3" />}
                                <span>{t(`globalSearch.filterType.${type}`)}</span>
                            </button>
                        ))}
                    </div>

                    {/* Divider */}
                    {projects.length > 1 && (
                        <div className="w-px h-4 bg-border" />
                    )}

                    {/* Project Filter */}
                    {projects.length > 1 && (
                        <>
                            <Filter className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            <Select value={selectedProjectPath} onValueChange={setSelectedProjectPath}>
                                <SelectTrigger className="h-7 text-xs border-border w-40">
                                    <SelectValue placeholder={t("globalSearch.allProjects")} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">{t("globalSearch.allProjects")}</SelectItem>
                                    {projects.map((project) => (
                                        <SelectItem key={project.path} value={project.path}>
                                            {project.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </>
                    )}

                    {/* Date Filter */}
                    <div className="w-px h-4 bg-border" />
                    <div className="flex items-center gap-1.5">
                        <CalendarDays className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <Select value={dateFilter.preset} onValueChange={handleDatePresetChange}>
                            <SelectTrigger
                                className="h-7 text-xs border-border w-32"
                                aria-label={t("globalSearch.dateFilter.label")}
                            >
                                <SelectValue placeholder={t("globalSearch.dateFilter.all")} />
                            </SelectTrigger>
                            <SelectContent>
                                {DATE_FILTER_PRESETS.map((preset) => (
                                    <SelectItem key={preset} value={preset}>
                                        {t(DATE_PRESET_LABEL_KEYS[preset])}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {dateFilter.preset === "custom" && (
                            <>
                                <input
                                    type="date"
                                    value={dateFilter.from}
                                    max={dateFilter.to || undefined}
                                    onChange={(e) => {
                                        const from = e.target.value;
                                        setDateFilter((prev) => ({ ...prev, from }));
                                    }}
                                    aria-label={t("globalSearch.dateFilter.from")}
                                    title={t("globalSearch.dateFilter.from")}
                                    className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
                                />
                                <span className="text-xs text-muted-foreground" aria-hidden="true">–</span>
                                <input
                                    type="date"
                                    value={dateFilter.to}
                                    min={dateFilter.from || undefined}
                                    onChange={(e) => {
                                        const to = e.target.value;
                                        setDateFilter((prev) => ({ ...prev, to }));
                                    }}
                                    aria-label={t("globalSearch.dateFilter.to")}
                                    title={t("globalSearch.dateFilter.to")}
                                    className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
                                />
                            </>
                        )}
                    </div>
                    {dateRangeError != null && (
                        <span role="alert" className="text-xs text-destructive">
                            {t(DATE_ERROR_LABEL_KEYS[dateRangeError])}
                        </span>
                    )}
                </div>

                {/* Results */}
                <div
                    ref={resultsContainerRef}
                    className="max-h-100 overflow-y-auto"
                >
                    {/* Loading skeleton */}
                    {isSearching && results.length === 0 && (
                        <div className="py-4 space-y-3 px-4">
                            {Array.from({ length: 4 }).map((_, i) => (
                                <div key={i} className="animate-pulse">
                                    <div className="flex items-center gap-2 mb-1.5">
                                        <div className="h-4 w-12 bg-muted rounded" />
                                        <div className="h-3 w-20 bg-muted rounded" />
                                    </div>
                                    <div className="h-4 w-full bg-muted rounded mb-1" />
                                    <div className="h-4 w-3/4 bg-muted rounded" />
                                </div>
                            ))}
                        </div>
                    )}

                    {!isSearching && query.trim().length >= 2 && results.length === 0 && dateRangeError == null && (
                        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                            {t("globalSearch.noResults")}
                        </div>
                    )}

                    {/* Empty state with search tips */}
                    {!query && (
                        <div className="px-6 py-8 space-y-4">
                            <div className="text-center">
                                <Search className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
                                <p className="text-sm text-muted-foreground">
                                    {t("globalSearch.hint")}
                                </p>
                            </div>
                            <div className="space-y-2">
                                <div className="flex items-start gap-2 text-xs text-muted-foreground/70">
                                    <Lightbulb className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                    <span>{t("globalSearch.tips.minChars")}</span>
                                </div>
                                <div className="flex items-start gap-2 text-xs text-muted-foreground/70">
                                    <Lightbulb className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                    <span>{t("globalSearch.tips.filters")}</span>
                                </div>
                                <div className="flex items-start gap-2 text-xs text-muted-foreground/70">
                                    <Lightbulb className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                    <span>{t("globalSearch.tips.navigate")}</span>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Typing but not enough chars */}
                    {query && query.trim().length < 2 && !isSearching && (
                        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                            {t("globalSearch.tips.minChars")}
                        </div>
                    )}

                    {results.length > 0 && (
                        <div className="py-2">
                            {Array.from(groupedResults.entries()).map(
                                ([groupKey, group]) => (
                                    <div key={groupKey}>
                                        {/* Project Header */}
                                        <div className="px-4 py-1.5 text-xs font-medium text-muted-foreground bg-muted sticky top-0 truncate flex items-center gap-2">
                                            {group.provider && group.provider !== "claude" && (
                                                <Badge
                                                    size="sm"
                                                    className={cn(
                                                        "rounded px-1 py-0 text-2xs",
                                                        getProviderBadgeStyle(group.provider)
                                                    )}
                                                >
                                                    {getProviderLabel((key, fallback) => t(key, fallback), group.provider)}
                                                </Badge>
                                            )}
                                            {group.pathUnavailable && (
                                                <Badge
                                                    size="sm"
                                                    className="rounded px-1 py-0 text-2xs bg-warning/15 text-warning"
                                                    title={t("project.pathUnavailableDescription", {
                                                        defaultValue: "Last-known location is unavailable",
                                                    })}
                                                >
                                                    {t("project.pathUnavailable", "Location unavailable")}
                                                </Badge>
                                            )}
                                            <span className="truncate">{group.label}</span>
                                        </div>

                                        {/* Results in this project */}
                                        {group.items.map((result) => {
                                            const index = currentResultIndex++;
                                            const isSelected = index === selectedIndex;

                                            return (
                                                <button
                                                    key={result.uuid}
                                                    data-index={index}
                                                    onClick={() => handleSelectResult(result)}
                                                    className={cn(
                                                        "w-full text-left px-4 py-2.5 hover:bg-muted/50 transition-colors",
                                                        isSelected && "bg-muted"
                                                    )}
                                                >
                                                    <div className="flex items-start gap-3">
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2 mb-1">
                                                                <span
                                                                    className={cn(
                                                                        "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium",
                                                                        result.type === "user"
                                                                            ? "bg-info/10 text-info"
                                                                            : result.type === "assistant"
                                                                              ? "bg-warning/10 text-warning"
                                                                              : "bg-muted text-muted-foreground"
                                                                    )}
                                                                >
                                                                    {result.type === "user" && <User className="w-3 h-3" />}
                                                                    {result.type === "assistant" && <Bot className="w-3 h-3" />}
                                                                    {result.type}
                                                                </span>
                                                                <span className="text-xs text-muted-foreground">
                                                                    {formatTimestamp(result.timestamp)}
                                                                </span>
                                                            </div>
                                                            {(() => {
                                                                const sessionName = getSessionName(result);
                                                                return sessionName ? (
                                                                    <p className="flex items-center gap-1 text-xs text-muted-foreground/70 mb-0.5">
                                                                        <MessageSquare className="w-3 h-3 shrink-0" />
                                                                        <span className="truncate">{sessionName}</span>
                                                                    </p>
                                                                ) : null;
                                                            })()}
                                                            <p className="text-sm text-foreground line-clamp-2">
                                                                {highlightText(getPreviewText(result))}
                                                            </p>
                                                        </div>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                ),
                            )}
                        </div>
                    )}
                </div>

                {/* Footer with keyboard hints */}
                <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30 text-xs text-muted-foreground">
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-1">
                            <kbd className="px-1.5 py-0.5 bg-muted rounded border border-border font-mono">
                                <ArrowUp className="w-3 h-3 inline" />
                            </kbd>
                            <kbd className="px-1.5 py-0.5 bg-muted rounded border border-border font-mono">
                                <ArrowDown className="w-3 h-3 inline" />
                            </kbd>
                            <span className="ml-1">
                                {t("globalSearch.navigate")}
                            </span>
                        </div>
                        <div className="flex items-center gap-1">
                            <kbd className="px-1.5 py-0.5 bg-muted rounded border border-border font-mono">
                                <CornerDownLeft className="w-3 h-3 inline" />
                            </kbd>
                            <span className="ml-1">
                                {t("globalSearch.select")}
                            </span>
                        </div>
                        <div className="flex items-center gap-1">
                            <kbd className="px-1.5 py-0.5 bg-muted rounded border border-border font-mono text-px10">
                                esc
                            </kbd>
                            <span className="ml-1">
                                {t("globalSearch.close")}
                            </span>
                        </div>
                    </div>
                    {results.length > 0 && (
                        <span>
                            {results.length >= MAX_RESULTS
                                ? t("globalSearch.resultsCapped", { count: MAX_RESULTS })
                                : t("globalSearch.results", { count: results.length })}
                        </span>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
};
