/**
 * Which grants decide what one agent can do on one account, in one session.
 *
 * The single definition of that precedence (DOR-3975), shared by the
 * execution check (`ConnectorExecutionAuthorizationService.matchingGrants`),
 * the agent request service and the agent's own access reads
 * (`ConnectorAccessQueryService`), so "the owner answered with the access this
 * agent has", "this call is allowed" and "the agent's tool list shows it" can
 * never disagree.
 *
 * 1. A session override for the account decides alone. `detached`, another
 *    agent's override, or one awaiting reconciliation denies; `attached` allows
 *    only the session's own grants. Neither the agent's grants nor an
 *    every-agent grant can widen a session the owner scoped by hand.
 * 2. With no override, a named-agent grant or an every-agent grant allows
 *    (ADR 260926-192625), on an account connected with the owner's own key and
 *    on one connected through a DorkOS account alike (DOR-2439): hosted
 *    authority honours the owner-wide subject too. An agent left out of the
 *    share on this account (DOR-3961) keeps only its named grants.
 *
 * Every read about ONE agent goes through this module or `everyAgentGrantFor`;
 * `every-agent-subject-census.test.ts` fails if a new one reaches for the bare
 * every-agent subject instead.
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
import { everyAgentGrantFor } from '../every-agent-grants.js';

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
}

/** One session's access override for one account, as stored. */
export interface SessionGrantOverride {
  /** The agent the override was made for. */
  readonly agentId: string | null;
  /** Whether the session attached its own grants or turned the account off. */
  readonly state: 'attached' | 'detached';
  /** Set while a change to the account waits to be reconciled. */
  readonly needsReconciliation: boolean;
}

/** What a session override (or its absence) decides for one agent. */
export type OverrideDecision =
  | { readonly kind: 'denied'; readonly reason: AgentGrantDenial }
  | { readonly kind: 'session_only' }
  | { readonly kind: 'agent_and_every_agent' };

/**
 * Rule 1 of the module: what one session override decides for one agent.
 *
 * @param override - The session's override for the account, if it has one.
 * @param agentId - The agent asked about.
 */
function overrideDecision(
  override: SessionGrantOverride | undefined,
  agentId: string
): OverrideDecision {
  if (!override) return { kind: 'agent_and_every_agent' };
  if (override.agentId !== agentId) return { kind: 'denied', reason: 'other_agent' };
  if (override.needsReconciliation) return { kind: 'denied', reason: 'needs_reconciliation' };
  if (override.state === 'detached') return { kind: 'denied', reason: 'detached' };
  return { kind: 'session_only' };
}

/**
 * Whether one grant row, already read through {@link agentGrantRowsSubject},
 * gives this agent the account in this session.
 *
 * @param row - The grant row's subject type.
 * @param override - The session's override for the row's account, if any.
 * @param agentId - The agent asked about.
 */
export function grantRowApplies(
  row: { subjectType: string },
  override: SessionGrantOverride | undefined,
  agentId: string
): boolean {
  const decision = overrideDecision(override, agentId);
  if (decision.kind === 'denied') return false;
  if (decision.kind === 'session_only') return row.subjectType === 'session';
  return row.subjectType === 'agent' || row.subjectType === 'every_agent';
}

/**
 * True when this chat turned the account off for its agent: a current
 * override for this agent says detached, so no other grant counts here.
 *
 * @param override - The session's override for the account, if any.
 * @param agentId - The agent asked about.
 */
export function turnedOffHere(
  override: SessionGrantOverride | undefined,
  agentId: string
): boolean {
  const decision = overrideDecision(override, agentId);
  return decision.kind === 'denied' && decision.reason === 'detached';
}

/**
 * SQL predicate for every grant row that can speak for one agent, across all
 * accounts: its own named grants (and, with a session, that session's
 * grants), plus every-agent grants on accounts it was not left out of. Filter
 * the rows with {@link grantRowApplies} once the session's overrides are known.
 *
 * @param agentId - The agent asked about.
 * @param sessionId - The session it acts in, if any.
 */
export function agentGrantRowsSubject(agentId: string, sessionId?: string): SQL {
  const named = and(
    eq(connectionOperationGrants.subjectType, 'agent'),
    eq(connectionOperationGrants.subjectId, agentId)
  );
  return or(
    and(
      eq(connectionOperationGrants.agentId, agentId),
      sessionId
        ? or(
            named,
            and(
              eq(connectionOperationGrants.subjectType, 'session'),
              eq(connectionOperationGrants.subjectId, sessionId)
            )
          )
        : named
    ),
    everyAgentGrantFor(agentId)
  )!;
}

/**
 * Resolve the subject predicate for one agent's grants on one account in one
 * session, or the override that denies it. Combine the predicate with the
 * connection, revision and `revokedAt IS NULL` filters the caller needs.
 *
 * @param db - The database or open transaction to read the override from.
 * @param input - Agent, session and account.
 */
export function agentGrantScope(
  db: Db | DbTransaction,
  input: AgentGrantScopeInput
): AgentGrantScope {
  const namedAgent = and(
    eq(connectionOperationGrants.subjectType, 'agent'),
    eq(connectionOperationGrants.subjectId, input.agentId)
  )!;
  const override = input.sessionId
    ? db
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
        .get()
    : undefined;
  const decision = overrideDecision(override, input.agentId);
  if (decision.kind === 'denied') return decision;
  if (decision.kind === 'session_only') {
    return {
      kind: 'scope',
      subject: and(
        eq(connectionOperationGrants.subjectType, 'session'),
        eq(connectionOperationGrants.subjectId, input.sessionId!),
        eq(connectionOperationGrants.agentId, input.agentId)
      )!,
    };
  }
  return {
    kind: 'scope',
    subject: or(namedAgent, everyAgentGrantFor(input.agentId))!,
  };
}
