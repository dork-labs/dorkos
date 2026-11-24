/**
 * What happens to a session's timers when its warm process ends (DOR-2717,
 * DOR-3755).
 *
 * A timer the agent set (CronCreate, ScheduleWakeup, /loop) lives inside its
 * Claude Code process, so it ends with it, and the next process has none until
 * its own first Stop hook says otherwise. When DorkOS is what ended the process
 * (a slot reclaimed for another chat, the four-hour ceiling, an eviction),
 * nothing runs the chat again until its next turn, so a timer due in between
 * never fires. Claude Code's own resume notice covers a past-due ScheduleWakeup
 * but not a one-shot CronCreate, so the agent's next turn is told here, through
 * the one-time cutoff note (`session/turn-cutoff`).
 *
 * Two endings say nothing. A server shutdown is answered at the next boot,
 * which wakes the chat because the background-work record holds timers too
 * (`background-work-ledger.ts`). A crash is not DorkOS ending the process, and
 * its recovery may relaunch it before the timer is due.
 *
 * A note, not a wake: whether DorkOS should start a turn for a chat whose timer
 * it took away is a product call, and a wake would relaunch a `/loop` chat for
 * ever.
 *
 * @module services/runtimes/claude-code/sessions/dispatch/session-timers
 */
import type { PumpState, PumpTeardownReason } from '../session-pump-contract.js';
import type { AgentSession } from '../../agent-types.js';
import { noteTurnCutoff } from '../../../../session/turn-cutoff/turn-cutoff.js';

/** The states a pump reaches when its process has ended. */
const PROCESS_ENDED: ReadonlySet<PumpState> = new Set(['cold', 'reaped', 'crashed']);

/**
 * On a move that ends the process, forget its timers, and owe the agent a note
 * when DorkOS ended it with timers still pending. Any other move does nothing.
 *
 * @param key - The session's resolved key
 * @param session - The session whose timers were counted at its last turn end
 * @param to - The state the pump just moved into
 * @param reason - Why the pump was torn down, for a `cold` move
 * @param now - When it moved, as epoch ms
 */
export function endSessionTimers(
  key: string,
  session: Pick<AgentSession, 'pendingTimers'>,
  to: PumpState,
  reason: PumpTeardownReason | undefined,
  now: number = Date.now()
): void {
  if (!PROCESS_ENDED.has(to)) return;
  const pending = session.pendingTimers ?? 0;
  session.pendingTimers = undefined;
  if (pending === 0 || to === 'crashed' || reason === 'shutdown') return;
  noteTurnCutoff(key, { timersStopped: pending, at: now });
}
