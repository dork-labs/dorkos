import type { LucideIcon } from 'lucide-react';
import { InlineCode } from './inline-code';

interface FeatureDisabledStateProps {
  icon: LucideIcon;
  name: string;
  description: string;
  command: string;
}

/** Empty state shown when a subsystem feature flag is not enabled. */
export function FeatureDisabledState({
  icon: Icon,
  name,
  description,
  command,
}: FeatureDisabledStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
      <Icon className="text-muted-foreground/50 size-8" />
      <div>
        <p className="font-medium">{name} is currently disabled</p>
        <p className="text-muted-foreground mt-1 text-sm">{description}</p>
      </div>
      <InlineCode className="mt-2 px-3 py-1.5 text-sm">{command}</InlineCode>
    </div>
  );
}
