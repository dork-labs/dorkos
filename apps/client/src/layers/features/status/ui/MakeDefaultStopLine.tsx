/**
 * "Start every new session in ⟨stop⟩?" — the offer that appears where the habit
 * happens (spec `trust-dial`, decision 6C).
 *
 * A person who moves the dial every morning has already told DorkOS what their
 * default is; sending them to Settings to say it again is the product not
 * listening. So the offer arrives under the dial they just moved, stays a few
 * seconds, and leaves without being answered.
 *
 * @module features/status/ui/MakeDefaultStopLine
 */
import { useEffect } from 'react';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import { stopLabel } from '@/layers/shared/ui';

/**
 * How long the offer stays before it withdraws itself, in ms.
 *
 * Long enough to read and answer, short enough that it never becomes furniture:
 * an offer that waits forever is a second control in the popover, and this one
 * is a remark.
 */
const OFFER_MS = 6_000;

export interface MakeDefaultStopLineProps {
  /**
   * The stop the person just chose, or `null` when there is nothing to offer —
   * they chose the stop that is ALREADY the default, they dismissed the offer
   * for this session, or they have not moved the dial at all. The caller owns
   * every one of those decisions; this component only draws the offer.
   */
  stop: PermissionStop | null;
  /** Make it the default for every new session. */
  onMakeDefault: () => void;
  /** Never offer this again for this session. */
  onDismiss: () => void;
  /** The offer withdrew itself after {@link OFFER_MS}. */
  onExpire: () => void;
  /** True while the config write is in flight. */
  pending?: boolean;
}

/**
 * The transient offer, in a row that is always there.
 *
 * **The space is reserved, not created.** The offer appears under a control the
 * person is mid-interaction with, and a line that pushed the caption and the
 * scope note down as it arrived would move the thing they are pointing at. So
 * the row holds its height whether or not it has anything in it.
 *
 * Reduced motion gets the line instantly and keeps the timer: the fade is
 * decoration, the few-seconds life is the behaviour.
 *
 * @param props - The offered stop, the two answers, and the expiry callback.
 */
export function MakeDefaultStopLine({
  stop,
  onMakeDefault,
  onDismiss,
  onExpire,
  pending,
}: MakeDefaultStopLineProps) {
  // The only thing this component owns: the offer's few-seconds life. The fade
  // is a CSS animation on the mount rather than a piece of state, which is what
  // keeps this effect free of a synchronous setState and the render free of a
  // second pass.
  useEffect(() => {
    if (!stop) return;
    const timer = setTimeout(onExpire, OFFER_MS);
    return () => clearTimeout(timer);
  }, [stop, onExpire]);

  return (
    <div className="flex min-h-5 items-center px-1" data-testid="make-default-slot">
      {stop && (
        <p
          role="status"
          data-testid="make-default-offer"
          // `animate-in` is a one-shot mount animation, and `motion-reduce`
          // turns it off entirely — reduced motion gets the line at once and
          // keeps every second of its life.
          className="text-muted-foreground animate-in fade-in-0 truncate text-xs duration-200 motion-reduce:animate-none"
        >
          Start every new session in {stopLabel(stop)}?{' '}
          <button
            type="button"
            disabled={pending}
            onClick={onMakeDefault}
            data-testid="make-default-confirm"
            className="text-foreground underline underline-offset-2 disabled:opacity-50"
          >
            Make default
          </button>
          <span aria-hidden> · </span>
          <button
            type="button"
            onClick={onDismiss}
            data-testid="make-default-dismiss"
            className="hover:text-foreground underline underline-offset-2"
          >
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}
