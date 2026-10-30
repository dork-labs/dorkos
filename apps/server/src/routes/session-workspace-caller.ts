/**
 * Who is posting a chat message, for a new workspace its `workspaceKey` names
 * (DOR-2335). Its own module so `sessions.ts` stays under its size limit.
 *
 * @module routes/session-workspace-caller
 */
import type { RequestFacts } from '../http/request-facts.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import { trustedCaller } from '../services/core/capabilities/index.js';

/**
 * Who is posting a message, for a new workspace its `workspaceKey` names
 * (DOR-2335): a person at this machine, or anyone else, with the name an
 * approval card shows.
 *
 * @param facts - The request's facts, with the agent identity.
 */
export function workspaceCallerOf(facts: RequestFacts): { trusted: boolean; requestedBy?: string } {
  const identity = facts.agentIdentity;
  return {
    trusted: trustedCaller(readCallerAuthority(facts)) !== undefined,
    ...(identity && { requestedBy: identity.displayName || identity.agentPath }),
  };
}
