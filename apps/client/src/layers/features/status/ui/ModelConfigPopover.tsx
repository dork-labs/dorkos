import * as React from 'react';
import { Bot, AlertCircle, RefreshCw, Zap, Search } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Badge,
  Separator,
  Input,
} from '@/layers/shared/ui';
import { cn, localDeviceNoun } from '@/layers/shared/lib';
import { useModels } from '@/layers/entities/session';
import type { ModelOption, EffortLevel } from '@dorkos/shared/types';
import {
  shouldUseTieredMenu,
  matchesQuery,
  groupByTier,
  type TierGroupSlug,
} from '../lib/model-menu-tiers';

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

/** Format a context window token count as a compact badge label (e.g. "200K"). */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/** Extract a short display label from a model identifier when no displayName is available. */
function getModelLabel(model: string, models: ModelOption[]): string {
  const option = models.find((o) => o.value === model);
  if (option) return option.displayName;
  const match = model.match(/claude-(\w+)-/);
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) : model;
}

/** Loading skeleton rendered while models are being fetched. */
function ModelCardsSkeleton() {
  return (
    <div className="space-y-2" data-testid="model-cards-skeleton">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl p-3">
          <Skeleton className="size-4 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-2.5 w-32" />
          </div>
          <Skeleton className="h-5 w-10 rounded-md" />
        </div>
      ))}
    </div>
  );
}

/** Error state with a retry button when model fetching fails. */
function ModelLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-3 py-6 text-center"
      data-testid="model-load-error"
    >
      <AlertCircle className="text-muted-foreground size-5" />
      <p className="text-muted-foreground text-xs">Failed to load models</p>
      <button
        onClick={onRetry}
        className="text-foreground hover:bg-accent inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors"
      >
        <RefreshCw className="size-3" />
        Retry
      </button>
    </div>
  );
}

/** Selectable model card with Radix radio indicator and context window badge. */
function ModelCard({ model, isSelected }: { model: ModelOption; isSelected: boolean }) {
  return (
    <label
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors duration-150',
        isSelected
          ? 'bg-secondary border-foreground/15'
          : 'border-border hover:border-muted-foreground/30 hover:bg-muted/50 opacity-70'
      )}
    >
      <RadioGroupItem value={model.value} className="shrink-0" />

      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">
          {model.displayName}
          {model.local && (
            <span className="text-muted-foreground ml-1.5 text-[10px] font-normal">
              {localDeviceNoun()} · private
            </span>
          )}
        </div>
        <div className="text-muted-foreground truncate text-[11px] leading-tight">
          {model.description}
        </div>
      </div>

      {model.contextWindow && (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {formatContextWindow(model.contextWindow)}
        </Badge>
      )}
    </label>
  );
}

/**
 * A session's saved model that the current options no longer offer (provider
 * switched, model deleted, or a local tag removed). Shown so the person knows
 * their setting is stale and must pick another. The menu never auto-switches.
 */
function UnavailableSavedModel({ value }: { value: string }) {
  return (
    <div className="space-y-1.5" data-testid="model-unavailable-saved">
      <div className="border-border flex w-full items-center gap-3 rounded-xl border border-dashed p-3 opacity-80">
        <AlertCircle className="size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-sm font-medium">
            {value}
            <span className="text-muted-foreground ml-1.5 text-[11px] font-normal">
              (not available)
            </span>
          </div>
        </div>
      </div>
      <p className="text-muted-foreground text-[11px] leading-snug">
        This model isn&apos;t available anymore. Pick another.
      </p>
    </div>
  );
}

/** Non-interactive group header rendered between `ModelCard`s inside the shared `RadioGroup`. */
function TierGroupHeader({ slug, label }: { slug: TierGroupSlug; label: string }) {
  return (
    <div
      className="text-muted-foreground mt-2 mb-1 text-[11px] font-medium tracking-wide uppercase first:mt-0"
      data-testid={`model-group-${slug}`}
    >
      {label}
    </div>
  );
}

interface ModelSelectionListProps {
  models: ModelOption[];
  selectedModel: string;
  onChangeModel: (model: string) => void;
}

/**
 * Model picker: a flat `RadioGroup` of `ModelCard`s for small, untiered
 * catalogs (unchanged claude-code/codex behavior), or a searchable,
 * tier-grouped `RadioGroup` once tiered or past the searchable threshold
 * (`SEARCHABLE_THRESHOLD` in `../lib/model-menu-tiers`) — one `RadioGroup`
 * either way, so keyboard nav spans groups.
 */
function ModelSelectionList({ models, selectedModel, onChangeModel }: ModelSelectionListProps) {
  const [query, setQuery] = React.useState('');
  const useSearchableMenu = shouldUseTieredMenu(models);

  // The saved model can stop existing (provider switched, model deleted). Surface
  // it as unavailable and let the person pick another, never auto-switch (spec §11).
  const missingSaved = selectedModel.length > 0 && !models.some((m) => m.value === selectedModel);
  const banner = missingSaved ? <UnavailableSavedModel value={selectedModel} /> : null;

  const filteredModels = React.useMemo(
    () => (useSearchableMenu ? models.filter((m) => matchesQuery(m, query)) : models),
    [models, query, useSearchableMenu]
  );

  const groups = React.useMemo(
    () => (useSearchableMenu ? groupByTier(filteredModels) : []),
    [filteredModels, useSearchableMenu]
  );

  if (!useSearchableMenu) {
    return (
      <div className="space-y-2">
        {banner}
        <RadioGroup
          value={selectedModel}
          onValueChange={onChangeModel}
          className="grid-cols-1 gap-1.5"
          aria-label="Model selection"
          data-testid="model-card-list"
        >
          {models.map((m) => (
            <ModelCard key={m.value} model={m} isSelected={m.value === selectedModel} />
          ))}
        </RadioGroup>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {banner}
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models…"
          aria-label="Search models"
          data-testid="model-search"
          className="h-8 pl-8 text-xs"
        />
      </div>
      {groups.length === 0 ? (
        <p
          className="text-muted-foreground py-4 text-center text-xs"
          data-testid="model-search-empty"
        >
          No models match
        </p>
      ) : (
        <RadioGroup
          value={selectedModel}
          onValueChange={onChangeModel}
          className="grid-cols-1 gap-1.5"
          aria-label="Model selection"
          data-testid="model-card-list"
        >
          {groups.map((group) => (
            <React.Fragment key={group.slug}>
              <TierGroupHeader slug={group.slug} label={group.label} />
              {group.models.map((m) => (
                <ModelCard key={m.value} model={m} isSelected={m.value === selectedModel} />
              ))}
            </React.Fragment>
          ))}
        </RadioGroup>
      )}
    </div>
  );
}

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
      <div className="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase">
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
      <div className="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase">
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
}

/**
 * Model configuration popover for the status bar. Opens a ~320px-wide panel
 * above the trigger with grouped card selection for models, effort levels,
 * and mode toggles; stays open until the user clicks outside or hits Escape.
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

  const showEffort =
    selectedModel?.supportsEffort &&
    selectedModel.supportedEffortLevels &&
    selectedModel.supportedEffortLevels.length > 0;

  const showModes = selectedModel?.supportsFastMode ?? false;

  const effortLabel = effort ? EFFORT_LABELS[effort].label : null;

  // Build status bar trigger content
  const trigger = (
    <button
      disabled={disabled}
      className="hover:text-foreground inline-flex items-center gap-1 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40"
      data-testid="model-config-trigger"
    >
      <Bot className="size-(--size-icon-xs)" />
      <span>{getModelLabel(model, modelList)}</span>
      {effortLabel && (
        <>
          <span className="text-muted-foreground text-[11px]">·</span>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {effortLabel}
          </Badge>
        </>
      )}
      {fastMode && (
        <>
          <span className="text-muted-foreground text-[11px]">·</span>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
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
        className="w-80 p-3"
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
              <div className="text-muted-foreground mb-3 text-[11px] font-medium tracking-wide uppercase">
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
