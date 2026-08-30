// src/components/messageRenderer/CompactSummaryRenderer.tsx
import { useEffect, memo } from "react";
import { ChevronRight, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { layout } from "@/components/renderers";
import { useCaptureExpandState } from "@/contexts/CaptureExpandContext";
import { HighlightedText } from "../common/HighlightedText";
import { Markdown } from "../common/Markdown";
import { formatTimeShort } from "@/utils/time";

type Props = {
  /** Full carried-over context written by `/compact` */
  content: string;
  timestamp?: string;
  searchQuery?: string;
  isCurrentMatch?: boolean;
  currentMatchIndex?: number;
};

/**
 * The `/compact` summary is a synthetic user turn whose body is the whole
 * carried-over context — typically 15k+ characters of structured Markdown.
 * Rendering it as a normal chat bubble clipped it to three plain-text lines in
 * a narrow right-aligned box, so the context was effectively unreadable. This
 * renders it full width, as Markdown, behind a collapsed header.
 */
export const CompactSummaryRenderer = memo(function CompactSummaryRenderer({
  content,
  timestamp,
  searchQuery,
  isCurrentMatch = false,
  currentMatchIndex = 0,
}: Props) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useCaptureExpandState("compact-summary", false);

  // Auto-expand when the active search matches inside, so the highlight is
  // never hidden behind a collapsed header.
  useEffect(() => {
    if (searchQuery && content.toLowerCase().includes(searchQuery.toLowerCase())) {
      setIsExpanded(true);
    }
  }, [searchQuery, content, setIsExpanded]);

  if (!content) return null;

  return (
    <div
      className={cn(
        "bg-tool-system/10 border border-tool-system/30 overflow-hidden",
        layout.rounded
      )}
    >
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
        className={cn(
          "w-full flex items-center text-left",
          layout.headerPadding,
          layout.headerHeight,
          layout.iconGap,
          "hover:bg-tool-system/20 transition-colors"
        )}
      >
        <ChevronRight
          className={cn(
            layout.iconSize,
            "shrink-0 transition-transform duration-200 text-tool-system",
            isExpanded && "rotate-90"
          )}
        />
        <Minimize2 className={cn(layout.iconSize, "text-tool-system shrink-0")} />
        <span className={cn(layout.titleText, "text-tool-system whitespace-nowrap shrink-0")}>
          {t("compactSummaryRenderer.title", "Compacted context")}
        </span>
        {!isExpanded && (
          <span className={cn(layout.smallText, "text-muted-foreground truncate")}>
            {t("compactSummaryRenderer.preview", "{{count}} characters carried over", {
              count: content.length,
            })}
          </span>
        )}
        {timestamp && (
          <span className={cn(layout.smallText, "ml-auto shrink-0 text-tool-system")}>
            {formatTimeShort(timestamp)}
          </span>
        )}
      </button>

      {isExpanded && (
        <div className={layout.contentPadding}>
          {searchQuery ? (
            <div className={cn(layout.bodyText, "whitespace-pre-wrap break-words")}>
              <HighlightedText
                text={content}
                searchQuery={searchQuery}
                isCurrentMatch={isCurrentMatch}
                currentMatchIndex={currentMatchIndex}
              />
            </div>
          ) : (
            <Markdown className={layout.bodyText}>{content}</Markdown>
          )}
        </div>
      )}
    </div>
  );
});
