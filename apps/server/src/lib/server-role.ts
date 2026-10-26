/**
 * What this server is: a person's own computer, a hub (their own DorkOS in
 * the cloud, ADR 261015-042933), or an agent computer (a sealed machine in the
 * cloud where a hub's agents work, `specs/everything-is-a-space/
 * design-agent-computers.md`). The request classifier, the registration
 * policy, the settings pins and the startup steps all read it, so a role turns
 * every one of them on at once.
 *
 * `DORKOS_SERVER_ROLE` decides it, read here and nowhere else (DOR-2934). It
 * is fixed for the life of the process: a server never changes what it is.
 * The named questions over it (`isHub`, `isAgentComputer`,
 * `isPersonalComputer`) live in `services/core/server-role/role-checks.ts`.
 *
 * @module lib/server-role
 */
import { env } from '../env.js';

/**
 * A person's own computer; a hub, where every request is remote; or an agent
 * computer, which serves no person at all.
 */
export type ServerRole = 'computer' | 'hub' | 'agent-computer';

/** The role this server runs in. */
export function currentServerRole(): ServerRole {
  return env.DORKOS_SERVER_ROLE;
}
