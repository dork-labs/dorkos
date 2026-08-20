/**
 * The moment something starts waiting on you — and the moment it stops.
 *
 * The one place in the cockpit that turns "these three things are waiting" into
 * "this one just ARRIVED". Everything that interrupts a person hangs off that
 * distinction: a knock and an OS banner are honest about an arrival and
 * dishonest about a list, so a hook that reported the list would make every
 * refetch sound like a new question.
 *
 * @module features/notifications/model/use-blocking-arrivals
 */
import { useEffect, useRef } from 'react';
import {
  useAttentionSignals,
  useAttentionSignalsLoading,
  usePendingScheduleApprovals,
  type AttentionSignal,
} from '@/layers/entities/attention';

/**
 * One thing waiting on the operator, in the shape an interruption needs.
 *
 * **Nothing here is derived from a tool's input.** `summary` is one of a fixed
 * set of sentences chosen by kind, not `describeInteraction`'s phrasing — that
 * one is excellent in the cockpit and says things like "wants to run 'rm -rf
 * build'", which is transcript content and must never reach an OS notification
 * (spec `notification-system`, Security Considerations). The cockpit's own cards
 * keep saying it; the banner says who and how urgent.
 */
export interface BlockingItem {
  /** Stable across polls — this is what "already seen" is keyed by. */
  id: string;
  /** Who needs you. */
  who: string;
  /** What kind of waiting this is, in fixed words. Never tool input. */
  summary: string;
  /** Where clicking it goes, as a path. */
  deepLink: string;
}

/** Which attention kinds count as "blocked on a person". */
const BLOCKING_KINDS: ReadonlySet<AttentionSignal['kind']> = new Set([
  'permission-prompt',
  'question',
]);

/**
 * The fixed sentence for each blocking kind.
 *
 * A lookup rather than a function so it is obvious at a glance that no branch
 * can reach for the interaction's own words.
 */
const BLOCKING_SUMMARIES: Record<'permission-prompt' | 'question' | 'schedule', string> = {
  'permission-prompt': 'Waiting for your OK before it goes on.',
  question: 'Has a question for you.',
  schedule: 'Wants to run something on a timer.',
};

/** What a caller is told about arrivals and departures. */
export interface BlockingArrivalHandlers {
  /** Called once per newly-arrived item, never on the first settled read. */
  onArrive?: (items: readonly BlockingItem[]) => void;
  /** Called with the ids of items that are no longer waiting. */
  onDepart?: (ids: readonly string[]) => void;
}

/**
 * Watch the blocking queue and report only its TRANSITIONS.
 *
 * ## What "never on mount" means here
 *
 * The first settled read seeds the known set silently. That is the whole
 * difference between a knock and a nuisance: opening the cockpit with two agents
 * already parked must be quiet, because nothing has just happened — the person is
 * arriving at the queue, not the queue arriving at them. Re-opening a tab, a
 * refetch, and a re-render are all the same non-event.
 *
 * Loading is waited out rather than treated as empty. An empty list mid-load is
 * not "nothing is waiting"; treating it as one would seed an empty known set and
 * then announce every existing item as new the moment the query answered.
 *
 * An item that leaves and comes back IS a new arrival, and is announced again.
 * That is right: an agent that asked, was answered, and asked again has asked
 * twice.
 *
 * @param handlers - What to do on arrival and departure. Read through a ref, so
 * a caller may pass fresh closures without restarting the watch.
 */
export function useBlockingArrivals(handlers: BlockingArrivalHandlers): void {
  const signals = useAttentionSignals();
  const signalsLoading = useAttentionSignalsLoading();
  const { schedules, isLoading: schedulesLoading } = usePendingScheduleApprovals();

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const knownRef = useRef<Set<string> | null>(null);

  const loading = signalsLoading || schedulesLoading;

  useEffect(() => {
    if (loading) return;

    const current = new Map<string, BlockingItem>();
    for (const signal of signals) {
      if (!BLOCKING_KINDS.has(signal.kind)) continue;
      current.set(signal.id, {
        id: signal.id,
        who: signal.primary,
        summary: BLOCKING_SUMMARIES[signal.kind as 'permission-prompt' | 'question'],
        deepLink: signal.deepLink,
      });
    }
    for (const task of schedules) {
      const id = `schedule:${task.id}`;
      current.set(id, {
        id,
        who: task.displayName ?? task.name,
        summary: BLOCKING_SUMMARIES.schedule,
        deepLink: '/tasks',
      });
    }

    const known = knownRef.current;
    knownRef.current = new Set(current.keys());

    // The first settled read is the seed, and it says nothing. See the docs
    // above for why this is the whole point of the hook.
    if (known === null) return;

    const arrived = [...current.values()].filter((item) => !known.has(item.id));
    const departed = [...known].filter((id) => !current.has(id));

    if (arrived.length > 0) handlersRef.current.onArrive?.(arrived);
    if (departed.length > 0) handlersRef.current.onDepart?.(departed);
  }, [loading, signals, schedules]);
}
