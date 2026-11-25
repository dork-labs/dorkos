/**
 * The launch cap (`runtimes.maxAgentChats`, DOR-3413): how many chats nobody
 * typed into may have a live turn at once. The counter `dispatchSessionMessage`
 * claims a slot on, and the one admission reads (spec `turns-survive-restarts`
 * §3.5, `machine_full`). Its own module so the space side can read it without
 * loading the launch path.
 *
 * @module services/session/launch/launch-cap
 */
import { configManager } from '../../core/config-manager.js';
import { logger } from '../../../lib/logger.js';

/**
 * How many sessions nobody typed into (see
 * {@link DispatchSessionMessageOpts.countsTowardLaunchCap}) may have a live turn
 * at once, when `runtimes.maxAgentChats` cannot be read. The 2026-09-25 drain
 * reached a machine load near 500 (spec `claude-account-fleet` D5 "Load cap",
 * D9 "Automatic handoff").
 */
export const AGENT_LAUNCH_MAX_LIVE = 8;

/** The setting a person raises the cap with, as the refusals name it. */
export const AGENT_LAUNCH_CAP_SETTING = 'runtimes.maxAgentChats';

/**
 * The cap in force right now: `runtimes.maxAgentChats` (DOR-3413), read at each
 * launch so a change applies to the next one without a restart.
 */
export function agentLaunchMaxLive(): number {
  try {
    const configured = configManager.get('runtimes')?.maxAgentChats;
    if (typeof configured === 'number' && Number.isInteger(configured) && configured > 0) {
      return configured;
    }
  } catch (err) {
    logger.debug('[launch-session] config unavailable, using the default chat cap', {
      err: String(err),
    });
  }
  return AGENT_LAUNCH_MAX_LIVE;
}

/** The sentence a launch refused by the cap answers with. */
export function agentLaunchCapMessage(): string {
  return (
    `Too many spin-off chats are running (${agentLaunchMaxLive()}). Try again when one finishes. ` +
    `A person can raise the limit with the ${AGENT_LAUNCH_CAP_SETTING} setting.`
  );
}

/** One entry per capped launch whose turn has not settled yet. */
const liveCappedLaunches = new Set<symbol>();

/**
 * Take one slot under the cap for a launch whose turn has not settled. Taken
 * before any await by the caller, so two launches racing for the last slot
 * cannot both get it.
 *
 * @returns Let the slot go: once the turn settled, or the launch came to nothing.
 */
export function claimCappedLaunch(): () => void {
  const slot = Symbol('capped-launch');
  liveCappedLaunches.add(slot);
  return () => {
    liveCappedLaunches.delete(slot);
  };
}

/**
 * Whether every slot under {@link agentLaunchMaxLive} is taken right now.
 */
export function isAgentLaunchCapFull(): boolean {
  return liveCappedLaunches.size >= agentLaunchMaxLive();
}
