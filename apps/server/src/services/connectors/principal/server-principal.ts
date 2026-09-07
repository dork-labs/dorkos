/**
 * Process-authenticated principal carried from a verified server boundary into
 * connector authorization.
 *
 * The claims are intentionally readable by policy code, while authenticity is
 * held in a module-private WeakSet. A JSON round-trip or structurally identical
 * object therefore cannot become authority.
 *
 * @module lib/server-principal
 */

/** Installation or signed-in account that owns connector authority. */
export type ConnectorOwnerAuthority =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'local_install'; readonly installationId: string };

/** Supported runtime adapters that may receive a turn-bound connector principal. */
export type ConnectorRuntime = 'claude-code' | 'codex' | 'opencode';

/** Verified identity and execution context for one server-side caller. */
export type ServerPrincipalClaims =
  | { readonly kind: 'operator'; readonly owner: ConnectorOwnerAuthority }
  | {
      readonly kind: 'program';
      readonly owner: ConnectorOwnerAuthority;
      readonly credentialId: string;
    }
  | {
      readonly kind: 'agent';
      readonly owner: ConnectorOwnerAuthority;
      readonly agentId: string;
      readonly agentPath: string;
    }
  | {
      readonly kind: 'runtime';
      readonly owner: ConnectorOwnerAuthority;
      readonly bindingId: string;
      readonly runtime: ConnectorRuntime;
      readonly canonicalSessionId: string;
      readonly agentId: string;
      readonly agentPath: string;
      readonly canonicalCwd?: string;
    }
  | {
      readonly kind: 'bridged';
      readonly owner: ConnectorOwnerAuthority;
      readonly platform: string;
      readonly platformUserId: string;
    };

/** Authenticated process-local proof of server-derived principal claims. */
export interface ServerPrincipalProof {
  /** Claims resolved by the verified caller boundary. */
  readonly claims: ServerPrincipalClaims;
}

const authenticPrincipals = new WeakSet<object>();

/**
 * Mint an authenticated principal after a server boundary has verified the
 * supplied claims.
 *
 * This function authenticates provenance inside this process; it does not
 * verify credentials or durable connector grants. Callers must do that before
 * minting, and connector preflight rechecks live authority afterwards.
 *
 * @param claims - Claims already resolved by a verified server boundary.
 * @returns An immutable process-authenticated principal proof.
 */
export function createServerPrincipal(claims: ServerPrincipalClaims): ServerPrincipalProof {
  const owner = Object.freeze({ ...claims.owner }) as ConnectorOwnerAuthority;
  const frozenClaims = Object.freeze({ ...claims, owner }) as ServerPrincipalClaims;
  const proof = Object.freeze({ claims: frozenClaims });
  authenticPrincipals.add(proof);
  return proof;
}

/**
 * Test whether a value was minted by {@link createServerPrincipal} in this
 * process.
 *
 * @param value - Candidate principal proof.
 * @returns Whether the candidate carries authentic process provenance.
 */
export function isServerPrincipal(value: unknown): value is ServerPrincipalProof {
  return typeof value === 'object' && value !== null && authenticPrincipals.has(value);
}
