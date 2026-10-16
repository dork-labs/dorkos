/**
 * What this server is: a person's own computer, or a hub (their own DorkOS in
 * the cloud, ADR 261015-042933). The request classifier, the registration
 * policy, the settings pins and the startup steps all read it, so hub mode
 * turns every one of them on at once.
 *
 * `DORKOS_SERVER_ROLE` decides it, read here and nowhere else (DOR-2934). It
 * is fixed for the life of the process: a server never changes what it is.
 *
 * @module lib/server-role
 */
import { env } from '../env.js';

/** A person's own computer, or a hub where every request is remote. */
export type ServerRole = 'computer' | 'hub';

/** The role this server runs in. */
export function currentServerRole(): ServerRole {
  return env.DORKOS_SERVER_ROLE;
}
