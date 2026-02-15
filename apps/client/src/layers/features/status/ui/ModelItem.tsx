import { Bot } from 'lucide-react';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
} from '@/layers/shared/ui';

const MODEL_OPTIONS = [
  { value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
];

function getModelLabel(model: string): string {
  const option = MODEL_OPTIONS.find((o) => o.value === model);
  if (option) return option.label;
  const match = model.match(/claude-(\w+)-/);
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) : model;
}

interface ModelItemProps {
  model: string;
  onChangeModel: (model: string) => void;
}

export function ModelItem({ model, onChangeModel }: ModelItemProps) {
  return (
    <ResponsiveDropdownMenu>
      <ResponsiveDropdownMenuTrigger asChild>
        <button className="inline-flex items-center gap-1 hover:text-foreground transition-colors duration-150">
          <Bot className="size-(--size-icon-xs)" />
          <span>{getModelLabel(model)}</span>
        </button>
      </ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent side="top" align="start" className="w-44">
        <ResponsiveDropdownMenuLabel>Model</ResponsiveDropdownMenuLabel>
        <ResponsiveDropdownMenuRadioGroup value={model} onValueChange={onChangeModel}>
          {MODEL_OPTIONS.map((m) => (
            <ResponsiveDropdownMenuRadioItem key={m.value} value={m.value}>
              {m.label}
            </ResponsiveDropdownMenuRadioItem>
          ))}
        </ResponsiveDropdownMenuRadioGroup>
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}
