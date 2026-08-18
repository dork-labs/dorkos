/**
 * The tray body: every prompt waiting on a person, in one place.
 *
 * @module features/ask/ui/AskList
 */
import { useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import {
  agentNameFromCwd,
  describeInteraction,
  useSettlingAsks,
} from '@/layers/entities/attention';
import { useNow } from '@/layers/shared/model';
import { groupAsks } from '../lib/group-asks';
import { useAnswerAsk } from '../model/use-answer-ask';
import { AskStack } from './AskStack';
import { InteractionAsk } from './InteractionAsk';

/**
 * When this prompt runs out, in epoch ms.
 *
 * The budget rides on every kind now, so this is the same anchor the card's own
 * countdown uses. A DTO too old to carry one is measured from its remainder as
 * of NOW — `remainingMs` is the budget minus the time already spent, so adding
 * it to `startedAt` would land in the past for anything more than half way
 * through (the stale-deadline formula `InteractionAsk` retired). Only a
 * pre-deploy cached DTO ever reaches this branch, and for ordering an
 * as-of-now reading is exact enough.
 *
 * @param ask - The prompt to place.
 * @param now - The clock reading to measure a legacy remainder from.
 */
function askDeadline(ask: InteractionPendingEvent, now: number): number {
  const { startedAt, timeoutMs, remainingMs } = ask.interaction;
  return timeoutMs === undefined ? now + remainingMs : startedAt + timeoutMs;
}

/** Never show more cards at once than a person can actually work through. */
const MAX_CARDS = 6;

/** What {@link AskList} takes. */
export interface AskListProps {
  /** Every prompt waiting on a person. */
  asks: readonly InteractionPendingEvent[];
  /** Session id → what to call its agent, when the surface holds the roster. */
  agentNames?: Readonly<Record<string, string>>;
  /** Where "Open session" goes; absent hides the action. */
  onOpenSession?: (sessionId: string) => void;
  /** Rendered when nothing is waiting. Omit for a list that simply draws nothing. */
  emptyState?: React.ReactNode;
}

/**
 * The stack of Ask cards, shared by every surface that shows the tray.
 *
 * Sorted by time left, soonest first: the prompt about to auto-deny is the one
 * a person should answer, and a list ordered by arrival buries it. Bursts from
 * one agent collapse into one card ({@link groupAsks}).
 *
 * Long queues are capped rather than endless, but the cap is STATED: a hidden
 * seventh prompt is an agent parked with no way for anyone to know.
 */
export function AskList({ asks, agentNames, onOpenSession, emptyState }: AskListProps) {
  const { answerAll, isAnswering, error } = useAnswerAsk();
  // The answered ones are still drawn for a beat, saying how they ended. They
  // are NOT part of what is waiting — the count belongs to `asks` alone.
  const settling = useSettlingAsks();
  // One clock reading for the whole sort, so two legacy DTOs compare on the same
  // instant — and a hook rather than `Date.now()` in render, which the purity
  // rule refuses. A minute's granularity is plenty for an ordering.
  const now = useNow();
  const groups = useMemo(() => {
    // By DEADLINE, not by the remainder the list happened to be read at:
    // `remainingMs` is a snapshot taken at different instants for prompts that
    // arrived at different times, so sorting on it puts a nearly-expired ask
    // below a fresh one whose envelope is simply newer.
    const soonestFirst = [...asks].sort((a, b) => askDeadline(a, now) - askDeadline(b, now));
    const held = settling.filter(
      (ask) => !asks.some((waiting) => waiting.interaction.id === ask.interaction.id)
    );
    return groupAsks([...soonestFirst, ...held]);
  }, [asks, settling, now]);

  if (groups.length === 0) return <>{emptyState ?? null}</>;

  const hidden = Math.max(0, groups.length - MAX_CARDS);

  return (
    <motion.div data-slot="ask-list" className="flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {groups.slice(0, MAX_CARDS).map((group) =>
          group.kind === 'stack' ? (
            <AskStack
              key={group.key}
              cwd={group.asks[0].cwd}
              headline={`${
                agentNames?.[group.asks[0].sessionId] ?? agentNameFromCwd(group.asks[0].cwd)
              } wants to run ${group.asks.length} things`}
              items={group.asks.map((ask) => ({
                id: ask.interaction.id,
                line: describeInteraction(ask.interaction),
              }))}
              onAllowAll={() => void answerAll(group.asks, 'allow')}
              onDenyAll={() => void answerAll(group.asks, 'deny')}
              isAnswering={isAnswering}
              error={error}
            />
          ) : (
            <InteractionAsk
              key={group.key}
              ask={group.ask}
              {...(agentNames?.[group.ask.sessionId]
                ? { agentName: agentNames[group.ask.sessionId] }
                : {})}
              {...(onOpenSession ? { onOpenSession } : {})}
            />
          )
        )}
      </AnimatePresence>
      {hidden > 0 && (
        <p className="text-muted-foreground text-xs">
          {hidden === 1
            ? '1 more is waiting. Answer one of these to see it.'
            : `${hidden} more are waiting. Answer some of these to see them.`}
        </p>
      )}
    </motion.div>
  );
}
