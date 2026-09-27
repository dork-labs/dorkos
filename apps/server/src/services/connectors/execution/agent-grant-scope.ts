/**
 * Which grants decide what one agent can do on one account, in one session.
 *
 * The single definition of that precedence, shared by the execution check
 * (`ConnectorAuthorizationService.hasGrant`) and the agent request service, so
 * "the owner answered with the access this agent has" can never disagree with
 * "this call is allowed".
 *
 * 1. A session override for the account decides alone. `detached`, another
 *    agent's override, or one awaiting reconciliation denies; `attached` allows
 *    only the session's own grants. Neither the agent's grants nor an
 *    every-agent grant can widen a session the owner scoped by hand.
 * 2. With no override, a named-agent grant or an every-agent grant allows
 *    (ADR 260926-192625). An every-agent grant never counts on a managed
 *    account: hosted authority keys grants per named agent and cannot see an
 *    owner-wide subject.
 *
 * @module services/connectors/execution/agent-grant-scope
 */
import {
  and,
  connectionOperationGrants,
  eq,
  or,
  sessionConnectionOverrides,
  type Db,
  type DbTransaction,
  type SQL,
} from '@dorkos/db';
import { everyAgentGrantSubject } from '../every-agent-grants.js';

/** Why a session override shuts an agent out of an account. */
export type AgentGrantDenial = 'detached' | 'other_agent' | 'needs_reconciliation';

/** The grant rows that count for one agent, or why none can. */
export type AgentGrantScope =
  | { readonly kind: 'denied'; readonly reason: AgentGrantDenial }
  | { readonly kind: 'scope'; readonly subject: SQL };

/** Who, where and on which kind of account. */
export interface AgentGrantScopeInput {
  /** The agent whose access is asked about. */
  readonly agentId: string;
  /** The session it acts in; overrides are per session. */
  readonly sessionId: string | undefined;
  /** The account. */
  readonly connectionId: string;
  /** Managed accounts never honour an every-agent grant. */
  readonly providerMode: 'managed' | 'byo';
}

/**
 * Resolve the subject predicate for one agent's grants on one account in one
 * session, or the override that denies it. Combine the predicate with the
 * connection, revision and `revokedAt IS NULL` filters the caller needs.
 *
 * @param db - The database or open transaction to read the override from.
 * @param input - Agent, session, account and account kind.
 */
export function agentGrantScope(
  db: Db | DbTransaction,
  input: AgentGrantScopeInput
): AgentGrantScope {
  const namedAgent = and(
    eq(connectionOperationGrants.subjectType, 'agent'),
    eq(connectionOperationGrants.subjectId, input.agentId)
  )!;
  if (input.sessionId) {
    const override = db
      .select({
        state: sessionConnectionOverrides.state,
        agentId: sessionConnectionOverrides.agentId,
        needsReconciliation: sessionConnectionOverrides.needsReconciliation,
      })
      .from(sessionConnectionOverrides)
      .where(
        and(
          eq(sessionConnectionOverrides.sessionId, input.sessionId),
          eq(sessionConnectionOverrides.connectionId, input.connectionId)
        )
      )
      .get();
    if (override) {
      if (override.agentId !== input.agentId) return { kind: 'denied', reason: 'other_agent' };
      if (override.needsReconciliation) {
        return { kind: 'denied', reason: 'needs_reconciliation' };
      }
      if (override.state === 'detached') return { kind: 'denied', reason: 'detached' };
      if (override.state === 'attached') {
        return {
          kind: 'scope',
          subject: and(
            eq(connectionOperationGrants.subjectType, 'session'),
            eq(connectionOperationGrants.subjectId, input.sessionId),
            eq(connectionOperationGrants.agentId, input.agentId)
          )!,
        };
      }
    }
  }
  return {
    kind: 'scope',
    subject:
      input.providerMode === 'managed' ? namedAgent : or(namedAgent, everyAgentGrantSubject())!,
  };
}
