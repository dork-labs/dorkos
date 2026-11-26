/**
 * The references a turn carries about itself, so whatever the agent writes
 * outward can be signed with them (provenance v2, ADR 261122-124821 and
 * `research/20261122_dorkos-address-format.md` §5.6).
 *
 * Two variables ride beside `DORKOS_SESSION_ID` (the chat):
 *
 * - `DORKOS_AGENT_ID`: the Mesh ULID of the chat's agent. Absent when the turn
 *   has no registered agent; never guessed from a folder or a name.
 * - `DORKOS_SPACE_ID`: the local space's id, as boot loaded it
 *   (`lib/identity/space-id.ts`). Absent before boot or when it could not be
 *   read or saved; a turn never reads the file.
 *
 * A third says where the turn came from:
 *
 * - `DORKOS_API_URL`: the server that started this turn, as a loopback origin
 *   (`http://localhost:4242`), so a script the turn runs can reach it
 *   (`dorkos call`, DOR-5264). Built from this server's own bind and port, and
 *   set only when that is loopback and only on a person's own computer: a hub
 *   or an agent computer has its own loopback listener and gets none. Never a
 *   tunnel, LAN or public address, and nothing in it is secret.
 *
 * None is a credential, and none is the install id: the raw install id is
 * the anonymous usage id and never leaves the machine, so nothing here reads it.
 *
 * @module services/runtimes/shared/references/turn-reference-env
 */
import { localDialHost } from '@dorkos/shared/local-dial-host';
import { env } from '../../../../env.js';
import { localSpaceId } from '../../../../lib/identity/space-id.js';
import { currentServerRole } from '../../../../lib/server-role.js';

/** The variable naming the chat's agent by its Mesh ULID. */
export const AGENT_ID_ENV_VAR = 'DORKOS_AGENT_ID';
/** The variable naming the local space by its id. */
export const SPACE_ID_ENV_VAR = 'DORKOS_SPACE_ID';
/** The variable naming the server that started the turn, as a loopback origin. */
export const SERVER_URL_ENV_VAR = 'DORKOS_API_URL';
/** Every reference variable, for allow-lists and for the relaunch fingerprint. */
export const TURN_REFERENCE_ENV_NAMES = [
  AGENT_ID_ENV_VAR,
  SPACE_ID_ENV_VAR,
  SERVER_URL_ENV_VAR,
] as const;

/** A dial host that reaches only this machine: the loopback name or literals. */
function isLoopbackDialHost(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * The loopback origin of this server, or `undefined` when there is none to
 * give: not a person's own computer, a bind that is not loopback (a LAN
 * address), or a port that is not one.
 *
 * @param role - The server's role.
 * @param bindHost - The host the server binds (`DORKOS_HOST`).
 * @param port - The port it listens on (`DORKOS_PORT`).
 */
export function loopbackServerOrigin(
  role: string,
  bindHost: string,
  port: number
): string | undefined {
  if (role !== 'computer') return undefined;
  const host = localDialHost(bindHost);
  if (!isLoopbackDialHost(host)) return undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return `http://${host}:${port}`;
}

/** The reference variables one turn carries; a key is left out when unknown. */
export type TurnReferenceEnv = Partial<Record<(typeof TURN_REFERENCE_ENV_NAMES)[number], string>>;

/**
 * Resolve a turn's reference variables. Synchronous and free of I/O: the space
 * id is the value boot loaded.
 *
 * @param agentId - The Mesh ULID of the chat's agent, or `undefined` when the
 *   turn has no registered agent.
 * @returns Only the variables whose value is known.
 */
export function turnReferenceEnv(agentId: string | undefined): TurnReferenceEnv {
  const spaceId = localSpaceId();
  const serverUrl = loopbackServerOrigin(
    currentServerRole(),
    env.DORKOS_HOST,
    Number(env.DORKOS_PORT)
  );
  return {
    ...(agentId ? { [AGENT_ID_ENV_VAR]: agentId } : {}),
    ...(spaceId ? { [SPACE_ID_ENV_VAR]: spaceId } : {}),
    ...(serverUrl ? { [SERVER_URL_ENV_VAR]: serverUrl } : {}),
  };
}
