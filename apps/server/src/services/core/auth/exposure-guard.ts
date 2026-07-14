/**
 * Exposure guard — refuse to make a DorkOS instance reachable beyond localhost
 * without a real login (accounts-and-auth P1, task 1.3).
 *
 * The tunnel passcode used to be the only thing standing between "localhost
 * only" and "anyone on the network". This guard replaces that role with a
 * single, hard rule: an instance may be exposed (an ngrok tunnel, or a
 * non-loopback `app.listen` bind) only when local login is enabled AND an owner
 * account exists. Every other combination blocks.
 *
 * Requiring BOTH facts is deliberate. `auth.enabled: false` means the session
 * gate never runs, so even with users on disk the API is open — exposure must
 * stay blocked until the flag is on. The client's enable-login flow (task 1.5)
 * makes flipping it one step, routing the operator into owner-account creation
 * via the {@link AUTH_REQUIRED_FOR_EXPOSURE} contract.
 *
 * Two enforcement points consume this module:
 * - **Tunnel start** (`routes/tunnel.ts`) and the boot-time tunnel autostart
 *   (`index.ts`) call {@link canExpose} and block/skip on `false`.
 * - **Non-loopback bind** (`index.ts`) calls {@link checkBindAllowed} before
 *   `app.listen` and refuses to start (a hard gate) when the host is public and
 *   the guard fails.
 *
 * Everything here is pure and injectable: the predicates
 * ({@link isExposureAllowed}, {@link checkBindAllowed}) take plain facts, and
 * the readers ({@link readExposureState}) pull from `configManager` and the auth
 * `user` table, so they mock cleanly without a live DB.
 *
 * @module services/core/auth/exposure-guard
 */
import { configManager } from '../config-manager.js';
import { hasAnyUser } from './index.js';

/**
 * The error code returned (409) and logged when exposure is blocked. This is the
 * contract the client (task 1.5) matches on to route the operator into
 * owner-account creation from the tunnel settings flow. Do not change it without
 * updating the client.
 */
export const AUTH_REQUIRED_FOR_EXPOSURE = 'AUTH_REQUIRED_FOR_EXPOSURE';

/** The user-facing message paired with {@link AUTH_REQUIRED_FOR_EXPOSURE}. */
export const EXPOSURE_REQUIRES_LOGIN_MESSAGE =
  'Exposing DorkOS requires a login. Create an owner account first.';

/** The two facts the exposure decision depends on. */
export interface ExposureState {
  /** Whether local login (the request gate) is enabled (`config.auth.enabled`). */
  authEnabled: boolean;
  /** Whether at least one user (owner) account exists in the auth `user` table. */
  hasUsers: boolean;
}

/**
 * Pure predicate: exposure beyond localhost is allowed only when login is enabled
 * AND an owner account exists. Every other combination blocks.
 *
 * @param state - The resolved {@link ExposureState}.
 * @returns `true` when the instance may be exposed, `false` otherwise.
 */
export function isExposureAllowed(state: ExposureState): boolean {
  return state.authEnabled === true && state.hasUsers === true;
}

/**
 * Read the live {@link ExposureState} from the config store and the auth `user`
 * table. Both reads are synchronous (`configManager.get` and a better-sqlite3
 * `.get()`), so this is safe on a route handler's hot path.
 */
export function readExposureState(): ExposureState {
  return {
    authEnabled: configManager.get('auth')?.enabled === true,
    hasUsers: hasAnyUser(),
  };
}

/**
 * Whether the instance may currently be exposed beyond localhost. Convenience
 * over `isExposureAllowed(readExposureState())` for the tunnel enforcement points.
 */
export function canExpose(): boolean {
  return isExposureAllowed(readExposureState());
}

// ---------- Non-loopback bind check ----------

/** Hosts that are loopback-only and therefore never require a login to bind. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Whether a bind host is loopback-only (reachable only from this machine).
 * `0.0.0.0` and any other address are treated as public (non-loopback).
 *
 * @param host - The host `app.listen` will bind to (`env.DORKOS_HOST`).
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** Inputs to {@link checkBindAllowed}. */
export interface BindCheckInput {
  /** The host `app.listen` will bind to (`env.DORKOS_HOST`). */
  host: string;
  /** Whether the exposure guard currently allows exposure ({@link canExpose}). */
  exposureAllowed: boolean;
  /**
   * The `DORKOS_ALLOW_INSECURE_BIND` escape hatch: when `true`, a non-loopback
   * bind is permitted without a login (a warning is logged). Set by container
   * images (the `integration` and `runtime` targets of the root `Dockerfile`)
   * that bind `0.0.0.0` because the container — not the DorkOS process — owns
   * the network boundary.
   */
  allowInsecureBind: boolean;
}

/** Result of {@link checkBindAllowed}. */
export interface BindCheckResult {
  /** Whether the server may bind to the requested host. */
  allowed: boolean;
  /** When blocked, an actionable operator-facing error naming the fix. */
  reason?: string;
  /** When allowed only via the insecure-bind escape hatch, a warning to log. */
  warning?: string;
}

/**
 * Build the actionable error printed when a non-loopback bind is refused.
 *
 * @param host - The offending non-loopback host.
 */
export function bindRefusalMessage(host: string): string {
  return (
    `Refusing to start: DORKOS_HOST is "${host}", a non-loopback address that ` +
    `exposes DorkOS beyond this machine, but login is not configured.\n` +
    `Enable login first, then restart:\n` +
    `  - run \`dorkos auth enable\`, or\n` +
    `  - open Settings > Security and turn on "Require login" (create an owner account).\n` +
    `If this host is intentionally isolated (e.g. a container that owns the ` +
    `network boundary), set DORKOS_ALLOW_INSECURE_BIND=true to override.`
  );
}

/** Warning logged when a non-loopback bind is permitted only by the escape hatch. */
function insecureBindWarning(host: string): string {
  return (
    `Binding to non-loopback host "${host}" without a login because ` +
    `DORKOS_ALLOW_INSECURE_BIND=true. DorkOS is reachable from the network with ` +
    `no credentials — ensure the surrounding environment restricts access.`
  );
}

/**
 * Decide whether the server may bind to `input.host`. A loopback host always
 * binds. A non-loopback (public) host binds only when the exposure guard passes
 * or the {@link BindCheckInput.allowInsecureBind} escape hatch is set; otherwise
 * it is refused with an actionable {@link BindCheckResult.reason}.
 *
 * Pure and unit-testable: callers pass the resolved facts, so no server is bound.
 *
 * @param input - The host, the exposure decision, and the escape-hatch flag.
 */
export function checkBindAllowed(input: BindCheckInput): BindCheckResult {
  if (isLoopbackHost(input.host)) return { allowed: true };
  if (input.exposureAllowed) return { allowed: true };
  if (input.allowInsecureBind) return { allowed: true, warning: insecureBindWarning(input.host) };
  return { allowed: false, reason: bindRefusalMessage(input.host) };
}

// ---------- A2A gateway exposure check ----------

/** Inputs to {@link checkA2aExposure}. */
export interface A2aExposureInput {
  /** The host `app.listen` will bind to (`env.DORKOS_HOST`). */
  host: string;
  /**
   * Whether anything gates the A2A surface: `MCP_API_KEY`, the legacy
   * `config.mcp.apiKey` compat key, or login enabled (any of these makes
   * `mcpApiKeyAuth` reject anonymous requests instead of passing through).
   */
  authConfigured: boolean;
  /** The `DORKOS_ALLOW_INSECURE_BIND` escape hatch (see {@link BindCheckInput}). */
  allowInsecureBind: boolean;
}

/** Result of {@link checkA2aExposure}. Shape mirrors {@link BindCheckResult}. */
export interface A2aExposureResult {
  /** Whether the A2A gateway (and its discovery cards) may be mounted. */
  allowed: boolean;
  /** When refused, an actionable operator-facing error naming the fix. */
  reason?: string;
  /** When allowed only via the insecure-bind escape hatch, a warning to log. */
  warning?: string;
}

/**
 * Build the actionable error logged when the A2A mount is refused.
 *
 * @param host - The offending non-loopback host.
 */
export function a2aRefusalMessage(host: string): string {
  return (
    `Refusing to mount the A2A gateway: DORKOS_HOST is "${host}", a non-loopback ` +
    `address, and the A2A surface has no authentication configured. Mounting it would ` +
    `expose remote prompt execution against every registered agent (and the agent-card ` +
    `discovery endpoints, which list agent names and descriptions) to the network.\n` +
    `Enable auth for the A2A surface, then restart:\n` +
    `  - set MCP_API_KEY=<secret> (A2A clients send it as \`Authorization: Bearer <secret>\`), or\n` +
    `  - enable login (run \`dorkos auth enable\`, or Settings > Security > "Require login").\n` +
    `If this host is intentionally isolated (e.g. a container that owns the network ` +
    `boundary), DORKOS_ALLOW_INSECURE_BIND=true also permits the mount.`
  );
}

/** Warning logged when an unauthenticated A2A mount is permitted only by the escape hatch. */
function insecureA2aWarning(host: string): string {
  return (
    `Mounting the A2A gateway on non-loopback host "${host}" with no authentication ` +
    `because DORKOS_ALLOW_INSECURE_BIND=true. Anyone who can reach this host can run ` +
    `prompts against every registered agent — ensure the surrounding environment ` +
    `restricts access.`
  );
}

/**
 * Decide whether the A2A gateway (JSON-RPC endpoints plus the well-known
 * agent-card mounts) may be mounted. On a loopback host it always mounts
 * (local-first zero-config, ADR-0030 spirit). On a non-loopback host it
 * mounts only when some credential gates it ({@link A2aExposureInput.authConfigured})
 * or the insecure-bind escape hatch is set; otherwise it is refused with an
 * actionable {@link A2aExposureResult.reason}.
 *
 * Pure and unit-testable: callers pass the resolved facts.
 *
 * @param input - The host, the auth-configured fact, and the escape-hatch flag.
 */
export function checkA2aExposure(input: A2aExposureInput): A2aExposureResult {
  if (isLoopbackHost(input.host)) return { allowed: true };
  if (input.authConfigured) return { allowed: true };
  if (input.allowInsecureBind) return { allowed: true, warning: insecureA2aWarning(input.host) };
  return { allowed: false, reason: a2aRefusalMessage(input.host) };
}
