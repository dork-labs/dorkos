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
import type { ModelOption } from '@dorkos/shared/types';

function getModelLabel(model: string, models: ModelOption[]): string {
  const option = models.find((o) => o.value === model);
  if (option) return option.displayName;
  const match = model.match(/claude-(\w+)-/);
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) : model;
}

interface ModelItemProps {
  model: string;
  onChangeModel: (model: string) => void;
  /** When true, the selector is disabled and shows a tooltip explaining why. */
  disabled?: boolean;
}

/** Status bar item with a dropdown to view and change the active model. */
export function ModelItem({ model, onChangeModel, disabled }: ModelItemProps) {
  const { data: models = [] } = useModels();

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
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}
