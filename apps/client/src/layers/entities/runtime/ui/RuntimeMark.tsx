import { cn } from '@/layers/shared/lib';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { getRuntimeDescriptor } from '../config/runtime-descriptors';

interface RuntimeMarkProps {
  /** Runtime type identifier, e.g. `'claude-code'`. Unknown types render the neutral fallback. */
  type: string;
  /** Icon size in pixels. Defaults to a subtle 12px mark. */
  size?: number;
  className?: string;
}

/**
 * Small runtime-identity icon with a tooltip naming the runtime.
 *
 * Non-interactive — clicks pass through to the surrounding row. Resolves its
 * icon and label from {@link getRuntimeDescriptor}, so unknown runtime types
 * degrade to the neutral fallback instead of rendering blank.
 */
export function RuntimeMark({ type, size = 12, className }: RuntimeMarkProps) {
  const descriptor = getRuntimeDescriptor(type);
  const Icon = descriptor.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={`Runtime: ${descriptor.label}`}
          className={cn('inline-flex shrink-0 items-center', className)}
        >
          <Icon size={size} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {descriptor.label}
      </TooltipContent>
    </Tooltip>
  );
}
