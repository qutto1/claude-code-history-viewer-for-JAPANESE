/**
 * MessageGutter Component
 *
 * The narrow column that sits to the LEFT of a message bubble and carries its
 * metadata: the time, the model, and what the turn cost. It replaces the old
 * header row, which spent a full line above every bubble and kept consecutive
 * message frames from touching.
 *
 * Only three things fit here, so everything else — the role label, the full
 * model id, the token breakdown — lives one hover away in a tooltip.
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import { HelpCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { formatTime, formatTimeShort } from "../../../utils/time";
import { getShortModelName } from "../../../utils/model";
import { getToolName } from "../../../utils/toolUtils";
import {
  EXPENSIVE_MESSAGE_COST_USD,
  calculateMessageCost,
  formatCostCompact,
  formatCostExact,
} from "../../../utils/messageCost";
import { hasSystemCommandContent } from "../helpers/messageHelpers";
import type { MessageGutterProps } from "../types";
import type { ClaudeAssistantMessage } from "../../../types";

/**
 * Wide enough for the longest model label ("sonnet-4.6") at the 10px gutter
 * size, and scaled with the app font setting so it stays wide enough when the
 * user turns text up.
 */
const GUTTER_WIDTH = "calc(4.5rem * var(--app-font-scale))";

const formatLatency = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
};

export const MessageGutter: React.FC<MessageGutterProps> = ({ message }) => {
  const { t } = useTranslation();
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const handleTooltipToggle = useCallback(() => {
    setIsTooltipOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (!isTooltipOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node)) {
        setIsTooltipOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isTooltipOpen]);

  const isToolResultMessage =
    (message.type === "user" || message.type === "assistant") &&
    !!message.toolUseResult;
  const isSystemContent = hasSystemCommandContent(message);
  const toolName = isToolResultMessage
    ? getToolName(
      (message as ClaudeAssistantMessage).toolUse,
      (message as ClaudeAssistantMessage).toolUseResult
    )
    : null;

  const roleLabel = isToolResultMessage && toolName
    ? toolName
    : isSystemContent
      ? t("messageViewer.system")
      : message.type === "user"
        ? t("messageViewer.user")
        : message.type === "assistant"
          ? (message.provider && message.provider !== "claude"
            ? t(`common.provider.${message.provider}`, message.provider)
            : t("messageViewer.claude"))
          : t("messageViewer.system");

  const assistant = message.type === "assistant" ? message : null;
  const usage = assistant?.usage;
  const shortModelName = assistant?.model ? getShortModelName(assistant.model) : null;
  const messageCost = assistant
    ? calculateMessageCost({
      model: assistant.model,
      usage: assistant.usage,
      costUSD: assistant.costUSD,
      provider: assistant.provider,
    })
    : null;
  // A message with no model, no usage, or a provider whose billing cannot be
  // reconstructed genuinely has no price — show nothing rather than "$0.0".
  const isExpensive =
    messageCost != null && messageCost.cost > EXPENSIVE_MESSAGE_COST_USD;
  const hasDetails = assistant?.model != null && (usage != null || messageCost != null);

  return (
    <div
      className="shrink-0 pt-0.5 text-px10 leading-tight text-right text-muted-foreground"
      style={{ width: GUTTER_WIDTH }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="cursor-default tabular-nums">
            {formatTimeShort(message.timestamp)}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          <span className="font-medium">{roleLabel}</span>
          {" · "}
          {formatTime(message.timestamp)}
        </TooltipContent>
      </Tooltip>

      {shortModelName && <div className="truncate">{shortModelName}</div>}

      {(messageCost != null || hasDetails) && (
        <div
          ref={tooltipRef}
          className="relative group flex items-center justify-end gap-0.5"
        >
          {messageCost != null && (
            <span
              className={cn(
                "tabular-nums",
                isExpensive && "font-bold text-destructive"
              )}
            >
              {formatCostCompact(messageCost.cost)}
            </span>
          )}
          {hasDetails && (
            <>
              <button
                type="button"
                onClick={handleTooltipToggle}
                className="inline-flex items-center justify-center cursor-help text-muted-foreground"
                aria-label={t("assistantMessageDetails.tokenUsageLabel")}
              >
                <HelpCircle className="w-2.5 h-2.5" />
              </button>
              {/* Anchored left, not right: the panel is wider than the gutter,
                  so the old right-0 anchor pushed it off the left edge of the
                  window. It still opens upward — each virtualized row is its own
                  stacking context, so a panel that overhangs downward is painted
                  over by the rows below it. */}
              <div className={cn(
                "absolute bottom-full mb-1 left-0 w-52 bg-popover text-popover-foreground",
                "text-left text-xs rounded-md p-2.5",
                "transition-opacity shadow-lg z-10 border border-border",
                isTooltipOpen ? "opacity-100 pointer-events-auto" : "opacity-0 group-hover:opacity-100 pointer-events-none"
              )}>
                <p className="mb-1"><strong>{t("assistantMessageDetails.model")}:</strong> {assistant?.model}</p>
                {usage?.input_tokens ? <p>{t("assistantMessageDetails.input")}: {usage.input_tokens.toLocaleString()}</p> : null}
                {usage?.output_tokens ? <p>{t("assistantMessageDetails.output")}: {usage.output_tokens.toLocaleString()}</p> : null}
                {messageCost?.cacheCreationTokens ? <p>{t("assistantMessageDetails.cacheCreation")}: {messageCost.cacheCreationTokens.toLocaleString()}</p> : null}
                {usage?.cache_read_input_tokens ? <p>{t("assistantMessageDetails.cacheRead")}: {usage.cache_read_input_tokens.toLocaleString()}</p> : null}
                {usage?.reasoning_tokens ? <p>{t("assistantMessageDetails.reasoning")}: {usage.reasoning_tokens.toLocaleString()}</p> : null}
                {assistant?.durationMs ? <p>{t("assistantMessageDetails.duration")}: {formatLatency(assistant.durationMs)}</p> : null}
                {messageCost != null && (
                  <p className="mt-1 pt-1 border-t border-border">
                    {t("assistantMessageDetails.cost")}: {messageCost.isEstimated ? `~${formatCostExact(messageCost.cost)}` : formatCostExact(messageCost.cost)}
                    {messageCost.isEstimated ? <span className="ml-1 opacity-70">({t("assistantMessageDetails.estimated")})</span> : null}
                  </p>
                )}
                <div className="absolute left-4 top-full w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-popover"></div>
              </div>
            </>
          )}
        </div>
      )}

      {message.isSidechain && (
        <div className="mt-0.5 inline-block px-1 text-px9 font-mono bg-warning/20 text-warning-foreground rounded-full">
          {t("messageViewer.branch")}
        </div>
      )}
    </div>
  );
};

MessageGutter.displayName = "MessageGutter";
