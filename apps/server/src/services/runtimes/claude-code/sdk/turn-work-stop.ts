/**
 * A Stop ends the work its turn started (DOR-3285).
 *
 * Measured on Claude Code 2.1.304 (SDK 0.3.304) with open input, the way a warm
 * process runs: `query.interrupt()` ends a FOREGROUND shell, but a shell already
 * in the background runs on to the end and then wakes the agent. A shell gets
 * there two ways: started with `run_in_background`, or moved there by the CLI
 * when a foreground call passes its 120 s timeout. On 2026-10-26 the second way
 * let a stopped turn file two tickets. `query.stopTask(taskId)` after the
 * interrupt does end it, so the stop path calls this with the task ids the
 * turn's own tool calls started (`AgentSession.turnTaskIds`). Ids, never names:
 * no other work on this machine can be caught by it.
 *
 * @module services/runtimes/claude-code/sdk/turn-work-stop
 */
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession } from '../agent-types.js';
import { logger } from '../../../../lib/logger.js';
import { awaitControlAck, STOP_ACK_TIMEOUT_MS } from '../sessions/bounded-control.js';

/** Said in the chat when a Stop could not end work its turn started. */
export const STILL_RUNNING_NOTICE =
  'Stopped, but a command it started is still running. Use its Stop button.';

/**
 * Stop each background task the stopped turn started, one at a time, each
 * inside the same bound a Stop has. A task the CLI will not stop stays in the
 * turn's set, and the chat says plainly that it is still running; its row in
 * the running-work list keeps its own Stop button.
 *
 * @param sessionId - The session, for the log
 * @param session - The live session holding this turn's task ids
 * @param query - The query the Stop was aimed at, still alive after an acked interrupt
 */
export async function endTurnTasks(
  sessionId: string,
  session: AgentSession,
  query: Query
): Promise<void> {
  const running: string[] = [];
  for (const taskId of [...(session.turnTaskIds ?? [])]) {
    const ack = await awaitControlAck(() => query.stopTask(taskId), STOP_ACK_TIMEOUT_MS);
    if (ack === 'acked') session.turnTaskIds?.delete(taskId);
    else running.push(taskId);
  }
  if (running.length === 0) return;
  logger.warn('[interruptQuery] a stopped turn left work running', { sessionId, running });
  session.eventQueue.push({ type: 'system_status', data: { message: STILL_RUNNING_NOTICE } });
  session.eventQueueNotify?.();
}
