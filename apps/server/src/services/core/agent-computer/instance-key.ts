/**
 * An agent computer's own DorkOS Cloud instance key (DOR-2940,
 * `specs/everything-is-a-space/design-agent-computers.md` §5).
 *
 * Cloud boots an agent computer with `DORKOS_AGENT_COMPUTER_INSTANCE_KEY`
 * (`packages/cloud-api/src/hubs.ts`). It is the only credential the computer
 * holds: it reads the computer's assignment, and it mints the computer's own
 * model tokens (`POST /v1/inference/tokens`), which the service caps per
 * computer and per account.
 *
 * It is kept the way `env.ts` keeps a hub's key (`DORKOS_HUB_INSTANCE_KEY`):
 * in a process-wide slot, here under
 * `Symbol.for('dorkos.env.agentComputerInstanceKey')`, and removed from
 * `process.env` the moment this module loads, so no child process this server
 * starts later (a terminal, an agent, the OpenCode sidecar, an MCP server)
 * inherits it. Any other module that reads the key must read it from the
 * same slot, or move it there the same way before deleting it.
 *
 * It is never written down, never logged and never sent anywhere but the
 * Cloud API.
 *
 * ## What deleting it does not do
 *
 * Removing the key from `process.env` does not remove it from the process's
 * startup environment, which the operating system keeps. On Linux, any
 * process running as the same user can read it from `/proc/<pid>/environ` of
 * this server, and can read this process's memory if ptrace is allowed. An
 * agent's shell, its tools and anything a package runs are such processes. A
 * process holding the key can mint model tokens billed to the account and
 * read the computer's assignment, link code included.
 *
 * **So the computer's image must keep agents away from it**, by at least one of:
 *
 * - running the DorkOS server as a different user from the one the agents,
 *   the terminal and the OpenCode sidecar run as; or
 * - mounting `/proc` with `hidepid=2` and restricting ptrace
 *   (`kernel.yama.ptrace_scope` of 2 or more), so no process can see another's
 *   environment or memory.
 *
 * Follow-up, not done here: have the server re-execute itself once the key is
 * read, with the key handed over on a pipe rather than in the environment, so
 * no startup copy exists. It changes how the computer's process starts and
 * stops, so it belongs with the image work.
 *
 * @module services/core/agent-computer/instance-key
 */
import { isAgentComputer } from '../server-role/role-checks.js';

/** The variable Cloud sets on an agent computer it boots. */
export const AGENT_COMPUTER_INSTANCE_KEY_NAME = 'DORKOS_AGENT_COMPUTER_INSTANCE_KEY';

/** The shortest key the contract allows (`packages/cloud-api/src/hubs.ts`). */
const MIN_KEY_LENGTH = 16;

const KEY_SLOT = Symbol.for('dorkos.env.agentComputerInstanceKey');
const kept = globalThis as typeof globalThis & { [KEY_SLOT]?: string };

// eslint-disable-next-line no-restricted-syntax -- the key is moved out of the environment at load, so no child process inherits it (see the module doc)
const fromEnvironment = process.env[AGENT_COMPUTER_INSTANCE_KEY_NAME];
if (fromEnvironment) {
  kept[KEY_SLOT] = fromEnvironment;
  // eslint-disable-next-line no-restricted-syntax -- same: removing it is the point
  delete process.env[AGENT_COMPUTER_INSTANCE_KEY_NAME];
}

/**
 * This agent computer's own instance key, or `null` on any other role, or
 * when Cloud set none (or one too short to be real). Never reads the account
 * link a person's computer keeps: an agent computer pays only with its own key.
 * See the module doc for who else on the computer can reach it.
 */
export function agentComputerInstanceKey(): string | null {
  if (!isAgentComputer()) return null;
  const key = kept[KEY_SLOT]?.trim();
  return key && key.length >= MIN_KEY_LENGTH ? key : null;
}

/**
 * Replace the kept key. Test seam only: production reads it from the
 * environment once, at load.
 *
 * @param key - The key to keep, or `undefined` to forget it.
 * @internal
 */
export function __setAgentComputerInstanceKeyForTests(key: string | undefined): void {
  if (key === undefined) delete kept[KEY_SLOT];
  else kept[KEY_SLOT] = key;
}
