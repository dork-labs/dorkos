import { Bot } from 'lucide-react';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
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
}

export function ModelItem({ model, onChangeModel }: ModelItemProps) {
  const { data: models = [] } = useModels();

  return (
    <ResponsiveDropdownMenu>
      <ResponsiveDropdownMenuTrigger asChild>
        <button className="hover:text-foreground inline-flex items-center gap-1 transition-colors duration-150">
          <Bot className="size-(--size-icon-xs)" />
          <span>{getModelLabel(model, models)}</span>
        </button>
      </ResponsiveDropdownMenuTrigger>
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
