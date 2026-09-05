import type { LucideIcon } from 'lucide-react';

import { cn } from '@/layers/shared/lib/utils';
import { CopyButton } from './copy-button';
import { InlineCode } from './inline-code';

/** Props for {@link FeatureDisabledState}. */
export interface FeatureDisabledStateProps extends React.ComponentProps<'div'> {
  /** Glyph for the subsystem, drawn above the message. */
  icon: LucideIcon;
  /**
   * What is switched off, in the words the reader would use ("Messaging",
   * "Scheduling"). It is read as `{name} is off`, so keep it singular.
   */
  name: string;
  /** One short line on what turning it on gets them. */
  description: string;
  /** The command that turns it on, shown verbatim. */
  command: string;
  /**
   * The line above the command, saying where to type it.
   *
   * Defaults to quitting and restarting from a terminal, which is true for both
   * of DorkOS's own uses. A surface where that is not the way in overrides it.
   */
  commandHint?: string;
}

/**
 * Empty state shown when a feature is off because DorkOS was started without it.
 *
 * The command alone is not an instruction: somebody who has never opened a
 * terminal reads `DORKOS_RELAY_ENABLED=true dorkos` and has nowhere to put it
 * (DOR-1755). So the block always carries a line saying where the command goes,
 * and a button that copies it.
 */
export function FeatureDisabledState({
  icon: Icon,
  name,
  description,
  command,
  commandHint = 'Quit DorkOS, then start it again in your terminal with:',
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
        <p className="font-medium">{name} is off</p>
        <p className="text-muted-foreground mt-1 text-sm">{description}</p>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">{commandHint}</p>
      <div className="flex max-w-full items-center gap-1.5">
        <InlineCode className="min-w-0 px-3 py-1.5 text-sm break-all">{command}</InlineCode>
        <CopyButton value={command} label={`Copy the command that turns ${name} on`} />
      </div>
    </div>
  );
}
