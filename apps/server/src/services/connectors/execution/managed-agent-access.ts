/**
 * Whether one agent's own access to an account connected through a DorkOS
 * account has reached the hosted side: the one definition shared by the
 * execution check and the agent's granted-connections list, so an account the
 * list calls usable is one a call can use.
 *
 * A call is authorized by the newest APPLIED command of the scope that grants
 * it: the agent's own (`agent_grants`), else "every agent"
 * (`every_agent_grants`, DOR-2439). A newer command still pending or refused
 * does not stop the applied one from working, so the account is usable. Only
 * when no granting scope has anything applied does the latest command of those
 * scopes decide what the agent is told: still applying, or refused.
 *
 * @module services/connectors/execution/managed-agent-access
 */
import {
  and,
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  desc,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  eq,
  type Db,
} from '@dorkos/db';
import type { ConnectorAuthoritySyncState } from '@dorkos/shared/connector-resource-schemas';
import { LEGACY_PENDING_REASON } from '../resources/managed-authority-sync-service.js';

/** Which kinds of grant give this agent the account. */
export interface ManagedGrantSubjects {
  /** Its own grant (named agent, or this chat's own grant). */
  readonly named: boolean;
  /** The owner's every-agent grant. */
  readonly everyAgent: boolean;
}

/** One agent's hosted access on one managed account. */
export interface ManagedAgentAccess {
  /** The applied scope a call uses, when one is applied. */
  readonly applied?: { readonly subject: 'agent' | 'every_agent'; readonly scopeVersion: number };
  /** `ready` when applied; otherwise whether it is still applying or was refused. */
  readonly sync: ConnectorAuthoritySyncState;
}

/** What an agent is told when a refused command left no reason of its own. */
const REFUSED_WITHOUT_REASON = 'The change to who can use this account did not go through.';

type GrantScope = { kind: 'agent_grants' | 'every_agent_grants'; subjectId: string };

function scopesFor(agentId: string, granted: ManagedGrantSubjects): GrantScope[] {
  return [
    ...(granted.named ? [{ kind: 'agent_grants' as const, subjectId: agentId }] : []),
    ...(granted.everyAgent
      ? [{ kind: 'every_agent_grants' as const, subjectId: EVERY_AGENT_GRANT_SUBJECT_ID }]
      : []),
  ];
}

function appliedVersion(db: Db, managedConnectionId: string, scope: GrantScope) {
  return db
    .select({ scopeVersion: connectorManagedAuthorityOutbox.scopeVersion })
    .from(connectorManagedAuthorityOutbox)
    .where(
      and(
        eq(connectorManagedAuthorityOutbox.managedConnectionId, managedConnectionId),
        eq(connectorManagedAuthorityOutbox.scopeKind, scope.kind),
        eq(connectorManagedAuthorityOutbox.subjectId, scope.subjectId),
        eq(connectorManagedAuthorityOutbox.state, 'applied')
      )
    )
    .orderBy(desc(connectorManagedAuthorityOutbox.scopeVersion))
    .limit(1)
    .get()?.scopeVersion;
}

function latestCommand(db: Db, managedConnectionId: string, scope: GrantScope) {
  return db
    .select({
      state: connectorManagedAuthorityOutbox.state,
      safeReason: connectorManagedAuthorityOutbox.safeReason,
      nextAttemptAt: connectorManagedAuthorityOutbox.nextAttemptAt,
    })
    .from(connectorManagedAuthorityScopes)
    .innerJoin(
      connectorManagedAuthorityOutbox,
      eq(connectorManagedAuthorityOutbox.commandId, connectorManagedAuthorityScopes.lastCommandId)
    )
    .where(
      and(
        eq(connectorManagedAuthorityScopes.managedConnectionId, managedConnectionId),
        eq(connectorManagedAuthorityScopes.scopeKind, scope.kind),
        eq(connectorManagedAuthorityScopes.subjectId, scope.subjectId)
      )
    )
    .get();
}

/**
 * This agent's hosted access on one managed account.
 *
 * @param db - The connector database.
 * @param managedConnectionId - The hosted account id (`connections.external_account_ref`).
 * @param agentId - The agent.
 * @param granted - Which kinds of grant give it the account.
 */
export function managedAgentAccess(
  db: Db,
  managedConnectionId: string,
  agentId: string,
  granted: ManagedGrantSubjects
): ManagedAgentAccess {
  const scopes = scopesFor(agentId, granted);
  for (const scope of scopes) {
    const version = appliedVersion(db, managedConnectionId, scope);
    if (version !== undefined) {
      return {
        applied: {
          subject: scope.kind === 'agent_grants' ? 'agent' : 'every_agent',
          scopeVersion: version,
        },
        sync: { status: 'ready' },
      };
    }
  }
  const latest = scopes.map((scope) => latestCommand(db, managedConnectionId, scope));
  const pending = latest.find((command) => command?.state === 'pending');
  if (pending) {
    return pending.safeReason &&
      pending.safeReason !== LEGACY_PENDING_REASON &&
      pending.nextAttemptAt
      ? {
          sync: {
            status: 'pending',
            reason: pending.safeReason,
            retryAt: pending.nextAttemptAt,
          },
        }
      : { sync: { status: 'pending' } };
  }
  const refused = latest.find((command) => command?.state === 'rejected');
  if (refused) {
    return { sync: { status: 'failed', reason: refused.safeReason ?? REFUSED_WITHOUT_REASON } };
  }
  // Nothing sent yet, or only superseded: DorkOS has the change still to send.
  return { sync: { status: 'pending' } };
}
