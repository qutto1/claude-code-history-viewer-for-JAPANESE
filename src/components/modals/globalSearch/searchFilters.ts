import { buildDateRange, type DateFilterSelection, type DateRangeError } from "./dateRangeFilter";

export type MessageTypeFilter = "all" | "user" | "assistant";

export interface SearchFilterState {
    selectedProjectPath: string;
    messageTypeFilter: MessageTypeFilter;
    dateFilter: DateFilterSelection;
}

export interface SearchFilters {
    projects?: string[];
    messageType?: "user" | "assistant";
    dateRange?: [string, string];
}

export interface BuildSearchFiltersResult {
    filters: SearchFilters;
    /** Set when the filter state cannot be searched (do not call the backend). */
    error?: DateRangeError;
}

/** Translate the modal's filter state into the backend `filters` payload. */
export const buildSearchFilters = (state: SearchFilterState, now: Date): BuildSearchFiltersResult => {
    const filters: SearchFilters = {};
    if (state.selectedProjectPath !== "all") {
        // Backend matches by directory name (last path segment), not full path
        const dirName = state.selectedProjectPath.split(/[\\/]/).pop() || state.selectedProjectPath;
        filters.projects = [dirName];
    }
    if (state.messageTypeFilter !== "all") {
        filters.messageType = state.messageTypeFilter;
    }
    const { range, error } = buildDateRange(state.dateFilter, now);
    if (error != null) return { filters, error };
    if (range != null) filters.dateRange = range;
    return { filters };
};
