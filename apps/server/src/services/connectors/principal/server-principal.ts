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
import type {
  ConnectorOwnerAuthority,
  ServerPrincipalClaims,
  ServerPrincipalProof,
} from '../../core/connections-lease/index.js';

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
