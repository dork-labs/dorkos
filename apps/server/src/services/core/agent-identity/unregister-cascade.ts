/**
 * Cascade: revoke an agent's identity tokens the moment it is deleted or
 * unregistered (spec `agent-trust` §3.1, DOR-490).
 *
 * `AgentIdentityService.revoke` used to have zero production callers, so an
 * operator's decision to remove an agent had no effect on that agent's
 * identity: its tokens kept resolving, bounded only by their idle/absolute
 * expiry clocks. Three TSDoc blocks on the service already leaned on
 * revocation as "the operator's actual off switch" — this cascade is what
 * makes that claim true rather than aspirational.
 *
 * @module services/core/agent-identity/unregister-cascade
 */
import type { Logger } from '@dorkos/shared/logger';
import type { AgentIdentityService } from './agent-identity-service.js';

/**
 * Build the `MeshCore.onUnregister` callback that revokes an unregistered
 * agent's identity tokens.
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
    const service = getService();
    if (!service) return;
    service
      .revoke(agentPath)
      .then((count) => {
        if (count > 0) {
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
