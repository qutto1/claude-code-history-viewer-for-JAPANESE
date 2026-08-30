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

import React, { useState, useCallback, useRef } from "react";
import { HelpCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
  HoverCardArrow,
} from "@/components/ui/hover-card";
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
  // Hovering opens the details card; clicking pins it so it survives the
  // pointer leaving. "Pinned" is a ref, not state: nothing renders from it, and
  // the pointerdown handler that reads it runs before React would have
  // re-rendered with a fresh closure.
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const isPinnedRef = useRef(false);
  const detailsTriggerRef = useRef<HTMLButtonElement>(null);

  const handleDetailsOpenChange = useCallback((open: boolean) => {
    // A pinned card ignores the close that pointer-leave asks for.
    if (!open && isPinnedRef.current) return;
    setIsDetailsOpen(open);
  }, []);

  const closeDetails = useCallback(() => {
    isPinnedRef.current = false;
    setIsDetailsOpen(false);
  }, []);

  const handleTooltipToggle = useCallback(() => {
    if (isPinnedRef.current) {
      // Unpin only. The pointer is still on the trigger, so the card stays up
      // until it leaves — the same as the old hover-driven behaviour.
      isPinnedRef.current = false;
      return;
    }
    isPinnedRef.current = true;
    setIsDetailsOpen(true);
  }, []);

  const handleDetailsPointerDownOutside = useCallback(
    (event: { target: EventTarget | null; preventDefault: () => void }) => {
      // The trigger counts as "outside" the card, and its own click already
      // toggles the pin — let that be the single source of truth.
      if (detailsTriggerRef.current?.contains(event.target as Node)) {
        event.preventDefault();
        return;
      }
      closeDetails();
    },
    [closeDetails]
  );

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
        <div className="flex items-center justify-end gap-0.5">
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
            /* Portalled, not absolutely positioned: the gutter lives inside a
               virtualized row, so an in-place panel is clipped by the scroll
               container above the first rows and painted over by later rows
               below them — each row opens its own stacking context, so no
               z-index on the panel can win. Radix anchors it with fixed
               coordinates off the trigger's rect and flips/shifts it to stay in
               the viewport. */
            <HoverCard
              open={isDetailsOpen}
              onOpenChange={handleDetailsOpenChange}
              openDelay={0}
              closeDelay={120}
            >
              <HoverCardTrigger asChild>
                <button
                  type="button"
                  ref={detailsTriggerRef}
                  onClick={handleTooltipToggle}
                  className="inline-flex items-center justify-center cursor-help text-muted-foreground"
                  aria-label={t("assistantMessageDetails.tokenUsageLabel")}
                  aria-expanded={isDetailsOpen}
                >
                  <HelpCircle className="w-2.5 h-2.5" />
                </button>
              </HoverCardTrigger>
              <HoverCardContent
                side="top"
                align="start"
                sideOffset={4}
                className="w-52 p-2.5 text-left text-xs shadow-lg"
                onPointerDownOutside={handleDetailsPointerDownOutside}
                onEscapeKeyDown={closeDetails}
              >
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
                <HoverCardArrow className="fill-popover" width={10} height={5} />
              </HoverCardContent>
            </HoverCard>
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
