import { Bot, AlertCircle, RefreshCw, Zap, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Badge,
  Separator,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useModels } from '@/layers/entities/session';
import type { ModelOption, EffortLevel } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

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

interface ModelCardProps {
  model: ModelOption;
  isSelected: boolean;
}

/** Selectable model card with Radix radio indicator and context window badge. */
function ModelCard({ model, isSelected }: ModelCardProps) {
  return (
    <label
      className={cn(
        'relative flex w-full cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors duration-150',
        isSelected
          ? 'border-primary/40 bg-primary/5'
          : 'border-border hover:border-muted-foreground/30 hover:bg-muted/50 opacity-70'
      )}
    >
      {/* Accent left border on selected card */}
      {isSelected && (
        <div className="bg-primary absolute top-2 bottom-2 left-0 w-[3px] rounded-full" />
      )}

      {/* Radix radio indicator — filled circle */}
      <RadioGroupItem value={model.value} className="shrink-0" />

      {/* Model info */}
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">{model.displayName}</div>
        <div className="text-muted-foreground truncate text-[11px] leading-tight">
          {model.description}
        </div>
      </div>

      {/* Context window badge */}
      {model.contextWindow && (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {formatContextWindow(model.contextWindow)}
        </Badge>
      )}
    </label>
  );
}

interface EffortSectionProps {
  effortLevels: EffortLevel[];
  effort: EffortLevel | null;
  onChangeEffort: (effort: EffortLevel | null) => void;
}

/** Effort level selector rendered as pill/segment buttons. */
function EffortSection({ effortLevels, effort, onChangeEffort }: EffortSectionProps) {
  return (
    <div>
      <div className="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase">
        Effort
      </div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Effort level">
        <EffortPill
          label="Default"
          isSelected={effort === null}
          onClick={() => onChangeEffort(null)}
        />
        {effortLevels.map((level) => (
          <EffortPill
            key={level}
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

interface EffortPillProps {
  label: string;
  description?: string;
  isSelected: boolean;
  onClick: () => void;
}

/** Individual effort level pill button. */
function EffortPill({ label, description, isSelected, onClick }: EffortPillProps) {
  const pill = (
    <button
      role="radio"
      aria-checked={isSelected}
      onClick={onClick}
      className={cn(
        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150',
        isSelected
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
      )}
    >
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

interface ModeSectionProps {
  supportsFastMode: boolean;
  supportsAutoMode: boolean;
  fastMode: boolean;
  autoMode: boolean;
  onChangeFastMode: (enabled: boolean) => void;
  onChangeAutoMode: (enabled: boolean) => void;
}

/** Mode toggle pills for Fast and Auto modes. */
function ModeSection({
  supportsFastMode,
  supportsAutoMode,
  fastMode,
  autoMode,
  onChangeFastMode,
  onChangeAutoMode,
}: ModeSectionProps) {
  if (!supportsFastMode && !supportsAutoMode) return null;

  return (
    <div>
      <div className="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase">
        Mode
      </div>
      <div className="flex gap-1.5">
        {supportsFastMode && (
          <ModeToggle
            label="Fast"
            icon={<Zap className="size-3" />}
            isActive={fastMode}
            onToggle={() => onChangeFastMode(!fastMode)}
          />
        )}
        {supportsAutoMode && (
          <ModeToggle
            label="Auto"
            icon={<Sparkles className="size-3" />}
            isActive={autoMode}
            onToggle={() => onChangeAutoMode(!autoMode)}
          />
        )}
      </div>
    </div>
  );
}

interface ModeToggleProps {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onToggle: () => void;
}

/** Individual mode toggle pill. */
function ModeToggle({ label, icon, isActive, onToggle }: ModeToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={isActive}
      onClick={onToggle}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150',
        isActive
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface ModelConfigPopoverProps {
  model: string;
  onChangeModel: (model: string) => void;
  effort: EffortLevel | null;
  onChangeEffort: (effort: EffortLevel | null) => void;
  fastMode: boolean;
  autoMode: boolean;
  onChangeFastMode: (enabled: boolean) => void;
  onChangeAutoMode: (enabled: boolean) => void;
  /** When true, the trigger is disabled (e.g. no active session). */
  disabled?: boolean;
}

/**
 * Model configuration popover for the status bar.
 *
 * Opens a ~320px-wide panel above the trigger with grouped card selection
 * for models, effort levels, and mode toggles. Stays open until the user
 * clicks outside or presses Escape.
 */
export function ModelConfigPopover({
  model,
  onChangeModel,
  effort,
  onChangeEffort,
  fastMode,
  autoMode,
  onChangeFastMode,
  onChangeAutoMode,
  disabled,
}: ModelConfigPopoverProps) {
  const { data: models, isLoading, isError, refetch } = useModels();
  const modelList = models ?? [];
  const selectedModel = modelList.find((m) => m.value === model);

  const showEffort =
    selectedModel?.supportsEffort &&
    selectedModel.supportedEffortLevels &&
    selectedModel.supportedEffortLevels.length > 0;

  const showModes =
    (selectedModel?.supportsFastMode ?? false) || (selectedModel?.supportsAutoMode ?? false);

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
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 p-0"
        data-testid="model-config-popover"
      >
        <div className="p-3">
          {/* Model selection */}
          {isLoading && <ModelCardsSkeleton />}
          {isError && <ModelLoadError onRetry={() => refetch()} />}
          {!isLoading && !isError && (
            <RadioGroup
              value={model}
              onValueChange={onChangeModel}
              className="gap-1.5"
              aria-label="Model selection"
              data-testid="model-card-list"
            >
              {modelList.map((m) => (
                <ModelCard key={m.value} model={m} isSelected={m.value === model} />
              ))}
            </RadioGroup>
          )}

          {/* Configuration section — effort + mode grouped under shared header */}
          <AnimatePresence mode="wait">
            {!isLoading && !isError && (showEffort || showModes) && (
              <motion.div
                key={selectedModel?.value ?? 'none'}
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
                      supportsAutoMode={selectedModel?.supportsAutoMode ?? false}
                      fastMode={fastMode}
                      autoMode={autoMode}
                      onChangeFastMode={onChangeFastMode}
                      onChangeAutoMode={onChangeAutoMode}
                    />
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </PopoverContent>
    </Popover>
  );
}
