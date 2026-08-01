import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import {
  hasReacted,
  reactionSummary,
  splitReactionRow,
  type RoomEntryReaction,
} from '@/layers/entities/room';
import { useRovingButtons, type RovingGroupHandle } from '../model/use-roving-buttons';
import { EntryReactionPicker } from './EntryReactionPicker';

/**
 * A count that rolls up into place when it changes.
 *
 * **Its own component because the animation has to survive a re-render.** The
 * class is decided once, on mount, and frozen — a flag recomputed on every
 * render is stripped the moment anything else re-renders the row (the SSE frame
 * confirming the very reaction that triggered it, for one), which cancels the
 * animation about ten milliseconds in. That is not a hypothetical: a per-frame
 * trace of the live surface showed the 240ms pop running for exactly two frames
 * before this and its sibling below were split out.
 *
 * Mounted fresh by its parent's `key={count}`, so "changed" and "mounted" are
 * the same event.
 */
function RollingCount({ count, roll, mine }: { count: number; roll: boolean; mine: boolean }) {
  const [rolling] = useState(roll);
  return (
    <span
      aria-hidden
      className={cn(
        'tabular-nums',
        mine ? 'text-foreground/80' : 'text-muted-foreground',
        rolling && 'motion-safe:animate-reaction-roll'
      )}
    >
      {count}
    </span>
  );
}

interface ReactionPillProps {
  /** The pill's reaction. */
  reaction: RoomEntryReaction;
  /** Whether the reader is on it — the accent, and `aria-pressed`. */
  mine: boolean;
  /** What the tooltip says: who reacted, by name. */
  summary: string;
  /** True when this pill has just arrived and should pop. Frozen at mount. */
  arrived: boolean;
  /** True when the count changed rather than the pill being new. */
  rolled: boolean;
  /** Press it to toggle. */
  onToggle: () => void;
  /** True when reacting cannot land right now. */
  disabled?: boolean;
  /** Registers this pill with the row's roving sequence. */
  buttonRef: Ref<HTMLButtonElement>;
  /** The row's arrow / Escape handling. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * One pill: an emoji, a count, and the accent when it is yours.
 *
 * Arrival is CSS — the design's exact keyframes, stated in `index.css` — and
 * removal is `motion`'s, because an exit is the one thing CSS cannot animate.
 * The two never overlap: a pill is either coming or going.
 */
function ReactionPill({
  reaction,
  mine,
  summary,
  arrived,
  rolled,
  onToggle,
  disabled,
  buttonRef,
  onKeyDown,
}: ReactionPillProps) {
  // Frozen at mount, for the reason `RollingCount` explains.
  const [pops] = useState(arrived);
  const count = reaction.authorIds.length;

  return (
    <motion.button
      ref={buttonRef}
      type="button"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // Removal only, and a plain fade: the celebration belongs to arriving.
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      disabled={disabled}
      onClick={onToggle}
      aria-pressed={mine}
      aria-label={summary}
      title={summary}
      data-testid="entry-reaction"
      data-emoji={reaction.emoji}
      data-mine={mine ? 'true' : undefined}
      className={cn(
        'focus-ring relative inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
        'disabled:pointer-events-none disabled:opacity-50',
        // A pill is ~20px tall and stays that way — it is a quiet mark under a
        // message, not a control competing with it — so the TARGET grows and
        // the pill does not: 12px of reach above and below takes it to 44px.
        // Vertical only, because pills sit 4px apart in a row and reaching
        // sideways would have each one stealing taps from its neighbour.
        "after:absolute after:inset-x-0 after:-inset-y-3 after:content-[''] md:after:hidden",
        mine
          ? 'border-brand/70 bg-brand/12 text-foreground'
          : 'border-border bg-muted/60 text-muted-foreground hover:bg-muted',
        pops && 'motion-safe:animate-reaction-pop'
      )}
    >
      {/* The one-shot ring burst, drawn only for a pill that arrived. It ends at
          `opacity: 0` and its resting class says the same, so it costs nothing
          once it has fired — and it is `pointer-events-none`, because it expands
          past the pill and must never eat the click that takes the reaction
          back. */}
      {pops && (
        <span
          aria-hidden
          className="border-brand motion-safe:animate-reaction-ring pointer-events-none absolute -inset-1 rounded-full border opacity-0"
        />
      )}
      <span aria-hidden>{reaction.emoji}</span>
      <RollingCount key={count} count={count} roll={rolled} mine={mine} />
    </motion.button>
  );
}

interface EntryReactionRowProps {
  /** The entry's reactions, oldest pill first. Nothing is drawn when empty. */
  reactions: readonly RoomEntryReaction[];
  /** The reader's own author id here — which pills glow, and who "You" is. */
  viewerAuthorId: string;
  /** Display names by author id, from the room's roster. */
  names: ReadonlyMap<string, string>;
  /** The reader's most-used emoji, for the picker the ghost + opens. */
  frequents: readonly string[];
  /** Put one on, or take it back. */
  onToggle: (emoji: string) => void;
  /** True when reacting cannot land — a room whose stream has died. */
  disabled?: boolean;
  /** Hand focus back to the message — the way out, bound to Escape. */
  onExit: () => void;
}

/**
 * The pills under a message.
 *
 * All five approved behaviours (`specs/room-messaging-design` §2) live here:
 * the pill you added carries the accent and IS the toggle; hovering names names
 * rather than counting; arrival pops with a ring burst and a count that rolls,
 * while removal is a plain fade; and once a message has any reaction a faint
 * 🙂+ ends the row. A message with none renders nothing at all — no ghost, no
 * empty rail — which is what keeps a quiet room quiet.
 *
 * **Only reactions that ARRIVE animate.** The pop is keyed to what changed since
 * the last render, not to what is mounted: opening a room with forty pills in it
 * would otherwise throw a party for history. The first render of a row is
 * therefore silent by construction, and everything after it celebrates only the
 * pill that actually just landed.
 *
 * **It is one roving tab stop, not one per pill.** The same rule the capsule
 * follows and for the same reason: a message with ten reactions on it would
 * otherwise cost eleven presses to walk past. The buttons are reached from the
 * message with ArrowDown — the pills are BELOW it, as the capsule is above —
 * moved between with arrows, and left with Escape.
 */
export const EntryReactionRow = forwardRef<RovingGroupHandle, EntryReactionRowProps>(
  function EntryReactionRow(
    { reactions, viewerAuthorId, names, frequents, onToggle, disabled, onExit },
    ref
  ) {
    const [expanded, setExpanded] = useState(false);
    // What the row held at its last COMMIT. `null` until the first paint, which
    // is what makes the initial render animate nothing.
    //
    // A ref read during render, deliberately, and the one place in this file
    // that is. React Compiler's rule is right in general — a ref read in render
    // is usually a value that should have been state — and wrong here for a
    // reason it cannot see: the question being asked is literally "what was
    // committed last time", which state cannot answer. Setting state during
    // render re-runs the component and hands back the NEW value, and setting it
    // in an effect costs a whole extra render for an animation flag. Everything
    // this decides is a one-shot animation frozen at the child's mount, so a
    // stale read cannot desynchronise anything a reader can see.
    //
    const seenRef = useRef<Map<string, number> | null>(null);
    const previous = seenRef.current;

    // The last pill's fade needs this row to outlive it. An exit animation runs
    // inside `AnimatePresence`, and unmounting the row unmounts that with it —
    // so a row that vanished the instant its set emptied would swallow the very
    // fade the design asks for. It lingers until the exit reports itself done.
    //
    // Decided DURING render, not in an effect, and that is the whole of why it
    // works: an effect runs after the commit, by which time the row has already
    // returned `null` and taken `AnimatePresence` with it. React re-runs a
    // component that sets state while rendering and throws the first pass away,
    // so the `null` never reaches the DOM. Measured — with this in an effect,
    // the pill left in one frame and the 120ms fade never ran.
    const [lingering, setLingering] = useState(false);
    const [held, setHeld] = useState(reactions.length);
    if (held !== reactions.length) {
      setHeld(reactions.length);
      setLingering(reactions.length === 0 && held > 0);
    }

    useEffect(() => {
      seenRef.current = new Map(reactions.map((r) => [r.emoji, r.authorIds.length]));
    });

    const { shown, hidden } = splitReactionRow(reactions);
    const drawn = expanded ? reactions : shown;
    const mine = reactions.filter((r) => hasReacted(r, viewerAuthorId)).map((r) => r.emoji);
    // Every pill, then the overflow button when there is one, then the ghost +.
    // The ghost + is counted only when it is DRAWN: during the frame this row
    // lingers for the last pill's fade there are no reactions left, so the
    // picker is not rendered and a group sized as though it were would wrap
    // arrow keys onto a button that is not there.
    const overflow = hidden > 0 && !expanded ? 1 : 0;
    const ghost = reactions.length > 0 ? 1 : 0;
    const { register, handleKeyDown } = useRovingButtons(
      drawn.length + overflow + ghost,
      onExit,
      ref
    );
    const keyAt = useCallback(
      (index: number) => (event: KeyboardEvent<HTMLElement>) => handleKeyDown(event, index),
      [handleKeyDown]
    );

    if (reactions.length === 0 && !lingering) return null;

    return (
      <div
        data-testid="entry-reactions"
        className="mt-1 flex flex-wrap items-center gap-1"
        // A row of buttons, named so a screen reader reaching it knows what the
        // group under the message is before stepping into it.
        role="group"
        aria-label="Reactions"
      >
        <AnimatePresence initial={false} onExitComplete={() => setLingering(false)}>
          {/* eslint-disable-next-line react-hooks/refs -- `previous` is a
              committed-value read; see the note where it is declared. */}
          {drawn.map((reaction, index) => (
            <ReactionPill
              key={reaction.emoji}
              reaction={reaction}
              mine={hasReacted(reaction, viewerAuthorId)}
              summary={reactionSummary(reaction, viewerAuthorId, names)}
              arrived={previous !== null && !previous.has(reaction.emoji)}
              rolled={
                previous?.get(reaction.emoji) !== undefined &&
                previous.get(reaction.emoji) !== reaction.authorIds.length
              }
              onToggle={() => onToggle(reaction.emoji)}
              disabled={disabled}
              buttonRef={register(index)}
              onKeyDown={keyAt(index)}
            />
          ))}
        </AnimatePresence>

        {overflow === 1 && (
          // A count with somewhere to go. A bare "+3 more" would name reactions
          // the reader has no way to see — the shape the thread reply row refuses
          // for the same reason.
          <button
            ref={register(drawn.length)}
            type="button"
            tabIndex={-1}
            onKeyDown={keyAt(drawn.length)}
            onClick={() => setExpanded(true)}
            data-testid="entry-reactions-more"
            className={cn(
              'focus-ring text-muted-foreground hover:text-foreground relative rounded-full px-2 py-0.5 text-xs',
              // The same reach the pills beside it get, for the same reason.
              "after:absolute after:inset-x-0 after:-inset-y-3 after:content-[''] md:after:hidden"
            )}
          >
            +{hidden} more
          </button>
        )}

        {/* The ghost + (behaviour 4): react again without summoning the capsule.
            Faint, because it is an affordance and not a reaction. Gone the moment
            the last pill starts to leave, so the row that lingers for that fade
            holds the fade and nothing else. */}
        {reactions.length > 0 && (
          <EntryReactionPicker
            appearance="ghost-pill"
            mine={mine}
            frequents={frequents}
            disabled={disabled}
            onPick={onToggle}
            triggerRef={register(drawn.length + overflow)}
            onTriggerKeyDown={keyAt(drawn.length + overflow)}
          />
        )}
      </div>
    );
  }
);
