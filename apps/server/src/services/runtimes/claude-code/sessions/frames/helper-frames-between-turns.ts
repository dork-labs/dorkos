/**
 * What the turn windower does with a background helper's frames while no turn
 * is open (DOR-2698).
 *
 * A helper the agent started with the Task tool keeps working after the
 * agent's reply ends. Its frames used to open an agent-started turn, which
 * showed the agent working on a turn it never started and held the session's
 * queue for the helper's whole run. They no longer start anything
 * (`./frame-kinds.ts`, `beginsATurn`), so the windower has to decide what to do
 * with them instead. **It leaves them out, and counts what it left out.**
 *
 * Why leave them out rather than hold them for the next turn:
 *
 * - **The report does not ride them.** When the helper finishes, the CLI emits
 *   a `system/task_notification` (no `parent_tool_use_id`, so it is HELD like
 *   any other between-turn line) and answers it in a segment of its own, on the
 *   main thread. That segment's first frame opens the turn the person sees, the
 *   held notification is flushed into it, and the agent's own words about the
 *   result follow. Nothing on that path is a helper frame.
 * - **Almost nothing in them would be shown anyway.** The mappers already drop
 *   a helper's `stream_event` partials and its `user` tool results; only its
 *   forwarded text becomes `subagent_text_delta`. Replaying a finished helper's
 *   text into the turn that reports on it would show stale work as live.
 * - **Holding them would crowd out what matters.** A long helper writes
 *   thousands of frames, and the hold keeps at most `MAX_UNATTRIBUTED_MESSAGES`
 *   by dropping its OLDEST, which would be the agent's own between-turn frames
 *   (a late tool result from the turn that just ended).
 * - **They are not lost from the session.** The CLI writes the helper's run to
 *   its own transcript on disk.
 *
 * The same pressure comes from the CLI's own progress line about a helper,
 * `system/task_progress`, written after each of the helper's tool calls. It is
 * not a helper frame (it carries no `parent_tool_use_id`) and it maps to the
 * task's progress row, so it is held; but each one restates the whole run so
 * far, so the hold keeps only the newest per task run
 * ({@link dropSupersededProgress}).
 *
 * @module services/runtimes/claude-code/sessions/frames/helper-frames-between-turns
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../../../lib/logger.js';
import { isHelperFrame } from './frame-kinds.js';

/**
 * Counts the helper frames left out between two turns, and says so once, when
 * the next turn opens or the process goes.
 */
export class HelperFramesBetweenTurns {
  private dropped = 0;
  private byType: Record<string, number> = {};

  /**
   * Count helper frames for one session.
   *
   * @param sessionId - The session the log lines name
   */
  constructor(private readonly sessionId: string) {}

  /**
   * Leave one helper frame out of the chat, and count it.
   *
   * @param message - A helper's frame that arrived with no turn open
   */
  leaveOut(message: SDKMessage): void {
    if (this.dropped === 0) {
      logger.debug('[SessionTurnWindows] a helper is working with no turn open', {
        sessionId: this.sessionId,
        helper: (message as { parent_tool_use_id?: unknown }).parent_tool_use_id,
      });
    }
    this.dropped += 1;
    this.byType[message.type] = (this.byType[message.type] ?? 0) + 1;
  }

  /**
   * Leave out, and count, every helper frame in a batch going back on hold.
   *
   * @param messages - Frames returning to the hold, such as a refused dispatch's
   * @returns The frames that are not a helper's, in order
   */
  leaveOutAll(messages: readonly SDKMessage[]): SDKMessage[] {
    const kept: SDKMessage[] = [];
    for (const message of messages) {
      if (isHelperFrame(message)) this.leaveOut(message);
      else kept.push(message);
    }
    return kept;
  }

  /** Say how many helper frames were left out since the last turn, then start again. */
  account(): void {
    if (this.dropped === 0) return;
    logger.info("[SessionTurnWindows] left a helper's frames out; no turn was open", {
      sessionId: this.sessionId,
      dropped: this.dropped,
      byType: this.byType,
    });
    this.dropped = 0;
    this.byType = {};
  }
}

/**
 * The task run a `system/task_progress` line reports on, or undefined for any
 * other frame. Run and task together: a resumed task keeps its id and gets a
 * new run, and each run's progress is its own.
 */
function progressKey(message: SDKMessage): string | undefined {
  if (message.type !== 'system') return undefined;
  const frame = message as { subtype?: unknown; task_id?: unknown; run_id?: unknown };
  if (frame.subtype !== 'task_progress' || typeof frame.task_id !== 'string') return undefined;
  return `${frame.task_id}\u0000${typeof frame.run_id === 'string' ? frame.run_id : ''}`;
}

/**
 * Before `message` joins the hold, take out the held progress line it
 * supersedes, if any. Each `task_progress` carries the run's running totals
 * (tool calls, tokens, time) and its latest summary, so the newest says
 * everything the older ones did.
 *
 * @param held - The windower's between-turn hold, changed in place
 * @param message - The frame about to be held
 */
export function dropSupersededProgress(held: SDKMessage[], message: SDKMessage): void {
  const key = progressKey(message);
  if (key === undefined) return;
  const index = held.findIndex((candidate) => progressKey(candidate) === key);
  if (index !== -1) held.splice(index, 1);
}

/**
 * Keep only the newest progress line per task run in a hold, in place. For a
 * batch that went back on hold in one piece, where {@link dropSupersededProgress}
 * never saw the lines one by one.
 *
 * @param held - The windower's between-turn hold, changed in place
 */
export function keepNewestProgress(held: SDKMessage[]): void {
  const seen = new Set<string>();
  for (let index = held.length - 1; index >= 0; index -= 1) {
    const key = progressKey(held[index]!);
    if (key === undefined) continue;
    if (seen.has(key)) held.splice(index, 1);
    else seen.add(key);
  }
}
