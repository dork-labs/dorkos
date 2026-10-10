/**
 * Cascade: revoke an agent's identity tokens the moment it is deleted or
 * unregistered (spec `agent-trust` §3.1, DOR-490), and drop its pause, if it
 * has one (spec `audit-trail` PR5).
 *
 * `AgentIdentityService.revoke` used to have zero production callers, so an
 * operator's decision to remove an agent had no effect on that agent's
 * identity: its tokens kept resolving, bounded only by their idle/absolute
 * expiry clocks. Three TSDoc blocks on the service already leaned on
 * revocation as "the operator's actual off switch" — this cascade is what
 * makes that claim true rather than aspirational.
 *
 * A mid-session revocation is reported as `inactive: 'revoked'` rather than as
 * no identity at all (DOR-486), so the gate resolves every permission area to
 * Blocked for the agent instead of handing it the install's defaults — see
 * {@link AgentIdentityService.describeAgent}'s TSDoc.
 *
 * @module services/core/agent-identity/unregister-cascade
 */
import { recordAudit } from '../../audit/audit-trail.js';
import { agentPause } from '../../mesh/pause/agent-pause.js';
import type { Logger } from '@dorkos/shared/logger';
import type { AgentIdentityService } from './agent-identity-service.js';

/**
 * Build the `MeshCore.onUnregister` callback that revokes an unregistered
 * agent's identity tokens and drops its pause.
 *
 * Reads the identity service lazily (a getter, not the instance itself) for
 * the same reason every other consumer of the process-wide singleton does:
 * `MeshCore.onUnregister` is wired at Mesh construction, before
 * `initAgentIdentityService` may have run in every boot order, and identity is
 * never required — `undefined` here means "no identity tracking configured",
 * not an error.
 *
 * @param getService - Returns the process-wide identity service, or
 *   `undefined` when none is configured.
 * @param logger - Where the outcome is reported. Never throws: an unregister
 *   that already succeeded must not be undone by a revoke that fails after it.
 * @returns A callback suitable for `MeshCore.onUnregister`.
 */
export function createAgentIdentityUnregisterCascade(
  getService: () => AgentIdentityService | undefined,
  logger: Pick<Logger, 'info' | 'warn'>
): (agentId: string, agentPath: string) => void {
  return (agentId, agentPath) => {
    // A removed agent is no longer paused: its pause row goes with it, so a
    // later agent under the same id does not inherit it (spec `audit-trail` PR5).
    try {
      agentPause()?.forget(agentId);
    } catch (err) {
      logger.warn('[AgentIdentity] Could not drop the pause of an unregistered agent', {
        agentId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    const service = getService();
    if (!service) return;
    service
      .revoke(agentPath)
      .then((count) => {
        if (count > 0) {
          recordAudit({
            action: 'agent_token.revoked',
            operation: 'remove',
            target: { type: 'agent', id: agentId },
            outcome: 'ok',
            change: [{ field: 'activeTokens', before: count, after: 0 }],
            summary: `Revoked ${count} sign-in token${count === 1 ? '' : 's'} of a removed agent`,
          });
          logger.info(`[AgentIdentity] Revoked ${count} token(s) for unregistered agent`, {
            agentId,
          });
        }
      })
      .catch((err: unknown) => {
        logger.warn('[AgentIdentity] Could not revoke tokens for an unregistered agent', {
          agentId,
          reason: err instanceof Error ? err.message : String(err),
        });
      });
  };
}
