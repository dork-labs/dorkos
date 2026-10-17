/**
 * A turn the runtime refused before the message reached the agent (DOR-2994).
 *
 * A runtime that cannot take a turn (too many warm sessions, a pending
 * question, a crash loop, the wrong account) answers with an `error` and a
 * `done` rather than a throw, so the chat settles instead of hanging. Without a
 * mark, that turn read as one that ran: a chat message it carried was reported
 * delivered while its words never reached the agent. The code says "nothing
 * ran", and the turn settles `failed` with the error's words as the reason.
 *
 * @module services/session/launch/turn-not-started
 */
import type { StreamEvent } from '@dorkos/shared/types';

/** The `error` code a runtime puts on a turn it refused before the agent saw it. */
export const TURN_NOT_STARTED_CODE = 'turn_not_started';

/**
 * Why a turn never started, carried in the error's `reason`. The error's
 * message is written for the person in the refusing chat; a chat that sent the
 * message needs different words, chosen from this.
 */
export type TurnRefusal = 'warm-ceiling' | 'pending-interaction' | 'crash-loop' | 'account-pin';

/**
 * The terminal pair for a turn refused before any output: an `error` carrying
 * {@link TURN_NOT_STARTED_CODE}, then `done`, so the projector settles rather
 * than pinning `streaming` on a turn that never ran.
 *
 * @param sessionId - The session whose turn was refused.
 * @param refusal - Why, for anyone but the person in this chat.
 * @param message - What the person in this chat reads.
 * @param details - The raw cause, for logs and the error's detail line.
 */
export function* turnNotStarted(
  sessionId: string,
  refusal: TurnRefusal,
  message: string,
  details?: string
): Generator<StreamEvent> {
  yield {
    type: 'error',
    data: {
      message,
      code: TURN_NOT_STARTED_CODE,
      reason: refusal,
      category: 'execution_error',
      ...(details !== undefined ? { details } : {}),
    },
  };
  yield { type: 'done', data: { sessionId } };
}

/**
 * Why the turn never reached the agent when `event` says so, else `undefined`.
 *
 * @param event - One event from a turn's stream.
 */
export function notStartedReason(event: StreamEvent): TurnRefusal | undefined {
  if (event.type !== 'error') return undefined;
  const data = event.data as { code?: unknown; reason?: unknown };
  return data.code === TURN_NOT_STARTED_CODE && typeof data.reason === 'string'
    ? (data.reason as TurnRefusal)
    : undefined;
}

/** How a turn settles: its outcome and, for a refused turn, why. */
export type SettledAs = ['ok' | 'failed'] | ['failed', TurnRefusal];

/** A turn's stream, watched for a refusal; see {@link watchNotStarted}. */
export interface WatchedTurn {
  /** The same events, in order. */
  stream: AsyncIterable<StreamEvent>;
  /** Set when the turn threw: it settles `failed` too. */
  threw: boolean;
  /** How the turn settles, as `onSettled`'s arguments. */
  settledAs: () => SettledAs;
}

/**
 * Watch a turn's stream for a refusal, and say how the turn settles: `failed`
 * when it threw or the runtime refused it before the agent saw the message.
 *
 * @param source - The runtime's per-turn stream.
 */
export function watchNotStarted(source: AsyncIterable<StreamEvent>): WatchedTurn {
  let reason: TurnRefusal | undefined;
  async function* stream(): AsyncIterable<StreamEvent> {
    for await (const event of source) {
      reason ??= notStartedReason(event);
      yield event;
    }
  }
  const watched: WatchedTurn = {
    stream: stream(),
    threw: false,
    settledAs: () =>
      reason !== undefined ? ['failed', reason] : [watched.threw ? 'failed' : 'ok'],
  };
  return watched;
}
