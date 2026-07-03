import { cn } from '@/layers/shared/lib';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { getRuntimeDescriptor } from '../config/runtime-descriptors';
import { formatRuntimeIdentity } from '../lib/runtime-identity';

interface RuntimeMarkProps {
  /** Runtime type identifier, e.g. `'claude-code'`. Unknown types render the neutral fallback. */
  type: string;
  /**
   * The session's resolved model id. When present, the identity reads
   * "<runtime> · <model>" in the tooltip and accessible name; absent, it is the
   * runtime alone. Keeps dense list rows icon-only while making the full
   * runtime + model identity legible on hover (spec decision 8).
   */
  model?: string | null;
  /** Icon size in pixels. Defaults to a subtle 12px mark. */
  size?: number;
  className?: string;
}

/**
 * Small runtime-identity icon with a tooltip naming the runtime (and its model
 * when known).
 *
 * Non-interactive — clicks pass through to the surrounding row. Resolves its
 * icon from {@link getRuntimeDescriptor} and its identity text from
 * {@link formatRuntimeIdentity} — the same formatter the spelled-out surfaces
 * use — so unknown runtime types degrade to the neutral fallback and a missing
 * model degrades to the runtime alone, never rendering blank.
 */
export function RuntimeMark({ type, model, size = 12, className }: RuntimeMarkProps) {
  const descriptor = getRuntimeDescriptor(type);
  const Icon = descriptor.icon;
  const { text } = formatRuntimeIdentity({ runtime: type, model });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={`Runtime: ${text}`}
          className={cn('inline-flex shrink-0 items-center', className)}
        >
          <Icon size={size} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
