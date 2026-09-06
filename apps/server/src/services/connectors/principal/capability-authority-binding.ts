/** Process-authenticated connector authorization bound to one parsed invocation. */

/** Indexed authority fields stored beside a connector approval. */
export interface ConnectorApprovalAuthorityScope {
  /** Stable digest over the complete live authority and parsed arguments. */
  readonly digest: string;
  /** Owner kind established by the server principal. */
  readonly ownerKind: 'user' | 'local_install';
  /** User or installation id established by the server principal. */
  readonly ownerId: string;
  /** Stable agent whose durable operation grant applies. */
  readonly agentId?: string;
  /** Canonical session whose exact authority applies, when present. */
  readonly sessionId?: string;
  /** Stable connection selected by the parsed invocation. */
  readonly connectionId: string;
  /** Immutable operation revision selected by the parsed invocation. */
  readonly operationRevisionId: string;
}

/** Authenticated process-local proof returned by connector preflight. */
export interface CapabilityAuthorityBindingProof {
  /** Indexed approval scope derived from the full live authorization decision. */
  readonly approvalScope: ConnectorApprovalAuthorityScope;
}

const authenticBindings = new WeakSet<object>();

/**
 * Mint a preflight binding after connector authorization has resolved every claim.
 *
 * Kept out of the connector service barrel. Only the authorization implementation
 * and its focused tests import this direct module; a digest alone cannot mint proof.
 *
 * @param scope - Complete indexed approval scope derived by live preflight.
 * @returns Immutable process-authenticated authority proof.
 */
export function createCapabilityAuthorityBinding(
  scope: ConnectorApprovalAuthorityScope
): CapabilityAuthorityBindingProof {
  const approvalScope = Object.freeze({ ...scope });
  const proof = Object.freeze({ approvalScope });
  authenticBindings.add(proof);
  return proof;
}

/**
 * Test process provenance for a connector authority binding.
 *
 * @param value - Candidate binding supplied to the registry.
 * @returns Whether the live authorization implementation minted it in this process.
 */
export function isCapabilityAuthorityBinding(
  value: unknown
): value is CapabilityAuthorityBindingProof {
  return typeof value === 'object' && value !== null && authenticBindings.has(value);
}
