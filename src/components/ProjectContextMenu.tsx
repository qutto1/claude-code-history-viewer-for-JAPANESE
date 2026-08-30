// src/components/ProjectContextMenu.tsx
import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Check, EyeOff, Eye, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ClaudeProject } from "../types";
import { computeMenuPosition, type Boundary } from "@/utils/contextMenu";
import { isProjectPathUnavailable } from "@/utils/pathUtils";

/** The routine override, where `undefined` means "leave it to the entrypoint". */
type RoutineChoice = "auto" | "on" | "off";

const ROUTINE_CHOICES: {
  choice: RoutineChoice;
  value: boolean | undefined;
  i18nKey: string;
  fallback: string;
}[] = [
  { choice: "auto", value: undefined, i18nKey: "project.routine.auto", fallback: "Auto" },
  { choice: "on", value: true, i18nKey: "project.routine.on", fallback: "Yes" },
  { choice: "off", value: false, i18nKey: "project.routine.off", fallback: "No" },
];

interface ProjectContextMenuProps {
  project: ClaudeProject;
  position: { x: number; y: number; boundary?: Boundary | null };
  onClose: () => void;
  onHide: (projectPath: string) => void;
  onUnhide: (projectPath: string) => void;
  isHidden: boolean;
  /** Hand-written environment label, when the user set one. */
  environmentLabel?: string;
  /** Translated name of the environment derived from the entrypoint. */
  automaticEnvironmentLabel?: string;
  /** The stored routine override — `undefined` while it is left automatic. */
  routineOverride?: boolean;
  onSetEnvironmentLabel?: (projectPath: string, label: string) => void;
  onSetRoutine?: (projectPath: string, routine: boolean | undefined) => void;
}

export const ProjectContextMenu: React.FC<ProjectContextMenuProps> = ({
  project,
  position,
  onClose,
  onHide,
  onUnhide,
  isHidden,
  environmentLabel,
  automaticEnvironmentLabel,
  routineOverride,
  onSetEnvironmentLabel,
  onSetRoutine,
}) => {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const environmentInputId = React.useId();
  const [environmentDraft, setEnvironmentDraft] = useState(environmentLabel ?? "");
  const [adjustedPosition, setAdjustedPosition] = useState({ x: position.x, y: position.y });

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // Close on scroll or resize. Arm one animation frame after mount so a
  // synchronous scroll burst during the click-to-open sequence can't close
  // the menu immediately. Capture phase on scroll catches scroll on any
  // descendant (scroll events don't bubble, but capture flows root → target).
  // removeEventListener must match the capture flag or the listener leaks.
  useEffect(() => {
    let armed = false;
    const raf = requestAnimationFrame(() => {
      armed = true;
    });
    const handleScroll = () => {
      if (armed) onClose();
    };
    const handleResize = () => {
      if (armed) onClose();
    };
    document.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    window.addEventListener("resize", handleResize);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("scroll", handleScroll, { capture: true });
      window.removeEventListener("resize", handleResize);
    };
  }, [onClose]);

  // Adjust position if the menu would overflow the boundary (or viewport if absent).
  useLayoutEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      setAdjustedPosition(
        computeMenuPosition(
          { x: position.x, y: position.y },
          { width: rect.width, height: rect.height },
          position.boundary,
        ),
      );
    }
  }, [position]);

  const handleCopyPath = async () => {
    const path = project.actual_path?.trim();
    if (!path) {
      toast.error(t("error.clipboardFailed"));
      onClose();
      return;
    }
    try {
      await navigator.clipboard.writeText(path);
      toast.success(t("project.pathCopied"));
    } catch (err) {
      console.error("Failed to copy path:", err);
      toast.error(t("error.clipboardFailed"));
    }
    onClose();
  };

  const copyPathLabel = isProjectPathUnavailable(project)
    ? t("project.copyLastKnownPath", "Copy last-known path")
    : t("project.copyPath");

  const handleHideClick = () => {
    if (isHidden) {
      onUnhide(project.actual_path);
    } else {
      onHide(project.actual_path);
    }
    onClose();
  };

  const handleSaveEnvironmentLabel = () => {
    onSetEnvironmentLabel?.(project.actual_path, environmentDraft);
    onClose();
  };

  const currentRoutineChoice: RoutineChoice =
    routineOverride === undefined ? "auto" : routineOverride ? "on" : "off";

  const menuItemClass = cn(
    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm",
    "hover:bg-accent hover:text-accent-foreground",
    "transition-colors cursor-pointer"
  );

  const canEditEnvironment = Boolean(onSetEnvironmentLabel || onSetRoutine);

  return createPortal(
    <div
      ref={menuRef}
      className={cn(
        "fixed z-50 min-w-[220px] rounded-lg border shadow-lg",
        "bg-popover border-border",
        "animate-in fade-in-0 zoom-in-95 duration-100"
      )}
      style={{
        left: adjustedPosition.x,
        top: adjustedPosition.y,
      }}
    >
      <div className="p-1">
        {/* Project name header */}
        <div className="px-2 py-1.5 text-xs text-muted-foreground truncate border-b border-border mb-1">
          {project.name}
        </div>

        {/* Copy path option */}
        <button
          onClick={handleCopyPath}
          className={menuItemClass}
        >
          <Copy className="w-4 h-4" />
          <span>{copyPathLabel}</span>
        </button>

        {/* Hide/Unhide option */}
        <button
          onClick={handleHideClick}
          className={menuItemClass}
        >
          {isHidden ? (
            <>
              <Eye className="w-4 h-4" />
              <span>{t("project.unhide", "Show project")}</span>
            </>
          ) : (
            <>
              <EyeOff className="w-4 h-4" />
              <span>{t("project.hide", "Hide project")}</span>
            </>
          )}
        </button>

        {/* Manual environment / routine overrides. The logs carry no hostname,
            so a second machine or a cloud runner can only be named here. */}
        {canEditEnvironment && (
          <div className="mt-1 border-t border-border pt-2 space-y-2 px-2 pb-1">
            {onSetEnvironmentLabel && (
              <div className="space-y-1">
                <label
                  htmlFor={environmentInputId}
                  className="block text-2xs font-medium text-muted-foreground"
                >
                  {t("project.environment.menuLabel", "Environment label")}
                </label>
                <div className="flex items-center gap-1">
                  <input
                    id={environmentInputId}
                    type="text"
                    value={environmentDraft}
                    onChange={(event) => setEnvironmentDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleSaveEnvironmentLabel();
                      }
                    }}
                    placeholder={automaticEnvironmentLabel}
                    className={cn(
                      "min-w-0 flex-1 rounded-md border border-transparent bg-muted/40 px-2 py-1 text-xs",
                      "placeholder:text-muted-foreground/50 focus:border-accent/30 focus:outline-none"
                    )}
                  />
                  <button
                    type="button"
                    onClick={handleSaveEnvironmentLabel}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted/40 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    title={t("project.environment.save", "Save")}
                    aria-label={t("project.environment.save", "Save")}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {onSetRoutine && (
              <div className="space-y-1">
                <span className="block text-2xs font-medium text-muted-foreground">
                  {t("project.routine.menuLabel", "Routine work")}
                </span>
                <div className="flex items-center gap-1">
                  {ROUTINE_CHOICES.map(({ choice, value, i18nKey, fallback }) => {
                    const label = t(i18nKey, fallback);
                    const isActive = choice === currentRoutineChoice;

                    return (
                      <button
                        key={choice}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => {
                          onSetRoutine(project.actual_path, value);
                          onClose();
                        }}
                        className={cn(
                          "flex-1 rounded-md border px-1.5 py-1 text-2xs font-medium transition-colors",
                          isActive
                            ? "border-accent/30 bg-accent/15 text-accent"
                            : "border-transparent bg-muted/40 text-muted-foreground hover:bg-accent/10 hover:text-accent"
                        )}
                        title={label}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
