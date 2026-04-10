import { Bot } from 'lucide-react';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';
import { useModels } from '@/layers/entities/session';
import type { ModelOption, EffortLevel } from '@dorkos/shared/types';

const EFFORT_LABELS: Record<EffortLevel, { label: string; description: string }> = {
  none: { label: 'None', description: 'No reasoning' },
  minimal: { label: 'Minimal', description: 'Near-zero thinking' },
  low: { label: 'Low', description: 'Fastest responses' },
  medium: { label: 'Medium', description: 'Moderate thinking' },
  high: { label: 'High', description: 'Deep reasoning' },
  max: { label: 'Max', description: 'Maximum thinking' },
  xhigh: { label: 'XHigh', description: 'Beyond maximum' },
};

function getModelLabel(model: string, models: ModelOption[]): string {
  const option = models.find((o) => o.value === model);
  if (option) return option.displayName;
  const match = model.match(/claude-(\w+)-/);
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) : model;
}

interface ModelItemProps {
  model: string;
  onChangeModel: (model: string) => void;
  /** Current effort level, or null for SDK default. */
  effort: EffortLevel | null;
  /** Called when the user selects an effort level (null = default). */
  onChangeEffort: (effort: EffortLevel | null) => void;
  /** When true, the selector is disabled and shows a tooltip explaining why. */
  disabled?: boolean;
}

/** Status bar item with a dropdown to view and change the active model and effort level. */
export function ModelItem({
  model,
  onChangeModel,
  effort,
  onChangeEffort,
  disabled,
}: ModelItemProps) {
  const { data: models = [] } = useModels();
  const selectedModel = models.find((m) => m.value === model);
  const effortLevels = selectedModel?.supportedEffortLevels;
  const showEffort = selectedModel?.supportsEffort && effortLevels && effortLevels.length > 0;

  const trigger = (
    <button
      disabled={disabled}
      className="hover:text-foreground inline-flex items-center gap-1 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Bot className="size-(--size-icon-xs)" />
      <span>{getModelLabel(model, models)}</span>
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
    <ResponsiveDropdownMenu>
      <ResponsiveDropdownMenuTrigger asChild>{trigger}</ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent side="top" align="start" className="w-56">
        <ResponsiveDropdownMenuLabel>Model</ResponsiveDropdownMenuLabel>
        <ResponsiveDropdownMenuRadioGroup value={model} onValueChange={onChangeModel}>
          {models.map((m) => (
            <ResponsiveDropdownMenuRadioItem key={m.value} value={m.value}>
              <div>
                <div>{m.displayName}</div>
                <div className="text-muted-foreground text-[10px] leading-tight">
                  {m.description}
                </div>
              </div>
            </ResponsiveDropdownMenuRadioItem>
          ))}
        </ResponsiveDropdownMenuRadioGroup>
        {showEffort && (
          <>
            <div className="bg-border my-1 h-px" />
            <ResponsiveDropdownMenuLabel>Effort</ResponsiveDropdownMenuLabel>
            <ResponsiveDropdownMenuRadioGroup
              value={effort ?? 'default'}
              onValueChange={(v) => onChangeEffort(v === 'default' ? null : (v as EffortLevel))}
            >
              <ResponsiveDropdownMenuRadioItem value="default">
                <div>
                  <div>Default</div>
                  <div className="text-muted-foreground text-[10px] leading-tight">SDK decides</div>
                </div>
              </ResponsiveDropdownMenuRadioItem>
              {effortLevels.map((level) => (
                <ResponsiveDropdownMenuRadioItem key={level} value={level}>
                  <div>
                    <div>{EFFORT_LABELS[level].label}</div>
                    <div className="text-muted-foreground text-[10px] leading-tight">
                      {EFFORT_LABELS[level].description}
                    </div>
                  </div>
                </ResponsiveDropdownMenuRadioItem>
              ))}
            </ResponsiveDropdownMenuRadioGroup>
          </>
        )}
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}
