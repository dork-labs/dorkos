/**
 * The questions most role checks really ask, named, so a site reads as what
 * it means rather than as a string compare (DOR-2940).
 *
 * Three roles make "not a hub" ambiguous: it used to mean "a person's own
 * computer", and an agent computer is neither. So a site that gives a person's
 * own computer something asks {@link isPersonalComputer}, never "not a hub",
 * and a sealed agent computer gets the hub's (or a stricter) answer by
 * default.
 *
 * Kept apart from `lib/server-role.ts` on purpose: tests replace that module
 * with one `currentServerRole` stub, and these read through it, so every
 * stubbed role reaches them too.
 *
 * @module services/core/server-role/role-checks
 */
import { currentServerRole } from '../../../lib/server-role.js';

/** Whether this server is a hub: a person's own DorkOS in the cloud. */
export function isHub(): boolean {
  return currentServerRole() === 'hub';
}

/**
 * Whether this server is a sealed agent computer: a hub's agents work here,
 * and no person ever signs in, browses or changes it.
 */
export function isAgentComputer(): boolean {
  return currentServerRole() === 'agent-computer';
}

/**
 * Whether this server is a person's own computer, the only role that gets
 * person-facing behaviour of its own: keep-awake, update checks, inline
 * files, previews, Express extension routes and account linking.
 */
export function isPersonalComputer(): boolean {
  return currentServerRole() === 'computer';
}
