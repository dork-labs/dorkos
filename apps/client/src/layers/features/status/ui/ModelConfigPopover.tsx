import * as React from 'react';
import { Bot, Zap } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Badge,
  Separator,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useModels } from '@/layers/entities/session';
import type { EffortLevel } from '@dorkos/shared/types';
import { ModelCardsSkeleton, ModelLoadError, ModelSelectionList } from './ModelSelectionList';
import { statusModelLabel } from '../lib/status-labels';

const EFFORT_LABELS: Record<EffortLevel, { label: string; description: string }> = {
  none: { label: 'None', description: 'No reasoning' },
  minimal: { label: 'Minimal', description: 'Near-zero thinking' },
  low: { label: 'Low', description: 'Fastest responses' },
  medium: { label: 'Medium', description: 'Moderate thinking' },
  high: { label: 'High', description: 'Deep reasoning' },
  max: { label: 'Max', description: 'Maximum thinking' },
  xhigh: { label: 'XHigh', description: 'Beyond maximum' },
};

/** Animation transition for section content when switching models. */
const SECTION_TRANSITION = { duration: 0.15, ease: 'easeOut' } as const;

/** Effort level selector rendered as pill/segment buttons. */
function EffortSection({
  effortLevels,
  effort,
  onChangeEffort,
}: {
  effortLevels: EffortLevel[];
  effort: EffortLevel | null;
  onChangeEffort: (effort: EffortLevel | null) => void;
}) {
  return (
    <div>
      <div className="text-muted-foreground mb-2 text-2xs font-medium tracking-wide uppercase">
        Effort
      </div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Effort level">
        <TogglePill
          role="radio"
          label="Default"
          isSelected={effort === null}
          onClick={() => onChangeEffort(null)}
        />
        {effortLevels.map((level) => (
          <TogglePill
            key={level}
            role="radio"
            label={EFFORT_LABELS[level].label}
            description={EFFORT_LABELS[level].description}
            isSelected={effort === level}
            onClick={() => onChangeEffort(level)}
          />
        ))}
      </div>
    </div>
  );
}

/** Mode toggle pill for Fast mode. */
function ModeSection({
  supportsFastMode,
  fastMode,
  onChangeFastMode,
}: {
  supportsFastMode: boolean;
  fastMode: boolean;
  onChangeFastMode: (enabled: boolean) => void;
}) {
  if (!supportsFastMode) return null;

  return (
    <div>
      <div className="text-muted-foreground mb-2 text-2xs font-medium tracking-wide uppercase">
        Mode
      </div>
      <div className="flex gap-1.5">
        <TogglePill
          role="switch"
          label="Fast"
          icon={<Zap className="size-3" />}
          isSelected={fastMode}
          onClick={() => onChangeFastMode(!fastMode)}
        />
      </div>
    </div>
  );
}

/**
 * Pill button shared by the effort-level radios and the mode-toggle switch;
 * `role` picks the ARIA semantics, an optional `description` wraps it in a
 * tooltip, an optional `icon` prefixes the label.
 */
function TogglePill({
  role,
  label,
  description,
  icon,
  isSelected,
  onClick,
}: {
  role: 'radio' | 'switch';
  label: string;
  description?: string;
  icon?: React.ReactNode;
  isSelected: boolean;
  onClick: () => void;
}) {
  const pill = (
    <button
      role={role}
      aria-checked={isSelected}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150',
        isSelected
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  );

  if (!description) return pill;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{pill}</TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

export interface ModelConfigPopoverProps {
  model: string;
  onChangeModel: (model: string) => void;
  effort: EffortLevel | null;
  onChangeEffort: (effort: EffortLevel | null) => void;
  fastMode: boolean;
  onChangeFastMode: (enabled: boolean) => void;
  /** When true, the trigger is disabled (e.g. no active session). */
  disabled?: boolean;
  /** Active session id; scopes the model list to its runtime (omitted = server default). */
  sessionId?: string;
  /** Resolved runtime (e.g. `'codex'`) so a not-yet-started session still shows the right models. */
  runtime?: string | null;
  /**
   * Say it in as few pixels as possible — set below the status line's widest
   * tier. Keeps the model name and drops the effort and Fast badges, which the
   * Session panel and this popover both still report.
   */
  compact?: boolean;
}

/**
 * Model configuration popover for the status bar. Opens a panel above the
 * trigger with grouped card selection for models, effort levels, and mode
 * toggles; stays open until the user clicks outside or hits Escape.
 */
export function ModelConfigPopover({
  model,
  onChangeModel,
  effort,
  onChangeEffort,
  fastMode,
  onChangeFastMode,
  disabled,
  sessionId,
  runtime,
  compact,
}: ModelConfigPopoverProps) {
  const {
    data: models,
    isLoading,
    isError,
    refetch,
  } = useModels({
    sessionId,
    runtime: runtime ?? undefined,
  });
  const modelList = models ?? [];
  const selectedModel = modelList.find((m) => m.value === model);

  // The ONE answer to "can this model be given a thinking effort at all" — read
  // by the Effort control below AND by the trigger's effort badge, deliberately
  // the same expression rather than two. Switching to a model with no effort
  // support used to take the control away while the status line kept reading
  // `Haiku 4.5 · High`: a setting the person could no longer change, still
  // being advertised as in force (DOR-1445). A model that is not in the
  // catalogue yet (still loading, or unknown to this runtime) counts as "no",
  // because a claim we cannot back is worse than a badge that arrives a beat
  // late.
  const showEffort = Boolean(
    selectedModel?.supportsEffort && (selectedModel.supportedEffortLevels?.length ?? 0) > 0
  );

  const showModes = selectedModel?.supportsFastMode ?? false;

  // Badges are the first thing the status line gives up when it narrows: effort
  // and Fast are settings, and this popover plus the Session panel both still
  // report them. The model's NAME is what the line is for, so it always stays.
  const effortLabel = !compact && showEffort && effort ? EFFORT_LABELS[effort].label : null;
  const showFastBadge = !compact && fastMode;

  // Build status bar trigger content
  const trigger = (
    <button
      disabled={disabled}
      className="hover:text-foreground inline-flex min-w-0 items-center gap-1 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40"
      data-testid="model-config-trigger"
    >
      <Bot className="size-(--size-icon-xs) shrink-0" />
      <span className="truncate">{statusModelLabel(model, modelList)}</span>
      {effortLabel && (
        <>
          <span className="text-muted-foreground text-2xs">·</span>
          <Badge variant="secondary" className="px-1.5 py-0 text-3xs">
            {effortLabel}
          </Badge>
        </>
      )}
      {showFastBadge && (
        <>
          <span className="text-muted-foreground text-2xs">·</span>
          <Badge variant="secondary" className="px-1.5 py-0 text-3xs">
            <Zap className="mr-0.5 inline size-2.5" />
            Fast
          </Badge>
        </>
      )}
    </button>
  );

  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{trigger}</span>
        </TooltipTrigger>
        <TooltipContent side="top">Send a message first</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <ResponsivePopover>
      <ResponsivePopoverTrigger asChild>{trigger}</ResponsivePopoverTrigger>
      <ResponsivePopoverContent
        side="top"
        align="start"
        // Wider than the shared 320px default, and widened HERE rather than in
        // `ResponsivePopoverContent`. Thirteen other panels share that
        // primitive; nine of them sit at 320px or narrower and a tenth asks for
        // no fixed width at all, and none of the ten want what this panel wants,
        // so the width belongs to the call site (design-system.md: retime a
        // shared primitive at the call site, not in the primitive). The three
        // that DO reach for extra room — the live lane at 352px, the Control
        // Center at 384px, and the inbox bell at exactly 480px — all reach from
        // their own call sites, which is the precedent followed here; only their
        // viewport clamp is left out, for the reason given below. The inbox bell
        // is the closest of the three: its `w-[min(30rem,…)]` is this number.
        //
        // What needs the room is the content: an OpenRouter row carries a model
        // name, a namespaced id, a context-window badge and a plain-language
        // note about what the model cannot do, and at 320px the id and the note
        // both ran out of line (DOR-1673). 480px puts the longest note —
        // "Can't use tools, so it can't read files or run commands." — on one
        // line, which is the measurement that picked the number.
        //
        // The viewport clamp rides along, like the two clamped panels above.
        // "768px and up can always hold 480px" is only true at a 16px root:
        // the breakpoint is a px media query while `w-120` is 30rem, so a
        // raised browser font size scales the panel without moving the switch
        // (root 24px puts a 720px panel in a 768px window). Below 768px this
        // is a full-width sheet that ignores the caller's className outright.
        // An embedded pane narrower than its window (Obsidian) is the one case
        // the clamp still misses — `vw` is the window, not the pane.
        className="w-120 max-w-[calc(100vw-1.5rem)] p-3"
        data-testid="model-config-popover"
      >
        <ResponsivePopoverTitle>Model</ResponsivePopoverTitle>

        {isLoading && <ModelCardsSkeleton />}
        {isError && <ModelLoadError onRetry={() => refetch()} />}
        {!isLoading && !isError && (
          <ModelSelectionList
            models={modelList}
            selectedModel={model}
            onChangeModel={onChangeModel}
          />
        )}

        {/* Stable key: effort/mode changes within the same model must not re-trigger
         * exit→enter animation (that causes a visible blank gap). */}
        <AnimatePresence>
          {!isLoading && !isError && (showEffort || showModes) && (
            <motion.div
              key="config"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={SECTION_TRANSITION}
            >
              <Separator className="my-3" />
              <div className="text-muted-foreground mb-3 text-2xs font-medium tracking-wide uppercase">
                Configuration
              </div>
              <div className="space-y-3">
                {showEffort && (
                  <EffortSection
                    effortLevels={selectedModel!.supportedEffortLevels!}
                    effort={effort}
                    onChangeEffort={onChangeEffort}
                  />
                )}
                {showModes && (
                  <ModeSection
                    supportsFastMode={selectedModel?.supportsFastMode ?? false}
                    fastMode={fastMode}
                    onChangeFastMode={onChangeFastMode}
                  />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
