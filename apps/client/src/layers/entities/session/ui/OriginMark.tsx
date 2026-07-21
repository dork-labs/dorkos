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
  /**
   * Suppress the accessible label and tooltip, rendering a purely decorative
   * icon (`aria-hidden`). Use this where the origin text is already visible
   * right next to the mark (e.g. SessionHeader's breadcrumb chip) — without
   * it, screen readers announce the origin twice and the tooltip repeats
   * text already on screen. Leave `false` (the default) on rows where the
   * icon is the ONLY origin signal, so it stays announced and hoverable.
   */
  decorative?: boolean;
}

/**
 * Small origin-identity icon, rendered ONLY for non-user sessions — mirrors
 * RuntimeMark's icon+tooltip shape but inverts its never-blank default:
 * returns `null` for `user`/absent/unknown origins (the AgentActivityBadge
 * render-null precedent), so unmarked rows read as "you" and only
 * automation gets a glyph. By default the icon carries its own tooltip and
 * accessible label; pass `decorative` when a visible label already sits next
 * to it.
 */
export function OriginMark({
  origin,
  label,
  size = 12,
  className,
  decorative = false,
}: OriginMarkProps) {
  const descriptor = getOriginDescriptor(origin as SessionOrigin | undefined);
  if (!descriptor) return null;

  const Icon = descriptor.icon;
  const text = label ?? descriptor.label;

  if (decorative) {
    return (
      <span aria-hidden="true" className={cn('inline-flex shrink-0 items-center', className)}>
        <Icon size={size} />
      </span>
    );
  }

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
