/**
 * Who may make an account decision about the install's connections: the
 * boundary every connector route group asks before it changes or reveals
 * anything that belongs to the owner.
 *
 * Only a person at the DorkOS app clears it: never a program (any
 * program credential header: Authorization, X-API-Key or Proxy-Authorization), an agent (an `X-DorkOS-Agent` header, verified or
 * not) or a caller holding an approval token, and never a page on an origin
 * this server does not serve. With login on it takes the owner's browser
 * session, so another signed-in account and an API key are refused too.
 *
 * Shared by the management, notification, resource and execution groups, so
 * "the owner asked" means one thing across all of `/api/connectors`.
 *
 * @module routes/connector-owner-boundary
 */
import type { Context, MiddlewareHandler } from 'hono';
import { problem, problemBody, sendProblem } from '@dorkos/http-kit';
import type { Problem, ProblemCode } from '@dorkos/shared/problem';
import { ACCOUNT_DECISION_OWNER_ONLY } from '@dorkos/shared/capabilities';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import {
  accountDecisionBar,
  accountDecisionSentence,
  ACCOUNT_DECISION_SENTENCES,
  fromForeignOrigin,
  presentsMachineSignal as machineSignalIn,
  type AccountDecisionPolicy,
} from '../lib/http/account-decision-bar.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import type { ConnectorOwnerAuthority } from '../services/core/connections-lease/index.js';
import type { ConnectorRegistry } from '../services/connectors/registry.js';

/**
 * Dependencies for the connector owner-management HTTP boundary: the
 * account-decision bar's policy (`lib/http/account-decision-bar.ts`).
 */
export type ConnectorOwnerBoundaryDeps = AccountDecisionPolicy;

/** What a signed-in non-owner reads at every connection route. */
export const CONNECTIONS_OWNER_ONLY = ACCOUNT_DECISION_OWNER_ONLY[0];

/** The identity the session gate proved for this request, if any. */
export function requestUser(c: Context<ApiEnv>): RequestUser | undefined {
  return c.get('user');
}

/**
 * The 403 problem every owner refusal answers with.
 *
 * @param c - The Hono context.
 * @param code - Why the caller was refused: a 403 code.
 * @param detail - What the person reads.
 * @returns The response.
 */
export function ownerRefusal(
  c: Context<ApiEnv>,
  code: Extract<ProblemCode, 'forbidden' | 'origin_not_allowed' | 'person_only' | 'owner_only'>,
  detail: string
): Response {
  return problem(c, code, { detail });
}

/**
 * The 401 for a caller whose account owner DorkOS could not work out.
 *
 * @param c - The Hono context.
 * @returns The response.
 */
export function ownerUnverified(c: Context<ApiEnv>): Response {
  return problem(c, 'unauthenticated', { detail: ACCOUNT_DECISION_SENTENCES['owner-unknown'] });
}

/**
 * The refusal for a page on an origin this server does not serve, if it is one.
 *
 * @param c - The Hono context.
 * @param deps - The trusted-origin policy.
 * @returns The 403, or `undefined` when the origin is absent or trusted.
 */
export function untrustedOriginRefusal(
  c: Context<ApiEnv>,
  deps: Pick<ConnectorOwnerBoundaryDeps, 'trustedOrigins'>
): Response | undefined {
  if (!fromForeignOrigin(honoRequestFacts(c), deps)) return undefined;
  return ownerRefusal(c, 'origin_not_allowed', ACCOUNT_DECISION_SENTENCES['foreign-origin']);
}

/**
 * Whether the request carries an agent identity or an approval token: a
 * machine signal, never a person.
 *
 * @param c - The Hono context.
 */
export function presentsMachineSignal(c: Context<ApiEnv>): boolean {
  return machineSignalIn(honoRequestFacts(c));
}

/**
 * Resolve a browser/local operator while refusing program, agent, and approval-token callers,
 * and, with login on, any signed-in account that does not own this install: the
 * account-decision bar (`lib/http/account-decision-bar.ts`), the same function the
 * capability mount runs, answered as a problem.
 *
 * @param c - The Hono context, carrying the session gate's verified user.
 * @param deps - Deployment owner and login/origin policy.
 * @returns The server-owned connector owner, or the refusal to answer with.
 */
export function resolveConnectorOperator(
  c: Context<ApiEnv>,
  deps: ConnectorOwnerBoundaryDeps
): ConnectorOwnerAuthority | Response {
  const outcome = accountDecisionBar(honoRequestFacts(c), deps);
  if (outcome.ok) return outcome.owner;
  const { code, which } = outcome.refusal;
  return problem(c, code, { detail: accountDecisionSentence(which, CONNECTIONS_OWNER_ONLY) });
}

/**
 * The 503 every connector route answers while the connector store's migration
 * has failed, or `undefined` while it is healthy. The capability mount runs it
 * first for a capability that declares `http.precheck: 'connector-store'`.
 *
 * @param registry - The connector migration health.
 * @returns The problem, or `undefined`.
 */
export function connectorStoreUnavailable(
  registry: Pick<ConnectorRegistry, 'migrationHealth'>
): Problem | undefined {
  // `health.error` names the failed step; it is in the startup log, never here.
  if (registry.migrationHealth().status !== 'migration_failed') return undefined;
  return problemBody('temporarily_unavailable', {
    detail: 'Connected apps didn’t start. Restart DorkOS, then try again.',
  });
}

/**
 * Answer 503 for every request while the connector store's migration has
 * failed, as each connector group did ahead of its routes.
 *
 * @param registry - The connector migration health.
 * @returns The middleware.
 */
export function migrationHealthGate(
  registry: Pick<ConnectorRegistry, 'migrationHealth'>
): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const unavailable = connectorStoreUnavailable(registry);
    if (unavailable) return sendProblem(c, unavailable);
    await next();
  };
}

/**
 * A signal that fires when the client goes away before the answer is sent.
 *
 * @param c - The Hono context.
 * @returns The signal, and a function to stop listening once the work is done.
 */
export function requestAbortSignal(c: Context<ApiEnv>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const { incoming } = c.env;
  incoming.once('aborted', abort);
  return { signal: controller.signal, dispose: () => incoming.off('aborted', abort) };
}
