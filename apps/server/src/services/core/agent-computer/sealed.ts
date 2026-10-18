/**
 * What a sealed agent computer refuses and skips, said once (DOR-2940,
 * `specs/everything-is-a-space/design-agent-computers.md`).
 *
 * An agent computer is a machine in the cloud where a hub's agents work. It
 * holds no account secrets and no person changes it: its DorkOS account link,
 * its runtime sign-ins and its settings will come from the hub it belongs to,
 * never from a request to it. Its gate refuses the account routes outright
 * (`./agent-gate.ts`), a settings write refuses with
 * {@link AGENT_COMPUTER_SETTINGS_REFUSAL}, and the background work a person's
 * computer runs on its own clock (scheduled tasks, heartbeats) asks
 * {@link runsSchedules} before it starts.
 *
 * @module services/core/agent-computer/sealed
 */
import { isAgentComputer } from '../server-role/role-checks.js';

/** The sentence a refused settings write carries (`applyConfigPatch`). */
export const AGENT_COMPUTER_SETTINGS_REFUSAL =
  'This is an agent computer. Its settings come from its hub.';

/**
 * Whether this server runs work on its own clock: the tasks scheduler and
 * agent heartbeats. Never on an agent computer, which works only when its hub
 * sends it something.
 */
export function runsSchedules(): boolean {
  return !isAgentComputer();
}
