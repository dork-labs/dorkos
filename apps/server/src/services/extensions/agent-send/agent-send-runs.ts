/**
 * What a mini app's message hears from its run (spec `turns-survive-restarts`
 * §3.1 `watch`, DOR-5232): the run record's status changes, read as the
 * delivery events `ctx.agent.subscribe` promises (`turn.started`, then
 * `turn.done` or `turn.failed`) and the wait a receipt names.
 *
 * A message's words stay in its own row until its turn starts, named on its
 * run by `sourceRef` (`extension-send:<message id>`), so a restart in between
 * loses nothing: the next boot hands the run over again, reading the words
 * back from the row. That reference is also how a run is told back to its
 * message.
 *
 * @module services/extensions/agent-send/agent-send-runs
 */
import type { AgentDeliveryFailureReason, AgentSendWaitReason } from '@dorkos/extension-api/server';
import { RunIdSchema } from '@dorkos/shared/turn-port';
import type { SpaceTurnPort, TurnRun } from '../../runs/index.js';
import type { AgentSendRecord } from './agent-send-store.js';

/** The source kind a mini app's message keeps its words under. */
export const SEND_SOURCE = 'extension-send';

/**
 * The `sourceRef` of one message's run.
 *
 * @param messageId - The message (`extension_agent_sends.id`).
 */
export function sendSourceRef(messageId: string): string {
  return `${SEND_SOURCE}:${messageId}`;
}

/**
 * The message a run carries, or `undefined` for any other caller's run.
 *
 * @param run - The run.
 */
export function messageOfRun(run: Pick<TurnRun, 'sourceRef'>): string | undefined {
  const prefix = `${SEND_SOURCE}:`;
  return run.sourceRef?.startsWith(prefix) ? run.sourceRef.slice(prefix.length) : undefined;
}

/** What one change of a message's run means for it. */
export type SendStep =
  /** The turn started: the ack. */
  | { kind: 'started' }
  /** Waiting, for this reason when a receipt can name it. */
  | { kind: 'waiting'; reason: AgentSendWaitReason | null }
  /** The turn ended as the runtime reported it. */
  | { kind: 'done'; outcome: 'ok' | 'error' }
  /** It will never run, or its process died with it. */
  | { kind: 'failed'; reason: AgentDeliveryFailureReason }
  /** Nothing to tell (a launch beginning). */
  | { kind: 'none' };

/**
 * Why a message whose run was cancelled before it started will never run. A
 * person's removal and a gone chat say so; the words lost to a restart, or a
 * start that kept failing, read as `interrupted`; a refusal at the door (the
 * chat moved to a room, the account, the agent's folder) as `undeliverable`.
 */
function cancelledReason(run: TurnRun): AgentDeliveryFailureReason {
  switch (run.endingDetail.cancelledBecause) {
    case 'removed':
      return 'removed';
    case 'session_gone':
      return 'session_gone';
    case 'start_lost':
    case 'start_failed':
      return 'interrupted';
    default:
      return 'undeliverable';
  }
}

/**
 * What a run's status now means for its message.
 *
 * @param run - The run, as it reads after the change.
 */
export function stepOf(run: TurnRun): SendStep {
  switch (run.status) {
    case 'queued':
      return {
        kind: 'waiting',
        reason:
          run.waitReason === 'chat_busy'
            ? 'busy'
            : run.waitReason === 'machine_full'
              ? 'at_capacity'
              : null,
      };
    case 'starting':
      return { kind: 'none' };
    case 'started':
    case 'running':
      return { kind: 'started' };
    case 'ended':
    case 'settled':
      // Its process ended with it, or DorkOS shut down under it: nobody can
      // say how far it got.
      return run.ending === 'process_died' || run.ending === 'shutdown'
        ? { kind: 'failed', reason: 'interrupted' }
        : { kind: 'done', outcome: run.ending === 'completed' ? 'ok' : 'error' };
    case 'cancelled':
      return { kind: 'failed', reason: cancelledReason(run) };
    case 'superseded':
      // Its words joined another turn, which ran them.
      return { kind: 'done', outcome: 'ok' };
  }
}

/**
 * A message's run. Named by the message's own id since runs were (so a chat
 * the runtime moved to another id, which a restart no longer knows as an
 * alias, still finds it); a message an earlier version saved under a UUID is
 * looked for by its source in the chat it was sent to, else, when that
 * version queued it in the chat itself, as the run adoption gave its queue
 * row (no source, the row's id), whether or not the row is still there.
 *
 * @param port - The space face.
 * @param row - The message.
 */
export function runOfRow(
  port: Pick<SpaceTurnPort, 'get' | 'list' | 'runOfQueueRow'>,
  row: Pick<AgentSendRecord, 'id' | 'sessionId'>
): TurnRun | undefined {
  const own = RunIdSchema.safeParse(row.id).success ? port.get(row.id) : undefined;
  if (own) return own;
  const ref = sendSourceRef(row.id);
  const sent = row.sessionId
    ? port.list(row.sessionId).find((each) => each.sourceRef === ref)
    : undefined;
  return sent ?? port.runOfQueueRow(row.id);
}

/**
 * Why a message waits, when there is a reason: a turn holds the chat, or
 * admission held the run for room. A message only not handed over yet has none.
 *
 * @param port - The space face.
 * @param sessionId - The chat.
 * @param runId - The message's run.
 */
export function waitOf(
  port: Pick<SpaceTurnPort, 'get' | 'list'>,
  sessionId: string,
  runId: string
): AgentSendWaitReason | null {
  const busy = port
    .list(sessionId)
    .some((run) => run.id !== runId && ['starting', 'started', 'running'].includes(run.status));
  const run = port.get(runId);
  const held = run ? stepOf(run) : undefined;
  return busy ? 'busy' : held?.kind === 'waiting' ? held.reason : null;
}
