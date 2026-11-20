/**
 * The bounds every production warm process is held to, and who may skip the
 * reclaim grace (DOR-4498).
 *
 * Read from `SESSIONS` at each call rather than copied once, so a value read
 * through a getter (a test's slot wait) is the value in force at that launch.
 *
 * @module services/runtimes/claude-code/sessions/slot-wait/warm-pool-options
 */
import type { MessageOpts, TurnStarter } from '@dorkos/shared/agent-runtime';
import { SESSIONS } from '../../../../../config/constants.js';
import { resolveMaxWarmSessions } from './warm-ceiling-size.js';

/** Starters that are an agent's or a machine's work, never a person typing. */
const AGENT_STARTERS: ReadonlySet<TurnStarter> = new Set([
  'agent',
  'agent-message',
  'room-messages',
  'outside-message',
  'webhook',
]);

/** The turn a dispatch is opening, as its slot wait needs it. */
export interface OpeningTurnSlotWait {
  /** Says in the chat that the turn is waiting for a slot. */
  notify: () => void;
  /** True when the turn may take a process inside its grace. */
  personTurn: boolean;
}

/**
 * Whether a turn waits behind another chat's reclaim grace: only when it is
 * KNOWN to be agent work (a lane, a spin-off, a room seat answering an agent, a
 * schedule or a heartbeat). Anything unmarked is treated as a person's, so a
 * person never waits on a guess: the app's own message route sets no starter,
 * and a direct Telegram or Slack turn carries only `unattendedApprovals`.
 *
 * @param opts - The opening turn's options
 */
export function waitsBehindReclaimGrace(
  opts?: Pick<MessageOpts, 'turnStarter' | 'roomTurn' | 'contextPlace'>
): boolean {
  const starter = opts?.turnStarter ?? opts?.roomTurn?.turnStarter;
  if (starter !== undefined) return AGENT_STARTERS.has(starter);
  return opts?.contextPlace !== undefined;
}

/**
 * The acquire options a production session is held to. The two closures read
 * `bundle.slotWait` at call time, so they answer for the turn opening now. With
 * no turn opening the launch is a person's staged message warming a cold chat,
 * and it skips the grace like any person action.
 *
 * @param bundle - The session's bundle, whose `slotWait` the dispatch sets
 */
export function warmPoolOptions(bundle: { slotWait?: OpeningTurnSlotWait }) {
  return {
    maxWarmSessions: () => resolveMaxWarmSessions(),
    warmIdleMs: SESSIONS.WARM_IDLE_MS,
    slotWaitMs: SESSIONS.WARM_SLOT_WAIT_MS,
    reclaimGraceMs: SESSIONS.RECLAIM_GRACE_MS,
    onWaitingForSlot: () => bundle.slotWait?.notify(),
    // No `slotWait` means no turn is opening, and the only launch like that is
    // `stage()` warming a cold chat for a PERSON's staged message
    // (`deliverStage`). It is not anonymous background work: keep it skipping.
    skipReclaimGrace: () => bundle.slotWait?.personTurn ?? true,
  };
}
