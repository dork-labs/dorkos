/**
 * The words an agent reads when the Blocked-request rate limit stops it, split
 * from `tier-enforcement.ts`, which decides when the limit applies.
 *
 * @module services/core/capabilities/blocked-limit-message
 */
import { getPermissionArea, type PermissionAreaId } from '@dorkos/shared/permissions';
import type { BlockedRequestLimit } from '../approvals/index.js';

/**
 * What an agent that asked past Blocked is told when the rate limit stops it
 * (spec `agent-permissions` D8). Each refusal is final for now, so none of them
 * invites another try.
 *
 * @param limit - The limit that stopped the request.
 * @param area - The permission area the request was about.
 */
export function blockedLimitMessage(limit: BlockedRequestLimit, area: PermissionAreaId): string {
  switch (limit.limit) {
    case 'pending':
      // Not the first request's `awaiting_decision` payload, which spec D8
      // describes: tokens are stored hashed, so the first token cannot be sent
      // again. The approval id names the request instead, and the message says
      // how the answer arrives (see the spec's D8 note of 2026-09-24).
      return (
        `You already asked the person about ${getPermissionArea(area)?.label ?? area} (request ${limit.approvalId}) ` +
        'and they have not answered yet. Do not ask again: wait for their answer. In a DorkOS ' +
        'session, DorkOS tells you here when they decide. If they say yes, call ' +
        '`request_permission` again with the same action and arguments, plus the approvalToken ' +
        'your first request returned, and the action runs.'
      );
    case 'recently_denied':
      return (
        'The person said no to this in the last day. Do not ask again; tell them what you ' +
        'could not do and why.'
      );
    case 'hourly_limit':
      return (
        'You have asked past blocked permissions too many times in the last hour. Stop asking; ' +
        'tell the person what you need instead.'
      );
  }
}
