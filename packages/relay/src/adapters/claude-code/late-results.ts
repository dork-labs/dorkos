/**
 * The turns an agent starts on its own after a relay turn ended, published to
 * the inbox of the message that started that turn (DOR-2717).
 *
 * @module relay/adapters/claude-code/late-results
 */
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { RelayPublisher } from '../../types.js';
import { describeError } from '../../lib/describe-error.js';
import type { AgentHandlerDeps } from './agent-handler.js';
import { publishAgentResult } from './publish.js';
import type { LateFollowEnd, LateTurnSource } from './types.js';

/** The inbox `relay_send_and_wait` reads, which it takes down once answered. */
export const QUERY_INBOX_PREFIX = 'relay.inbox.query.';

/**
 * Publish each turn the agent starts on its own, after this message's turn
 * ended, to the same inbox as a result marked `late` (DOR-2717).
 *
 * Registered in `lateFollowers` under the conversation's stable scope — not the
 * session key, which a first turn renames — so the next message to that
 * conversation ends it. The host also ends it: after a turn the agent finishes
 * holding no more work (`final`), when its window passes, or when anyone gives
 * the session new work. Every ending but `final` publishes one closing result
 * marked `ended` — never `error`, which keeps meaning "the turn failed" — so a
 * caller told `continuing` is never left polling for something that will not
 * come. Publishes are chained, so the inbox reads them in the order they
 * happened.
 *
 * @param deps - The handler's dependencies, for the follower map and runtime type
 * @param lateTurns - Where the later turns come from
 * @param envelope - The message whose inbox hears the later turns
 * @param follow - The session the turn ran under, the conversation's scope, and
 *   the dispatch mark read when the turn ended
 * @param relay - The publisher
 * @param log - Where a failed publish is reported
 */
export function followLateResults(
  deps: AgentHandlerDeps,
  lateTurns: LateTurnSource,
  envelope: RelayEnvelope,
  follow: { sessionKey: string; scope: string; sinceMark: number | undefined },
  relay: RelayPublisher,
  log: Pick<Console, 'warn'>
): void {
  const { sessionKey, scope, sinceMark } = follow;
  const followers = deps.lateFollowers;
  let published: Promise<void> = Promise.resolve();
  const publishInOrder = (
    text: string,
    error: string | undefined,
    marks: { continuing?: boolean; ended?: Exclude<LateFollowEnd, 'final'> }
  ): void => {
    published = published
      .then(() =>
        publishAgentResult(envelope, text, sessionKey, relay, error, { late: true, ...marks })
      )
      .catch((err: unknown) => {
        log.warn(`[CCA] could not publish a late result for ${sessionKey}:`, describeError(err));
      });
  };
  // Assigned once `follow` has returned. `onEnd` CAN run inside `follow` — a
  // stale mark ends the follow at once — which is what `ended` records.
  let stopFollowing: () => void = () => {};
  let ended = false;
  const unfollow = lateTurns.follow({
    runtimeType: deps.runtimeType ?? deps.agentManager.type ?? 'claude-code',
    sessionKey,
    ...(sinceMark !== undefined ? { sinceMark } : {}),
    onTurn: (turn) => publishInOrder(turn.text, turn.error, { continuing: turn.continuing }),
    onEnd: (reason) => {
      ended = true;
      if (followers?.get(scope) === stopFollowing) followers.delete(scope);
      if (reason !== 'final') publishInOrder('', undefined, { ended: reason });
    },
  });
  stopFollowing = unfollow;
  // A follow the host ended inside `follow` itself (work already reached the
  // session) is over; registering it would leave a dead entry behind.
  if (!ended) followers?.set(scope, stopFollowing);
}
