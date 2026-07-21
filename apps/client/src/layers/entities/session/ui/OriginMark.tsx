import { cn } from '@/layers/shared/lib';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import type { SessionOrigin } from '@dorkos/shared/types';
import { getOriginDescriptor } from '../config/origin-descriptors';

interface OriginMarkProps {
  /** Session's resolved origin. `undefined`/`'user'`/unrecognized all render nothing. */
  origin?: string;
  /** The session's own `originLabel`, when present — takes priority over the descriptor's generic fallback label. */
  label?: string;
  /** Icon size in pixels. Defaults to a subtle 12px mark, matching RuntimeMark. */
  size?: number;
  className?: string;
}

/**
 * Small origin-identity icon with a tooltip naming the origin, rendered ONLY
 * for non-user sessions — mirrors RuntimeMark's icon+tooltip shape but
 * inverts its never-blank default: returns `null` for `user`/absent/unknown
 * origins (the AgentActivityBadge render-null precedent), so unmarked rows
 * read as "you" and only automation gets a glyph.
 */
export function OriginMark({ origin, label, size = 12, className }: OriginMarkProps) {
  const descriptor = getOriginDescriptor(origin as SessionOrigin | undefined);
  if (!descriptor) return null;

  const Icon = descriptor.icon;
  const text = label ?? descriptor.label;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={`Origin: ${text}`}
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
