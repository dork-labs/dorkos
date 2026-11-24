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
 * Neither is a credential, and neither is the install id: the raw install id is
 * the anonymous usage id and never leaves the machine, so nothing here reads it.
 *
 * @module services/runtimes/shared/references/turn-reference-env
 */
import { localSpaceId } from '../../../../lib/identity/space-id.js';

/** The variable naming the chat's agent by its Mesh ULID. */
export const AGENT_ID_ENV_VAR = 'DORKOS_AGENT_ID';
/** The variable naming the local space by its id. */
export const SPACE_ID_ENV_VAR = 'DORKOS_SPACE_ID';
/** Both reference variables, for allow-lists and for the relaunch fingerprint. */
export const TURN_REFERENCE_ENV_NAMES = [AGENT_ID_ENV_VAR, SPACE_ID_ENV_VAR] as const;

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
  return {
    ...(agentId ? { [AGENT_ID_ENV_VAR]: agentId } : {}),
    ...(spaceId ? { [SPACE_ID_ENV_VAR]: spaceId } : {}),
  };
}
