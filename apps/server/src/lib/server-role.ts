/**
 * What this server is: a person's own computer, or a hub (their own DorkOS in
 * the cloud, ADR 261015-042933). The request classifier and the registration
 * policy both read it, so hub mode turns both on at once.
 *
 * Every server is a computer today. Hub mode (A2, DOR-2934) sets `hub` here
 * and nowhere else.
 *
 * @module lib/server-role
 */

/** A person's own computer, or a hub where every request is remote. */
export type ServerRole = 'computer' | 'hub';

/** The role this server runs in. */
export function currentServerRole(): ServerRole {
  return 'computer';
}
