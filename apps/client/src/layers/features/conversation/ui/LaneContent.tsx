/**
 * What the live lane draws for one state, and what it says out loud.
 *
 * Split from {@link LiveLane} the way `StripContent` was split from
 * `ChatStatusStrip`: the container owns the reserved height, the one live region
 * and the crossfade, and this owns the ten renderings. Keeping them apart is
 * what makes "the lane never changes height" a property of one small file.
 *
 * **Everything that ticks is `aria-hidden`.** The lane announces a sentence, and
 * a live region that re-reads "2m 15s" every second is worse than silence
 * (`contributing/design-system.md` §Zones, "One live region, counts only").
 *
 * @module features/conversation/ui/LaneContent
 */
import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Info, MessageSquare, Shield } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { STATUS_DOT_COLOR, STATUS_DOT_PULSE } from '@/layers/shared/ui';
import { laneElapsed, LANE_TIMER_FLOOR_MS, type LaneState } from '../model/lane-state';

/**
 * How often the lane re-reads the clock while something is running.
 *
 * One second, and it costs one leaf: the elapsed reading lives in its own
 * component so the lane's container, the timeline above it and the composer
 * below it never re-render for a tick.
 */
const LANE_TICK_MS = 1_000;

/**
 * What the stalled line says, in the one place both the announcement and the
 * sentence on screen read it from.
 *
 * Moved here verbatim from `RoomStalledNotice`, which this rung replaces. Both
 * sentences are unchanged, including the promise the second one deliberately
 * does not make.
 *
 * @param unavailable - Whether the room itself is gone rather than unreachable.
 */
export function stalledSentence(unavailable: boolean): string {
  return unavailable
    ? 'This room is no longer available. It may have been deleted, or you may no longer have access to it.'
    : "New messages aren't coming through right now. You can still send — anything that doesn't get through will say so.";
}

/**
 * The same fact, short enough for a phone.
 *
 * The lane never wraps and never grows, so on a 375 px screen the full sentence
 * truncated at "New messages aren't coming thr…" — which drops the actionable
 * half ("you can still send") and left it reachable only by a `title`, which a
 * finger cannot open. A shorter TRUE sentence is better than a longer one a
 * reader cannot finish. The full one is still what the announcer carries, so
 * nothing is lost to a reader who cannot see the line at all.
 *
 * @param unavailable - Whether the room itself is gone rather than unreachable.
 */
export function shortStalledSentence(unavailable: boolean): string {
  return unavailable ? 'This room is no longer available' : 'Reconnecting — you can still send';
}

/**
 * The one sentence the lane's live region carries for a state, or `''` for a
 * state that must stay quiet.
 *
 * Two silences are deliberate. An **Ask** is announced by the approval announcer
 * that already outlives the card (`useApprovalAnnouncer`); two live regions on
 * one prompt is the siren the sidebar's contract forbids. A **finished turn** is
 * a summary on its way out, and reading two numbers at somebody is churn.
 *
 * @param state - What the lane is showing.
 * @param unavailable - Whether a stalled room is gone rather than unreachable.
 */
export function laneAnnouncement(state: LaneState, unavailable: boolean): string {
  switch (state.kind) {
    case 'ask':
      return '';
    case 'stalled':
      return stalledSentence(unavailable);
    case 'presence':
      return state.sentence;
    case 'turn-waiting':
      return state.waitingType === 'approval'
        ? 'Waiting for your approval'
        : 'Waiting for your answer';
    case 'turn-progress':
    case 'turn-system':
      return state.message;
    case 'turn-streaming':
      // Not the verb: it changes every couple of seconds while a turn works,
      // and a live region that re-read it would be the churn the elapsed clock
      // is hidden for.
      return 'Working';
    case 'turn-complete':
      return '';
    case 'queued':
      return queuedSentence(state.depth);
    case 'empty':
      return '';
  }
}

/**
 * The crossfade key: the state plus the label it is showing.
 *
 * `verbKey`'s existing trick, generalised — the lane animates on a real change
 * and stays still while a number ticks underneath it.
 *
 * @param state - What the lane is showing.
 */
export function laneMotionKey(state: LaneState): string {
  switch (state.kind) {
    case 'ask':
      return `ask:${state.ask.interactionId}`;
    case 'presence':
      return `presence:${state.sentence}`;
    case 'turn-waiting':
      return `turn-waiting:${state.waitingType}`;
    case 'turn-progress':
    case 'turn-system':
      return `${state.kind}:${state.message}`;
    case 'turn-streaming':
      return `turn-streaming:${state.verbKey}`;
    case 'queued':
      return `queued:${state.depth}`;
    default:
      return state.kind;
  }
}

/**
 * What the presence line is called on each surface.
 *
 * `room-presence` is the name the shipped browser suites resolve by, so the
 * room keeps it. A session has no presence rung at all — its capability table
 * turns it off — so its entry exists only to keep this map total by type.
 */
const PRESENCE_TESTID: Record<'room' | 'thread' | 'session', string> = {
  room: 'room-presence',
  thread: 'thread-presence',
  session: 'session-presence',
};

/** How many drafts are being held, in words. */
function queuedSentence(depth: number): string {
  return depth === 1 ? '1 queued' : `${depth} queued`;
}

/** What one lane rendering needs beyond its own state. */
export interface LaneContentProps {
  /** What the lane is showing. */
  state: LaneState;
  /** Ask the stream to try now, rather than waiting out its backoff. */
  onRetry?: () => void;
  /** True when the room itself is gone rather than merely unreachable. */
  unavailable?: boolean;
  /** Faces to stack in front of the presence sentence, already capped by the host. */
  faces?: ReactNode;
  /** True when the reader has asked for less motion. */
  reducedMotion?: boolean;
  /**
   * Which half of a room's presence this lane speaks for.
   *
   * It names the visible presence node as well as the announcer: with a thread
   * open on a wide screen there are two lanes on the page, and one testid over
   * both left "did the ROOM say it" unaskable.
   */
  scope?: 'room' | 'thread' | 'session';
}

/**
 * Draw the lane's current state.
 *
 * Returns `null` for `empty`: the lane's container is what holds the 24 px open,
 * so a quiet conversation draws nothing at all rather than a placeholder.
 *
 * @param props - The state and the two host affordances it may need.
 */
export function LaneContent({
  state,
  onRetry,
  unavailable = false,
  faces,
  reducedMotion = false,
  scope = 'room',
}: LaneContentProps): ReactNode {
  switch (state.kind) {
    case 'ask':
      return <AskLine state={state} reducedMotion={reducedMotion} />;
    case 'stalled':
      return <StalledLine onRetry={onRetry} unavailable={unavailable} />;
    case 'presence':
      return (
        <PresenceLine state={state} faces={faces} reducedMotion={reducedMotion} scope={scope} />
      );
    case 'turn-waiting':
      return <WaitingLine state={state} />;
    case 'turn-progress':
      return <ProgressLine state={state} reducedMotion={reducedMotion} />;
    case 'turn-system':
      return <SystemLine state={state} />;
    case 'turn-streaming':
      return <StreamingLine state={state} reducedMotion={reducedMotion} />;
    case 'turn-complete':
      return <CompleteLine state={state} />;
    case 'queued':
      return <QueuedLine state={state} />;
    case 'empty':
      return null;
  }
}

/**
 * A prompt somebody can answer.
 *
 * Amber, and never amber ALONE: the word "Answer" carries the same fact for a
 * reader who cannot tell the dot from the working one. The card the lane grows
 * into is P3's (DOR-1330, task 3.8); this line is the collapsed state it grows
 * from.
 *
 * @internal
 */
function AskLine({
  state,
  reducedMotion,
}: {
  state: Extract<LaneState, { kind: 'ask' }>;
  reducedMotion: boolean;
}) {
  return (
    <span data-testid="lane-ask" className="flex min-w-0 items-center gap-2">
      <LaneDot signal="needs-you" reducedMotion={reducedMotion} />
      <span className="text-foreground truncate">{state.ask.headline}</span>
      {state.count > 1 && (
        <span aria-hidden="true" className="text-muted-foreground shrink-0 tabular-nums">
          +{state.count - 1}
        </span>
      )}
      <span className="text-status-warning-fg shrink-0 font-medium">Answer</span>
    </span>
  );
}

/**
 * A stream this client cannot read.
 *
 * The composer beside it stays open, which was `RoomStalledNotice`'s decision
 * and is kept: you can still post, and what you post says so for itself if it
 * does not land. The button stays for the same reason it did — by the time
 * anybody reads this the backoff is at its thirty-second cap, and waiting is the
 * one thing a person in this state does not want to do.
 *
 * @internal
 */
function StalledLine({ onRetry, unavailable }: { onRetry?: () => void; unavailable: boolean }) {
  const sentence = stalledSentence(unavailable);
  return (
    <span
      // The name the shipped browser suites already reach for
      // (`RoomsPage.stalledNotice`). It says which rung this is, not which
      // surface drew it.
      data-testid="room-stalled"
      data-unavailable={unavailable ? 'true' : undefined}
      className="flex min-w-0 items-center gap-2"
    >
      <LaneDot signal="error" reducedMotion />
      {/* Two spellings of one fact, one per width. The lane never wraps and
          never grows, so on a phone the full sentence loses its actionable half
          to an ellipsis — see `shortStalledSentence`. Both are `aria-hidden`
          because the lane's live region already carries the full one, and a
          screen reader that met both would hear the outage twice. */}
      <span aria-hidden="true" className="text-muted-foreground truncate sm:hidden">
        {shortStalledSentence(unavailable)}
      </span>
      <span
        aria-hidden="true"
        className="text-muted-foreground hidden truncate sm:inline"
        title={sentence}
      >
        {sentence}
      </span>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="focus-ring text-muted-foreground hover:text-foreground shrink-0 rounded underline underline-offset-2"
        >
          {unavailable ? 'Try again' : 'Reconnect'}
        </button>
      )}
    </span>
  );
}

/**
 * Who is working here, and for how long.
 *
 * The sentence is `presence-copy.ts`'s, word for word. The elapsed reading is
 * beside it rather than in it, because the sentence is what the live region
 * carries and the number is what ticks.
 *
 * @internal
 */
function PresenceLine({
  state,
  faces,
  reducedMotion,
  scope,
}: {
  state: Extract<LaneState, { kind: 'presence' }>;
  faces: ReactNode;
  reducedMotion: boolean;
  scope: 'room' | 'thread' | 'session';
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <LaneDot signal="working" reducedMotion={reducedMotion} />
      {faces}
      {/* The testid covers the WORDS and nothing else, which is not cosmetic:
          a letter avatar contributes its letter to `textContent`, and the
          shipped presence suite reads this node as one exact sentence. Faces
          inside it would have made every assertion read "KKai is working…". */}
      <span
        // Kept from `RoomPresenceLine`, which this replaces: the shipped
        // presence suites resolve the line by this name.
        data-testid={PRESENCE_TESTID[scope]}
        data-late={state.late ? 'true' : undefined}
        className="text-muted-foreground flex min-w-0 items-center"
      >
        <span className="truncate">{state.sentence}</span>
        <LaneElapsed since={state.since} />
      </span>
    </span>
  );
}

/**
 * This turn has stopped and needs you, with no prompt object in hand.
 *
 * Distinct from the `ask` rung above on purpose — see `deriveLaneState`.
 *
 * @internal
 */
function WaitingLine({ state }: { state: Extract<LaneState, { kind: 'turn-waiting' }> }) {
  const WaitIcon = state.waitingType === 'approval' ? Shield : MessageSquare;
  return (
    <span data-testid="lane-waiting" className="flex min-w-0 items-center gap-2">
      <WaitIcon aria-hidden="true" className="text-status-warning-fg size-3 shrink-0" />
      <span className="text-status-warning-fg truncate">
        {state.waitingType === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer'}
      </span>
      <span aria-hidden="true" className="text-muted-foreground/70 shrink-0 tabular-nums">
        {state.elapsed}
      </span>
    </span>
  );
}

/**
 * A long operation such as compaction.
 *
 * The progress track rides INSIDE the 24 px line rather than under it: a second
 * row would be the height change the lane exists to make impossible.
 *
 * @internal
 */
function ProgressLine({
  state,
  reducedMotion,
}: {
  state: Extract<LaneState, { kind: 'turn-progress' }>;
  reducedMotion: boolean;
}) {
  return (
    <span
      data-testid="lane-progress"
      data-determinate={state.determinate}
      className="flex min-w-0 flex-1 items-center gap-2"
    >
      <span className="text-muted-foreground truncate">{state.message}</span>
      <span
        aria-hidden="true"
        className="bg-muted/60 relative h-0.5 w-16 shrink-0 overflow-hidden rounded-full"
      >
        {state.determinate ? (
          <motion.span
            className="bg-muted-foreground/50 absolute inset-y-0 left-0 block rounded-full"
            initial={false}
            animate={{ width: `${state.percent ?? 0}%` }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.3, ease: 'easeOut' }}
          />
        ) : (
          // Indeterminate: a short segment sweeps the track — parity with the
          // runtime's own bar when no completion fraction exists. Under reduced
          // motion the segment simply sits still at the start of the track,
          // which still reads as "something is running".
          <motion.span
            className="bg-muted-foreground/50 absolute inset-y-0 block w-1/3 rounded-full"
            animate={reducedMotion ? undefined : { x: ['-100%', '400%'] }}
            transition={{ duration: 1.4, ease: 'easeInOut', repeat: Infinity }}
          />
        )}
      </span>
    </span>
  );
}

/**
 * An informational runtime event — a hook that just ran, and its kind.
 *
 * @internal
 */
function SystemLine({ state }: { state: Extract<LaneState, { kind: 'turn-system' }> }) {
  return (
    <span data-testid="lane-system" className="flex min-w-0 items-center gap-2">
      <Info aria-hidden="true" className="text-muted-foreground/60 size-3 shrink-0" />
      <span className="text-muted-foreground/70 truncate">{state.message}</span>
    </span>
  );
}

/**
 * A turn in flight: what it is doing, how long it has been, and what it has
 * spent.
 *
 * **The bypass warning is the one thing here that is not the ordinary dot.** A
 * session running with its permission stops off says so with the glyph the strip
 * used, in amber, for as long as the turn runs — it is a standing warning about
 * the session rather than a state of the turn, so it replaces the mark rather
 * than sitting beside it.
 *
 * @internal
 */
function StreamingLine({
  state,
  reducedMotion,
}: {
  state: Extract<LaneState, { kind: 'turn-streaming' }>;
  reducedMotion: boolean;
}) {
  return (
    <span
      data-testid="lane-streaming"
      data-bypass={state.isBypass ? 'true' : undefined}
      className="flex min-w-0 items-center gap-2"
    >
      {state.isBypass ? (
        <span aria-hidden="true" className="shrink-0 font-bold text-amber-500/70">
          ☠
        </span>
      ) : (
        <LaneDot signal="working" reducedMotion={reducedMotion} />
      )}
      <span
        aria-hidden="true"
        className={cn('truncate', state.isBypass ? 'text-amber-500/80' : 'text-muted-foreground')}
      >
        {state.verb}
      </span>
      <span aria-hidden="true" className="text-muted-foreground/70 shrink-0 tabular-nums">
        {state.elapsed}
      </span>
      <span aria-hidden="true" className="text-muted-foreground/60 shrink-0">
        {state.tokens}
      </span>
    </span>
  );
}

/**
 * The finished turn's summary, on its way out.
 *
 * @internal
 */
function CompleteLine({ state }: { state: Extract<LaneState, { kind: 'turn-complete' }> }) {
  return (
    <span
      data-testid="lane-complete"
      className="text-muted-foreground/50 flex min-w-0 items-center gap-2 opacity-60"
    >
      <span className="truncate">{state.elapsed}</span>
      <span aria-hidden="true">·</span>
      <span className="shrink-0">{state.tokens}</span>
    </span>
  );
}

/**
 * Drafts the composer is holding until this turn ends.
 *
 * @internal
 */
function QueuedLine({ state }: { state: Extract<LaneState, { kind: 'queued' }> }) {
  return (
    <span data-testid="lane-queued" className="text-muted-foreground flex min-w-0 items-center">
      <span className="truncate">{queuedSentence(state.depth)}</span>
    </span>
  );
}

/**
 * The lane's mark, from the one dot vocabulary.
 *
 * Only `working` breathes — motion is what the word "now" is made of, so a state
 * that pulsed would claim to still be running (`shared/ui/status-dot.ts`). It is
 * `aria-hidden` because every rung that draws one also says the same thing in
 * words beside it.
 *
 * @internal
 */
function LaneDot({
  signal,
  reducedMotion,
}: {
  signal: 'working' | 'needs-you' | 'error';
  reducedMotion: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      data-lane-dot={signal}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        STATUS_DOT_COLOR[signal],
        signal === 'working' && !reducedMotion && STATUS_DOT_PULSE
      )}
    />
  );
}

/**
 * How long the oldest claim has been running — the lane's only ticking leaf.
 *
 * It holds its own timer so nothing above it re-renders once a second, which is
 * the rule `PresenceStrip` already documents for its own rows. Nothing is drawn
 * for the first ten seconds (`LANE_TIMER_FLOOR_MS`): a number that starts at
 * `0s` draws the eye for nothing.
 *
 * @internal
 */
function LaneElapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  const due = Date.parse(since) + LANE_TIMER_FLOOR_MS;

  useEffect(() => {
    // Nothing is drawn for the first ten seconds, so nothing needs to tick for
    // them either: a claim that has just arrived sleeps until its number is due
    // and only then starts a per-second timer. A room with four agents in it was
    // otherwise running four intervals to render nothing.
    const wait = due - Date.now();
    if (wait > 0) {
      const wake = setTimeout(() => setNow(Date.now()), wait);
      return () => clearTimeout(wake);
    }
    const timer = setInterval(() => setNow(Date.now()), LANE_TICK_MS);
    return () => clearInterval(timer);
  }, [due, now]);

  const elapsed = laneElapsed(since, now);
  if (elapsed === null) return null;
  return (
    // The separator lives inside this node, spaces and all. Two adjacent
    // elements contribute no whitespace of their own to `textContent`, and the
    // shipped presence suite reads the line as one sentence.
    <span aria-hidden="true" className="text-muted-foreground/70 shrink-0 tabular-nums">
      {` · ${elapsed}`}
    </span>
  );
}
