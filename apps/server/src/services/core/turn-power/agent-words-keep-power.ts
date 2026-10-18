/**
 * Whether, on this install, a post or message from one of our own agents keeps
 * the turn it starts at the receiver's own level (ADR `261018-030117`).
 *
 * Power flows downstream (spec `trusted-by-default-flip` §4): a turn somebody
 * else's words start runs no looser than that somebody. For a stranger that is
 * the whole point. For our own agents on Trusted it took power away for no
 * reason: an agent in Auto (recorded as Default) mentioned three teammates in a
 * room, and every one of them ran at Default and raised cards a person had
 * turned off. Trusted means our agents are trusted co-workers, so between them
 * the bound no longer applies.
 *
 * What stays bounded, on every preset: a stranger, a bridged chat, a relayed
 * message, a space teammate, and any agent words DorkOS could not vouch for
 * (`vouchesForAgent`). On Careful nothing changes. Fails closed: a preset that
 * cannot be read keeps the bound.
 *
 * @module services/core/turn-power/agent-words-keep-power
 */
import { trustPosture } from '@dorkos/shared/permissions';
import { permissionGateSources } from '../capabilities/permission-enforcement.js';

/** Whether the install is on Trusted, read fresh; false when the preset cannot be read. */
export function agentWordsKeepPower(): boolean {
  try {
    return trustPosture(permissionGateSources().readConfig().preset) === 'trusted';
  } catch {
    return false;
  }
}
