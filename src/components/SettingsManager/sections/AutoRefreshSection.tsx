/**
 * AutoRefreshSection Component
 *
 * Settings section for the periodic session refresh — an app-level setting
 * stored in user metadata, independent of Claude Code's own settings scope.
 * Runs the same reload as the header's refresh button, on a timer.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import {
  DEFAULT_SESSION_AUTO_REFRESH,
  SESSION_AUTO_REFRESH_MAX_MINUTES,
  SESSION_AUTO_REFRESH_MIN_MINUTES,
  normalizeAutoRefreshInterval,
} from "@/types";

interface AutoRefreshSectionProps {
  isExpanded: boolean;
  onToggle: (open: boolean) => void;
  readOnly?: boolean;
}

export function AutoRefreshSection({
  isExpanded,
  onToggle,
  readOnly = false,
}: AutoRefreshSectionProps) {
  const { t } = useTranslation();
  const userMetadata = useAppStore((s) => s.userMetadata);
  const setEnabled = useAppStore((s) => s.setSessionAutoRefreshEnabled);
  const setIntervalMinutes = useAppStore((s) => s.setSessionAutoRefreshIntervalMinutes);

  const stored = userMetadata?.settings?.sessionAutoRefresh;
  const enabled = stored?.enabled ?? DEFAULT_SESSION_AUTO_REFRESH.enabled;
  const savedInterval = normalizeAutoRefreshInterval(
    stored?.intervalMinutes ?? DEFAULT_SESSION_AUTO_REFRESH.intervalMinutes
  );

  // Kept locally so the field stays editable while typing (an out-of-range
  // value is only clamped on commit, not on every keystroke).
  const [draftInterval, setDraftInterval] = useState(String(savedInterval));
  useEffect(() => {
    setDraftInterval(String(savedInterval));
  }, [savedInterval]);

  const handleToggleEnabled = async (checked: boolean) => {
    try {
      await setEnabled(checked);
    } catch (err) {
      console.error("Failed to toggle session auto refresh:", err);
    }
  };

  const commitInterval = async () => {
    const next = normalizeAutoRefreshInterval(Number(draftInterval));
    setDraftInterval(String(next));
    if (next === savedInterval) return;
    try {
      await setIntervalMinutes(next);
    } catch (err) {
      console.error("Failed to update session auto refresh interval:", err);
    }
  };

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-muted/50 transition-colors">
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}
        <RefreshCw className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span>{t("settings.autoRefresh.title")}</span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="space-y-3 px-3 pb-3">
          <p className="text-xs text-muted-foreground">
            {t("settings.autoRefresh.description")}
          </p>

          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <Label htmlFor="auto-refresh-enabled" className="text-sm cursor-pointer">
              {t("settings.autoRefresh.enable")}
            </Label>
            <Switch
              id="auto-refresh-enabled"
              checked={enabled}
              onCheckedChange={handleToggleEnabled}
              disabled={readOnly}
            />
          </div>

          {/* Interval (only meaningful while enabled) */}
          {enabled && (
            <div className="space-y-2">
              <Label htmlFor="auto-refresh-interval" className="text-sm">
                {t("settings.autoRefresh.interval")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="auto-refresh-interval"
                  type="number"
                  min={SESSION_AUTO_REFRESH_MIN_MINUTES}
                  max={SESSION_AUTO_REFRESH_MAX_MINUTES}
                  value={draftInterval}
                  onChange={(e) => setDraftInterval(e.target.value)}
                  onBlur={commitInterval}
                  className="w-24"
                  disabled={readOnly}
                />
                <span className="text-sm text-muted-foreground">
                  {t("settings.autoRefresh.minutes")}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.autoRefresh.intervalDesc")}
              </p>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
