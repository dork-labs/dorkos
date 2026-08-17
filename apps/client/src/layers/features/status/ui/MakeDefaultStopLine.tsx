/**
 * "Start every new session in ⟨stop⟩?" — the offer that appears where the habit
 * happens (spec `trust-dial`, decision 6C).
 *
 * A person who moves the dial every morning has already told DorkOS what their
 * default is; sending them to Settings to say it again is the product not
 * listening. So the offer arrives right where they moved it, stays a few
 * seconds, and leaves without being answered.
 *
 * Purely presentational: the offer's life, the decision to make one at all, and
 * the write all live in `useMakeDefaultStop`.
 *
 * @module features/status/ui/MakeDefaultStopLine
 */
import { CircleAlert } from 'lucide-react';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import { cn } from '@/layers/shared/lib';
import { stopLabel } from '@/layers/shared/ui';

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
  /** True while the config write is in flight. */
  pending?: boolean;
  /**
   * Why the last write failed, or `null`. Shown in place of the question with
   * the offer still standing, so the answer a person gave is retryable rather
   * than silently dropped.
   */
  error?: string | null;
  /**
   * Where this instance is drawn, which decides how it takes up space:
   *
   * - `'inline'` — inside the dial's popover, in a row that is always there.
   *   The offer arrives under a control the person is mid-interaction with, so a
   *   line that pushed the caption and the scope note down would move the thing
   *   they are pointing at. The row holds its height whether or not it has
   *   anything in it.
   * - `'overlay'` — floating just above the status strip, taking no space at
   *   all. This is the instance that speaks when the popover is CLOSED: entering
   *   Full autonomy opens a modal dialog, and the dialog's focus grab closes the
   *   popover underneath it (observed in a browser, 2026-08-01), so the offer
   *   that follows has nowhere inline to go. Reserving a permanent row under the
   *   status line for that case would cost every conversation a blank line
   *   forever; floating costs nothing until there is something to say.
   *
   * @default 'inline'
   */
  placement?: 'inline' | 'overlay';
}

/**
 * The transient offer.
 *
 * Reduced motion gets the line instantly: the fade is decoration, the few
 * seconds of life are the behaviour and they are the hook's, not this
 * component's.
 *
 * @param props - The offered stop, the two answers, and how it is placed.
 */
export function MakeDefaultStopLine({
  stop,
  onMakeDefault,
  onDismiss,
  pending,
  error,
  placement = 'inline',
}: MakeDefaultStopLineProps) {
  const overlay = placement === 'overlay';
  // Nothing to say and nothing to reserve: the overlay instance disappears
  // entirely, which is what keeps it free.
  if (overlay && !stop) return null;

  return (
    <div
      className={cn(
        'flex items-center px-1',
        overlay
          ? 'bg-background/95 pointer-events-auto absolute right-0 bottom-full left-0 z-20 mb-1 rounded-md py-0.5 backdrop-blur-sm'
          : 'min-h-5'
      )}
      data-testid={overlay ? 'make-default-slot-overlay' : 'make-default-slot'}
    >
      {stop && (
        <p
          role="status"
          data-testid="make-default-offer"
          // `animate-in` is a one-shot mount animation, and `motion-reduce`
          // turns it off entirely — reduced motion gets the line at once and
          // keeps every second of its life.
          //
          // `flex` here, not `truncate`: the two actions used to share this
          // element's single `truncate` (`overflow-hidden` + `nowrap`) with the
          // sentence, so a runtime whose stop label was long enough — "Full
          // autonomy" is the one that shipped this way — pushed `Make default`
          // past the clipped edge. The button was still THERE, laid out at its
          // full-sentence position; `overflow-hidden` just stopped painting it
          // and stopped it from being hit-tested, so a click on where it looked
          // like it should be landed on this element instead (DOR-1270). Split
          // the row into a truncating sentence and a non-shrinking action
          // cluster instead, so only the words ever give way.
          className={cn(
            'animate-in fade-in-0 flex min-w-0 items-center gap-1.5 text-xs duration-200 motion-reduce:animate-none',
            error ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {error ? (
              <>
                <CircleAlert className="mr-1 inline size-3 shrink-0 align-[-2px]" aria-hidden />
                {error}
              </>
            ) : (
              <>Start every new session in {stopLabel(stop)}?</>
            )}
          </span>{' '}
          {/* Never `truncate`, and no `flex-wrap` either: whatever the sentence
              gives up, these stay on the one line and never shrink below their
              own content. That has a floor — below roughly 137px of row this
              cluster no longer fits at all — but nothing renders this offer
              that narrow today: the popover's fixed content is ~296px wide,
              matching production's floor, and its `overflow-x` computes to
              `auto` alongside the `overflow-y-auto` it already carries
              (`ResponsivePopoverContent`), so even a future narrower row would
              scroll into view rather than clip. */}
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
            {error ? (
              <button
                type="button"
                disabled={pending}
                onClick={onMakeDefault}
                data-testid="make-default-retry"
                className="focus-ring text-foreground rounded-sm underline underline-offset-2 disabled:opacity-50"
              >
                Try again
              </button>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={onMakeDefault}
                data-testid="make-default-confirm"
                className="focus-ring text-foreground rounded-sm underline underline-offset-2 disabled:opacity-50"
              >
                Make default
              </button>
            )}
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={onDismiss}
              data-testid="make-default-dismiss"
              className="focus-ring hover:text-foreground rounded-sm underline underline-offset-2"
            >
              Dismiss
            </button>
          </span>
        </p>
      )}
    </div>
  );
}
