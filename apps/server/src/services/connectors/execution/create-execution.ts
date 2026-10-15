/**
 * Build what runs a connected-app action at boot: the broker, and the cancel
 * window an agent's irreversible action waits out (spec
 * `trusted-by-default-flip` §5.6). Lifted out of `index.ts`, which may not
 * grow, so the composition root names the pieces and this file assembles them.
 *
 * @module services/connectors/execution/create-execution
 */
import type { ActivityService } from '../../activity/activity-service.js';
import { logger } from '../../../lib/logger.js';
import type { ConnectorExecutionAuthorizationService } from './authorization-service.js';
import { ConnectorExecutionBroker, type ConnectorSignInEndedPort } from './execution-broker.js';
import type { ConnectorUsageStore } from './usage-store.js';
import type { ManagedConnectorExecutionContextBindingPort } from './managed-execution-context.js';
import { DestructiveHoldService } from './destructive-hold.js';
import type { ServerPrincipalProof } from '../principal/server-principal.js';

/** What {@link createConnectorExecution} assembles from. */
export interface ConnectorExecutionParts {
  /** Live owner, agent, grant, account, revision and argument authorization. */
  authorization: ConnectorExecutionAuthorizationService;
  /** Append-only usage evidence. */
  usage: ConnectorUsageStore;
  /** Rechecks a chat's runtime principal; absent when Mesh is off. */
  runtimePrincipals: () =>
    | { revalidatePrincipal(principal: ServerPrincipalProof): boolean | Promise<boolean> }
    | undefined;
  /** Rechecks an API key's program principal. */
  programPrincipals: { revalidate(principal: ServerPrincipalProof): boolean | Promise<boolean> };
  /** Binds a managed attempt to its hosted scope. */
  managedExecutionContexts: ManagedConnectorExecutionContextBindingPort;
  /** Marks an account signed out when the service says so. */
  signIns: ConnectorSignInEndedPort;
  /** The Activity log every held action is recorded in. */
  activity: ActivityService;
}

/**
 * Build the broker and the hold service, and close any hold a previous
 * process left open (its action never ran; the record should say so).
 *
 * @param parts - See {@link ConnectorExecutionParts}.
 * @returns The broker and the hold service.
 */
export function createConnectorExecution(parts: ConnectorExecutionParts): {
  broker: ConnectorExecutionBroker;
  holds: DestructiveHoldService;
} {
  const broker = new ConnectorExecutionBroker(
    parts.authorization,
    parts.usage,
    {
      revalidate: (principal) => {
        if (principal.claims.kind === 'runtime') {
          return parts.runtimePrincipals()?.revalidatePrincipal(principal) ?? false;
        }
        if (principal.claims.kind === 'program') {
          return parts.programPrincipals.revalidate(principal);
        }
        return false;
      },
    },
    undefined,
    parts.managedExecutionContexts,
    parts.signIns
  );
  const holds = new DestructiveHoldService({ activity: parts.activity });
  void holds.dropOpenHolds().catch((err: unknown) => {
    logger.warn('[Connections] Could not close held actions a restart dropped', { err });
  });
  return { broker, holds };
}
