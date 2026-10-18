/**
 * Exposure guard — refuse to make a DorkOS instance reachable beyond localhost
 * without a real login (accounts-and-auth P1, task 1.3).
 *
 * The tunnel passcode used to be the only thing standing between "localhost
 * only" and "anyone on the network". This guard replaces that role with a
 * single, hard rule: an instance may be exposed (an ngrok tunnel, or a
 * non-loopback `app.listen` bind) only when an owner account exists.
 *
 * The owner is the whole requirement, not "Ask for a password on this computer
 * too": the gate asks every request from another device for a person session
 * whatever that setting says (`gate-policy.ts`, ADR 261015-125850 rule 3), so
 * what exposure needs is someone those devices can sign in as. The client's
 * owner-setup flow routes the operator into account creation via the
 * {@link AUTH_REQUIRED_FOR_EXPOSURE} contract.
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
 * the reader ({@link readExposureState}) pulls from the auth `user` table, so they mock cleanly without a live DB.
 *
 * @module services/core/auth/exposure-guard
 */
import { isLoopbackHost } from '../../../lib/trusted-origins.js';
import { hasAnyUser } from './index.js';
import { isAgentComputer } from '../server-role/role-checks.js';

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

/** The fact the exposure decision depends on. */
export interface ExposureState {
  /** Whether at least one user (owner) account exists in the auth `user` table. */
  hasUsers: boolean;
}

/**
 * Pure predicate: exposure beyond localhost is allowed only when an owner
 * account exists.
 *
 * @param state - The resolved {@link ExposureState}.
 * @returns `true` when the instance may be exposed, `false` otherwise.
 */
export function isExposureAllowed(state: ExposureState): boolean {
  return state.hasUsers === true;
}

/**
 * Read the live {@link ExposureState} from the auth `user` table. The read is
 * synchronous (a better-sqlite3 `.get()`), so this is safe on a route
 * handler's hot path.
 */
export function readExposureState(): ExposureState {
  return { hasUsers: hasAnyUser() };
}

/**
 * Whether the instance may currently be exposed beyond localhost. Convenience
 * over `isExposureAllowed(readExposureState())` for the tunnel enforcement
 * points, Wi-Fi access and managed remote access. Never on an agent computer
 * (DOR-2940), which is reached only by the agents running on it, so none of
 * them ever opens there.
 */
export function canExpose(): boolean {
  if (isAgentComputer()) return false;
  return isExposureAllowed(readExposureState());
}

// ---------- Non-loopback bind check ----------
//
// "Which host names mean this machine" is defined once, in
// `lib/trusted-origins.ts`, and shared with the `/api` host guard.

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
  /**
   * Whether this server is a hub. A hub binds beyond loopback before it has an
   * owner: its login is always on and only provisioning can make an account,
   * so nobody can reach it unsigned-in, owner or not.
   */
  hub?: boolean;
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
    `exposes DorkOS beyond this machine, but no owner account exists for other ` +
    `devices to sign in as.\n` +
    `Create the owner account first, then restart:\n` +
    `  - run \`dorkos auth enable\`, or\n` +
    `  - open DorkOS on this computer and create the owner account in Settings > Login & security.\n` +
    `If this host is intentionally isolated (e.g. a container that owns the ` +
    `network boundary), set DORKOS_ALLOW_INSECURE_BIND=true to override.`
  );
}

/** Warning logged when a non-loopback bind is permitted only by the escape hatch. */
function insecureBindWarning(host: string): string {
  return (
    `⚠️ Binding to non-loopback host "${host}" with no owner account because ` +
    `DORKOS_ALLOW_INSECURE_BIND=true. Until an owner account exists, anyone who ` +
    `reaches this port gets full control. Create the owner now. A coming release ` +
    `will ask for a one-time setup code printed here instead.`
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
  if (input.hub === true) return { allowed: true };
  if (input.allowInsecureBind) return { allowed: true, warning: insecureBindWarning(input.host) };
  return { allowed: false, reason: bindRefusalMessage(input.host) };
}

// ---------- A2A gateway exposure check ----------

/** Inputs to {@link checkA2aExposure}. */
export interface A2aExposureInput {
  /** The host `app.listen` will bind to (`env.DORKOS_HOST`). */
  host: string;
  /**
   * Whether a network-reachable credential gates the A2A surface: `MCP_API_KEY`,
   * the legacy `config.mcp.apiKey` compat key, or an owner account (every
   * request from another device then needs that account's key). The local
   * token (DOR-278) gates JSON-RPC execution too, but it is loopback-only
   * (a `0600` file a remote caller cannot read), so it does not count here — this
   * flag governs whether A2A may mount on a non-loopback bind.
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
    `  - create an owner account (run \`dorkos auth enable\`, or Settings > Login & security).\n` +
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
