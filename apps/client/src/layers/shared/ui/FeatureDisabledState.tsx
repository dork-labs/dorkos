import type { LucideIcon } from 'lucide-react';

import { cn } from '@/layers/shared/lib/utils';
import { InlineCode } from './inline-code';

/** Props for {@link FeatureDisabledState}. */
export interface FeatureDisabledStateProps extends React.ComponentProps<'div'> {
  /** Glyph for the subsystem, drawn above the message. */
  icon: LucideIcon;
  /** What is switched off, in the words the reader would use. */
  name: string;
  /** One short line on what turning it on gets them. */
  description: string;
  /** The command that turns it on, shown verbatim. */
  command: string;
}

/** Empty state shown when a subsystem feature flag is not enabled. */
export function FeatureDisabledState({
  icon: Icon,
  name,
  description,
  command,
  className,
  ...props
}: FeatureDisabledStateProps) {
  return (
    <div
      data-slot="feature-disabled-state"
      className={cn('flex flex-col items-center justify-center gap-3 p-8 text-center', className)}
      {...props}
    >
      <Icon className="text-muted-foreground/50 size-8" />
      <div>
        <p className="font-medium">{name} is currently disabled</p>
        <p className="text-muted-foreground mt-1 text-sm">{description}</p>
      </div>
      <InlineCode className="mt-2 px-3 py-1.5 text-sm">{command}</InlineCode>
    </div>
  );
}
