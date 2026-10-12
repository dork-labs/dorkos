/**
 * Who may make an account decision about the install's connections: the
 * boundary every connector route group asks before it changes or reveals
 * anything that belongs to the owner.
 *
 * Only a person at the DorkOS app clears it: never a program (any
 * `Authorization` header), an agent (an `X-DorkOS-Agent` header, verified or
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
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { resolveTrustedOrigins } from '../lib/trusted-origins.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { isInstallOwner } from '../services/core/auth/install-owner.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/index.js';
import type { ConnectorOwnerAuthority } from '../services/connectors/principal/server-principal.js';
import type { ConnectorRegistry } from '../services/connectors/registry.js';

/** Dependencies for the connector owner-management HTTP boundary. */
export interface ConnectorOwnerBoundaryDeps {
  /** Resolve the current deployment's owner from verified server state. */
  readonly resolveOwner: (user: RequestUser | undefined) => ConnectorOwnerAuthority | undefined;
  /** Read the live login posture; injected for deterministic route evidence. */
  readonly loginEnabled: () => boolean;
  /** Exact DorkOS browser origins; defaults to the server-owned static set. */
  readonly trustedOrigins?: () => readonly string[];
  /**
   * Whether a signed-in account owns this install; defaults to the shared
   * `isInstallOwner`. Injected for deterministic route evidence.
   */
  readonly isAccountOwner?: (user: RequestUser | undefined) => boolean;
}

/** The identity the session gate proved for this request, if any. */
export function requestUser(c: Context<ApiEnv>): RequestUser | undefined {
  return c.get('user');
}

/**
 * The 403 every owner refusal answers with.
 *
 * @param c - The Hono context.
 * @param code - Why the caller was refused.
 * @param message - What the person reads.
 * @returns The response.
 */
export function ownerRefusal(c: Context<ApiEnv>, code: string, message: string): Response {
  return c.json({ error: message, code, message }, 403);
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
  const origin = c.env.incoming.headers.origin;
  const trustedOrigins = deps.trustedOrigins?.() ?? resolveTrustedOrigins();
  if (!origin || trustedOrigins.includes(origin)) return undefined;
  return ownerRefusal(
    c,
    'connector_owner_origin_required',
    'Open this account action from the DorkOS app.'
  );
}

/**
 * Whether the request carries an agent identity or an approval token: a
 * machine signal, never a person.
 *
 * @param c - The Hono context.
 */
export function presentsMachineSignal(c: Context<ApiEnv>): boolean {
  return (
    presentsAgentIdentity(honoRequestFacts(c)) ||
    c.env.incoming.headers[APPROVAL_TOKEN_HEADER] !== undefined
  );
}

/**
 * Resolve a browser/local operator while refusing program, agent, and approval-token callers,
 * and, with login on, any signed-in account that does not own this install.
 *
 * @param c - The Hono context, carrying the session gate's verified user.
 * @param deps - Deployment owner and login/origin policy.
 * @returns The server-owned connector owner, or the refusal to answer with.
 */
export function resolveConnectorOperator(
  c: Context<ApiEnv>,
  deps: ConnectorOwnerBoundaryDeps
): ConnectorOwnerAuthority | Response {
  const originRefusal = untrustedOriginRefusal(c, deps);
  if (originRefusal) return originRefusal;
  if (presentsMachineSignal(c) || c.env.incoming.headers.authorization !== undefined) {
    return ownerRefusal(
      c,
      'connector_owner_required',
      'Programs and agents cannot make account decisions.'
    );
  }
  const user = requestUser(c);
  if (deps.loginEnabled() && user?.credential !== 'cookie') {
    return ownerRefusal(
      c,
      'operator_cookie_required',
      'Sign in to the DorkOS app to make this account decision.'
    );
  }
  // Connections reach their apps through this computer's DorkOS account, so
  // with login on they are the owner's alone, never another signed-in
  // account's (DOR-2678) — the same owner `/api/cloud/*` asks for.
  if (deps.loginEnabled() && !(deps.isAccountOwner ?? isInstallOwner)(user)) {
    return ownerRefusal(
      c,
      'owner_only',
      'Only the owner of this DorkOS can manage the connections on its DorkOS account.'
    );
  }
  const owner = deps.resolveOwner(user);
  if (!owner) return c.json({ error: 'DorkOS could not verify who owns this account.' }, 401);
  return owner;
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
    const health = registry.migrationHealth();
    if (health.status === 'migration_failed') {
      return c.json({ status: health.status, error: health.error }, 503);
    }
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
