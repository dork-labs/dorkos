/**
 * The launch gate's seat in turn code (spec `turns-survive-restarts` §7.5,
 * DOR-5161): one question every path that can launch a turn asks first. Does
 * this chat have a run a restart ended that recovery has not decided yet, or
 * a continuation not yet made or started? If so, it waits. The chat's live
 * run is the launch-begin check's (§4.7), which every launch reaches next.
 *
 * The dispatcher cannot import `services/runs` (§3.4), so the run record
 * registers the answer here at startup ({@link setLaunchGate}), and the
 * dispatcher's four launch paths ask {@link launchGateHolds}: the launch
 * itself (`launchVerdictOf`), adoption, the queue rearm and the pump. With no
 * gate registered (most unit tests, a host without the record) nothing waits.
 *
 * A chat the gate held is woken through {@link wakeChat} when what it waited
 * on clears without a turn ending (a run decided, a continuation cancelled
 * before it started): the dispatcher registers its pump here
 * ({@link setLaunchGateWake}), so the run record never reaches it directly.
 *
 * @module services/session/turn-port/launch-gate
 */
import { logger } from '../../../lib/logger.js';

/** The run record's answer to the gate's one question. */
export interface LaunchGate {
  /**
   * Whether a launch in this chat must wait.
   *
   * @param chatKey - The chat, by the id its queue rows are kept under.
   * @param runId - The launching run, when it has one: the chat's own
   *   continuation passes, as it goes before every waiting run of its chat.
   */
  holds(chatKey: string, runId?: string): boolean;
}

let gate: LaunchGate | undefined;
let wake: ((chatKey: string) => void) | undefined;

/**
 * Register (or clear) the run record's answer. Called by `services/runs` at
 * startup; `undefined` clears it (test isolation).
 *
 * @param next - The gate, or `undefined`.
 */
export function setLaunchGate(next: LaunchGate | undefined): void {
  gate = next;
}

/**
 * Register how a held chat is woken: the dispatcher's pump.
 *
 * @param next - Gives a chat's queue a chance to move.
 */
export function setLaunchGateWake(next: (chatKey: string) => void): void {
  wake = next;
}

/**
 * Whether a launch in this chat must wait (§7.5). A gate that cannot answer
 * lets the launch go, as every other failure of the record does (§4.7): a
 * record that cannot be read must never hold a chat for good.
 *
 * @param chatKey - The chat, by any id it answers to.
 * @param runId - The launching run, when it has one.
 */
export function launchGateHolds(chatKey: string, runId?: string): boolean {
  if (!gate) return false;
  try {
    return gate.holds(chatKey, runId);
  } catch (err) {
    logger.error('[MessageDispatcher] the launch gate could not answer; the launch goes on', {
      sessionId: chatKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * What the gate held a chat for has cleared: give its queue a chance to move.
 *
 * @param chatKey - The chat, by any id it answers to.
 */
export function wakeChat(chatKey: string): void {
  wake?.(chatKey);
}
