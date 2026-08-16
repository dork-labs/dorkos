/**
 * The presence strip — who on this team is working, right now.
 *
 * Presentational and complete: it draws the rows it is handed and calls back
 * when one is picked. Everything about where the rows came from, and everything
 * about what "working" means, is settled before it gets here.
 *
 * @module features/presence-strip/ui/PresenceStrip
 */
import { useState } from 'react';
import { IdentityAvatar, IdentityHoverCard } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { PresenceFollowTarget, PresenceRow } from '../lib/presence-rows';

/**
 * How many agents the strip draws before it starts counting.
 *
 * **The strip is one line tall, by construction, at every width.** It is pinned
 * chrome above a feed, so every row it adds is a row the feed loses and never
 * gets back — and at 375px a wrapping strip of twelve agents was four lines of
 * header before the first message. So it does not wrap: the overflow becomes a
 * count, exactly as the room's own presence line stops naming past three.
 *
 * Five, because the rows arrive ordered by usefulness (room claims first,
 * oldest claim first within them) and five of those is already more than a
 * person triages at a glance — while four would start counting on a fleet that
 * is merely busy.
 */
const VISIBLE_LIMIT = 5;

/**
 * The invisible padding that turns a 28px chip into a 48px touch target.
 *
 * **Anisotropic on purpose.** The house recipe (`after:-inset-3`, from
 * `ApprovalCard`) grows a target 12px in every direction, which at this strip's
 * horizontal rhythm would overlap the neighbouring chip's target and hand taps
 * to the wrong agent. The vertical axis has the room — nothing sits above or
 * below inside the header — so the height comes from there, and the horizontal
 * growth stays inside half the `gap-x-2` between chips.
 *
 * `md:after:hidden` because a pointer needs none of this, and the pseudo-element
 * would otherwise sit over the gap and swallow hovers meant for the next chip.
 * `relative` is part of the contract, not decoration: without it the absolutely
 * positioned `::after` resolves against some ancestor and the target lands
 * somewhere else entirely.
 */
const TOUCH_TARGET = 'relative after:absolute after:-inset-x-1 after:-inset-y-2.5 md:after:hidden';

/**
 * How long a claim had been running when you looked at it.
 *
 * The elapsed time belongs to the leaf that draws it — the rows carry an
 * immutable `since` precisely so the header above them does not re-render once
 * a second (see `useRoomPresenceEverywhere`). This is where the clock comes
 * back, and it is read exactly once: at the moment a pointer or focus lands on
 * the chip, which is the moment the hover card is about to open.
 *
 * **It does not tick, and that is a decision rather than an omission.** The
 * card is a glance — it opens 300ms after the pointer arrives and closes when
 * it leaves — so a number taken at the start of that glance is right for the
 * whole of it, and a second timer per chip would cost the strip exactly what
 * dropping the clock from the rows just saved. The signal that a wait has gone
 * long is the server's `working_late`, which is on the row itself and does not
 * depend on this at all.
 *
 * @param since - When the work started (ISO 8601), or `null` when nothing
 *   measures it — a running session has a lifecycle, not a start time.
 * @param watchedAt - This client's clock when the chip was looked at, or `null`
 *   when it is not being looked at.
 * @returns Milliseconds elapsed at that moment, or `null` when there is nothing
 *   to measure.
 */
function elapsedWhenWatched(since: string | null, watchedAt: number | null): number | null {
  if (since === null || watchedAt === null) return null;
  // Clamped, like every other elapsed time in the cockpit: two clocks are being
  // subtracted (the server's `since`, this browser's now), and a machine
  // running slow must not count backwards.
  return Math.max(0, watchedAt - Date.parse(since));
}

export interface PresenceStripProps {
  /** Who is working, room claims first. Empty draws nothing at all. */
  rows: readonly PresenceRow[];
  /** Watch one agent's work. Never claims it — see {@link PresenceFollowTarget}. */
  onFollow: (target: PresenceFollowTarget) => void;
  /**
   * Open one agent's profile, from the hover card's own footer.
   *
   * A **prop, never an import**, for the same reason `IdentityHoverCard` takes
   * one: this strip is handed its rows and calls back, and nothing in it should
   * know what a profile is. Omitted — the dev playground, or any host with
   * nowhere to send a reader — leaves the footer the inert line marked
   * **soon**, which is what it says today for every row.
   *
   * Only ever called with a row that named one, so a caller never has to guard
   * against an empty id.
   */
  onViewProfile?: (memberId: string) => void;
  /** Extra classes for the strip's own element. */
  className?: string;
}

/**
 * One agent: its disc, its name, and what it is bound to.
 *
 * The whole row is one button, because there is one thing to do with it —
 * watch. There is no menu, no stop, no take-over: an agent mid-turn is somebody
 * else's work, and the strip's entire offer is a window onto it
 * (`meta/agent-etiquette.md`). The absence of controls here is the feature.
 *
 * **The profile is on the card, not on the press.** Pressing a chip still
 * follows the work — that is the strip's whole subject, and re-pointing it at a
 * settings surface would take away the one thing this line exists to offer. The
 * hover card the same chip already opens is where "View profile" belongs, and
 * until now that footer said **soon** on a strip whose every row could name its
 * agent (spec `profile-unification` §3, bug 7).
 */
function PresenceRowButton({
  row,
  onFollow,
  onViewProfile,
}: {
  row: PresenceRow;
  onFollow: (target: PresenceFollowTarget) => void;
  onViewProfile?: (memberId: string) => void;
}) {
  // The instant the chip was looked at, not a boolean: reading the clock in an
  // event handler is free of every purity question a render-time read raises,
  // and it is the only reading the card below needs.
  const [watchedAt, setWatchedAt] = useState<number | null>(null);
  const forMs = elapsedWhenWatched(row.since, watchedAt);
  // Both halves have to be in hand: a host with nowhere to send a reader and a
  // row whose agent the fleet could not name are the same answer here — leave
  // the footer inert rather than dress it as a control.
  const memberId = row.profileMemberId;
  const viewProfile =
    onViewProfile === undefined || memberId === null ? undefined : () => onViewProfile(memberId);

  return (
    <IdentityHoverCard
      onViewProfile={viewProfile}
      identity={{
        kind: row.face.kind,
        displayName: row.name,
        ...(row.handle !== null ? { handle: row.handle } : {}),
        color: row.face.color,
        ...(row.face.emoji !== undefined ? { emoji: row.face.emoji } : {}),
        ...(row.face.imageUrl !== undefined ? { imageUrl: row.face.imageUrl } : {}),
        ...(row.face.origin !== undefined ? { origin: row.face.origin } : {}),
        // A chip per fact in hand and nothing for one that is not: an agent the
        // fleet could not name reads as a name alone rather than as an invented
        // runtime. The card's own `working` block wants a duration, so it is
        // filled only where a claim measures one — a session mid-turn has a
        // lifecycle and no clock, and a card saying "for 0s" would be a made-up
        // number rather than a missing one.
        ...(row.face.kind === 'agent'
          ? {
              agent: {
                ...(row.runtime !== null ? { runtime: row.runtime } : {}),
                ...(forMs !== null
                  ? {
                      working: {
                        ...(row.roomTitle !== null ? { room: row.roomTitle } : {}),
                        forMs,
                      },
                    }
                  : {}),
              },
            }
          : {}),
      }}
    >
      <button
        type="button"
        // Names the ACTION and keeps the name inside the label, the same shape
        // the mention pill and the sidebar face use — so "watch tangerines" is
        // sayable by voice and the visible text is a prefix of what is spoken.
        aria-label={row.detail === null ? `Watch ${row.name}` : `Watch ${row.name} — ${row.detail}`}
        onClick={() => onFollow(row.follow)}
        onPointerEnter={() => setWatchedAt(Date.now())}
        onPointerLeave={() => setWatchedAt(null)}
        onFocus={() => setWatchedAt(Date.now())}
        onBlur={() => setWatchedAt(null)}
        className={cn(
          'focus-ring group/identity hover:bg-muted/60 flex min-w-0 items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1 text-xs transition-colors',
          TOUCH_TARGET
        )}
      >
        <IdentityAvatar
          size="xs"
          kind={row.face.kind}
          color={row.face.color}
          {...(row.face.emoji !== undefined ? { emoji: row.face.emoji } : {})}
          {...(row.face.imageUrl !== undefined ? { imageUrl: row.face.imageUrl } : {})}
          {...(row.face.origin !== undefined ? { origin: row.face.origin } : {})}
          fallback={row.face.fallback}
          // The pulsing dot IS the claim: every row on this strip is live by
          // construction, and a still disc beside the word "working" would be
          // the one thing on screen not saying "right now". Hardcoded rather
          // than threaded, because the strip's own query is what decides who
          // appears on it — a row that is not working is not drawn at all.
          status="working"
        />
        <span className="text-foreground shrink-0 font-medium">{row.name}</span>
        {row.detail !== null && (
          // Truncated rather than wrapped: the strip is a line under a header,
          // and a room with a long name must cost this row width, never the
          // header height. `aria-hidden` because the button's label already
          // carries every word of it — without that a screen reader reads the
          // detail twice, once in the name and once in the text.
          <span aria-hidden className="text-muted-foreground truncate">
            · {row.detail}
          </span>
        )}
      </button>
    </IdentityHoverCard>
  );
}

/**
 * The line of who is working, drawn under the triage header's two groups.
 *
 * **Nothing to say means nothing on screen.** No "nobody is working" line, no
 * reserved strip of empty space: an idle cockpit should look idle, and the
 * quiet-state copy belongs to the home surface that knows what else is on the
 * page, not to a component whose entire subject has gone away. The host asks
 * this question before it renders (`usePresenceStrip`'s `occupied`), so an
 * empty strip collapses the header rather than framing a blank.
 *
 * **One line tall, whatever the fleet is doing.** It never wraps: past
 * {@link VISIBLE_LIMIT} the remainder becomes a single count, and a long room
 * name costs its own chip's width rather than the header's height.
 *
 * **Every row is a window, never a handle.** Watching is the only thing offered
 * here — there is no stop, no take-over, no reassign — because an agent
 * mid-turn is work in progress and the etiquette rule is watch, not hijack.
 * Following opens the room or the session as a reader; the session lock is only
 * ever taken by a write, so nothing on this strip can take one.
 *
 * Not a live region, deliberately. Presence changes every time any agent starts
 * or stops anything, and a strip that announced each one would talk over the
 * page for as long as the fleet is busy. The room's own presence line is where
 * a wait gets announced, once, to the person actually waiting on it.
 *
 * @param props - See {@link PresenceStripProps}.
 */
export function PresenceStrip({ rows, onFollow, onViewProfile, className }: PresenceStripProps) {
  if (rows.length === 0) return null;

  const drawn = rows.slice(0, VISIBLE_LIMIT);
  const counted = rows.length - drawn.length;

  return (
    <ul
      data-testid="presence-strip"
      // Named, because a list of avatars is unreadable without one: a reader
      // arriving here is told what the set IS and how many are in it before
      // deciding whether to walk it. The role stays implicit — the `ul` already
      // carries it, and restating it is a lint error in this repo.
      aria-label="Working right now"
      className={cn('flex items-center gap-x-2 overflow-hidden', className)}
    >
      {drawn.map((row) => (
        <li key={row.id} className="min-w-0">
          <PresenceRowButton row={row} onFollow={onFollow} onViewProfile={onViewProfile} />
        </li>
      ))}
      {counted > 0 && (
        // A fact, not a control: there is nowhere for it to lead that the
        // sidebar roster and `/team` do not already answer better, and a button
        // that expanded the strip would give back the height the cap just saved.
        <li
          // Labelled rather than left to its text: a `listitem` takes its name
          // from the author, never from its contents, so `+7 more` on its own
          // reaches a screen reader as a bare glyph. The label is the sentence
          // the glyph is short for.
          aria-label={
            counted === 1 ? '1 more agent is working' : `${counted} more agents are working`
          }
          className="text-muted-foreground shrink-0 text-xs"
        >
          <span aria-hidden>+{counted} more</span>
        </li>
      )}
    </ul>
  );
}
