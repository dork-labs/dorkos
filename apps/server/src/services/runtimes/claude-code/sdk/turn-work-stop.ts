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
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { RawSessionEvent } from '../../../session/session-state-projector.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import { logger } from '../../../../lib/logger.js';
import { awaitControlAck, STOP_ACK_TIMEOUT_MS } from '../sessions/bounded-control.js';

/** How many recent `Bash` commands a session keeps for the tasks they start. */
const MAX_REMEMBERED_COMMANDS = 64;

/** The `seq`-less `work_left_running` event a stop records. */
type WorkLeftRunning = Omit<Extract<SessionEvent, { type: 'work_left_running' }>, 'seq'>;

/** Where a stopped turn's `work_left_running` goes: the session's durable stream. */
export type WorkLeftEmit = (sessionId: string, event: RawSessionEvent) => void;

/**
 * Ingest straight into the session's projector, never onto the turn's event
 * queue: this runs after the turn's stream has closed, and the next turn
 * clears the queue (#3200 security review). A session nobody is watching has
 * no projector, which is a quiet no-op.
 */
const ingestIntoProjector: WorkLeftEmit = (sessionId, event) => {
  peekProjector(sessionId)?.ingest(event);
};

/**
 * Remember a `Bash` tool call's command, so the background task it starts can
 * name it (the CLI's `task_started` names the tool call, not the command).
 *
 * @param session - The live session
 * @param block - One `tool_use` content block from an assistant message
 */
export function rememberToolCommand(session: AgentSession, block: Record<string, unknown>): void {
  if (block.type !== 'tool_use' || block.name !== 'Bash' || typeof block.id !== 'string') return;
  const command = (block.input as { command?: unknown } | undefined)?.command;
  if (typeof command !== 'string') return;
  const commands = (session.toolCommandsById ??= new Map<string, string>());
  commands.set(block.id, command);
  // Bounded: a foreground call that never becomes a task is never consumed.
  if (commands.size > MAX_REMEMBERED_COMMANDS) commands.delete(commands.keys().next().value!);
}

/**
 * Take the remembered command of the tool call that started a task.
 *
 * @param session - The live session
 * @param toolUseId - The task's `tool_use_id`, when the CLI gave one
 * @returns The command, or `''` when it is not known
 */
export function takeToolCommand(session: AgentSession, toolUseId: unknown): string {
  if (typeof toolUseId !== 'string') return '';
  const command = session.toolCommandsById?.get(toolUseId) ?? '';
  session.toolCommandsById?.delete(toolUseId);
  return command;
}

/**
 * Stop every background task the stopped turn started, all at once, inside
 * the one bound a Stop has. A task the CLI will not stop stays in the turn's
 * set and is remembered as left running, and one `work_left_running` event
 * names them all, so the chat keeps a lasting line with a Stop for each.
 *
 * @param sessionId - The session, for the log and the event
 * @param session - The live session holding this turn's task ids
 * @param query - The query the Stop was aimed at, still alive after an acked interrupt
 * @param emit - Where the event goes; the session's projector unless a test says otherwise
 */
export async function endTurnTasks(
  sessionId: string,
  session: AgentSession,
  query: Query,
  emit: WorkLeftEmit = ingestIntoProjector
): Promise<void> {
  // All at once, so the whole stop shares ONE deadline: a turn that started
  // many shells must not make Stop, a room halt or a pause wait for each in
  // turn (#3200 review, M1). `awaitControlAck` never rejects.
  const tasks = [...(session.turnTaskIds ?? new Map<string, string>())];
  const acks = await Promise.all(
    tasks.map(([taskId]) => awaitControlAck(() => query.stopTask(taskId), STOP_ACK_TIMEOUT_MS))
  );
  const running: WorkLeftRunning['tasks'] = [];
  tasks.forEach(([taskId, command], i) => {
    if (acks[i] === 'acked') session.turnTaskIds?.delete(taskId);
    else running.push({ taskId, command });
  });
  if (running.length === 0) return;
  const runningIds = running.map((task) => task.taskId);
  logger.warn('[interruptQuery] a stopped turn left work running', { sessionId, runningIds });
  session.leftRunningTasks ??= new Map<string, string>();
  for (const task of running) session.leftRunningTasks.set(task.taskId, task.command);
  const event: WorkLeftRunning = { type: 'work_left_running', tasks: running };
  emit(sessionId, event);
}
