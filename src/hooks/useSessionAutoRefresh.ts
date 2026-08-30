// src/hooks/useSessionAutoRefresh.ts
/**
 * useSessionAutoRefresh Hook
 *
 * Runs the same refresh the header's "refresh session" button triggers, on a
 * timer, when the user has turned it on in Settings. The interval is stored in
 * user settings as whole minutes.
 *
 * A tick is skipped rather than queued while a load is already in flight, so a
 * short interval on a large session can never stack overlapping reloads.
 */

import { useEffect, useRef } from "react";
import { useAppStore } from "@/store/useAppStore";
import {
  DEFAULT_SESSION_AUTO_REFRESH,
  normalizeAutoRefreshInterval,
} from "@/types";

const MINUTE_MS = 60_000;

export const useSessionAutoRefresh = (): void => {
  const settings = useAppStore((s) => s.userMetadata?.settings?.sessionAutoRefresh);
  const hasSession = useAppStore((s) => Boolean(s.selectedSession));

  const enabled = settings?.enabled ?? DEFAULT_SESSION_AUTO_REFRESH.enabled;
  const intervalMinutes = normalizeAutoRefreshInterval(
    settings?.intervalMinutes ?? DEFAULT_SESSION_AUTO_REFRESH.intervalMinutes
  );

  // Guards against a slow refresh overlapping the next tick.
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled || !hasSession) return;

    const timer = setInterval(() => {
      if (inFlightRef.current) return;

      // Read through getState so the interval never needs re-creating when
      // unrelated store fields change.
      const state = useAppStore.getState();
      if (!state.selectedSession || state.isLoadingMessages) return;

      inFlightRef.current = true;
      void state
        .refreshCurrentSession()
        .catch((err) => {
          console.error("[AutoRefresh] Failed to refresh session:", err);
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    }, intervalMinutes * MINUTE_MS);

    return () => clearInterval(timer);
  }, [enabled, intervalMinutes, hasSession]);
};
