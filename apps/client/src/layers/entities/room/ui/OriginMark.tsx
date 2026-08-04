/**
 * The mark that says a room member — or one of their messages — comes from
 * outside this machine (chats-as-channels spec §4.3, §9).
 *
 * @module entities/room/ui/OriginMark
 */
import { ADAPTER_LOGO_MAP } from '@dorkos/icons/adapter-logos';
import { Send } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { AuthorOrigin } from '@dorkos/shared/room-schemas';
import { platformLabel } from '../lib/room-display';

export interface OriginMarkProps {
  /**
   * Where the author is. `'local'` renders nothing — the operator, an agent,
   * and the room's own voice are all on this machine, and a mark that fires
   * for everyone is not a mark.
   *
   * `undefined` is accepted, and treated the same as `'local'`, even though
   * the wire schema carries `origin` as required. This field is new
   * (chats-as-channels DOR-868/DOR-879) on a roster shape many callers —
   * fixtures, caches, an older tab that hasn't reloaded — built before it
   * existed; the honest failure mode for "we don't know where this author is"
   * is to say nothing, never to crash the row around them.
   */
  origin: AuthorOrigin | undefined;
  className?: string;
}

/**
 * "· Telegram" (with its brand mark), read straight off the author's stored
 * origin and never re-derived.
 *
 * **This is a security boundary, not decoration** (spec §9): "a person on
 * this machine wrote this" and "a stranger on the internet wrote this" have
 * to be told apart at a glance, in the roster, in the room sheet, and beside
 * every one of that person's entries in the feed — never behind a hover or a
 * tooltip, which is exactly the affordance a glance does not have time for.
 *
 * The platform's own brand mark is used where this client recognizes the
 * platform (`ADAPTER_LOGO_MAP`, the same registry the connection surfaces
 * draw from) and a generic external-message glyph otherwise, so an origin
 * this build does not yet have a logo for still reads as "not from here"
 * rather than rendering nothing at all.
 */
export function OriginMark({ origin, className }: OriginMarkProps) {
  if (origin === 'local' || typeof origin !== 'object' || origin === null) return null;

  const Logo = ADAPTER_LOGO_MAP[origin.platform];
  const label = platformLabel(origin.platform);

  return (
    <span
      data-slot="origin-mark"
      data-testid="origin-mark"
      className={cn('text-muted-foreground inline-flex items-center gap-1 text-xs', className)}
    >
      {/* The visible form is decorative middot + glyph + name; a screen
          reader gets one clean phrase instead of three fragments read
          separately ("dot", "graphic", "Telegram"). */}
      <span aria-hidden className="inline-flex items-center gap-1">
        <span>·</span>
        {Logo ? <Logo size={11} /> : <Send className="size-2.5" />}
        {label}
      </span>
      <span className="sr-only">, from {label}</span>
    </span>
  );
}
