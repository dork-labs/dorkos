/**
 * The shapes of a process-authenticated principal carried from a verified
 * server boundary into connector authorization.
 *
 * Only the types live here. Minting a principal and checking that one is
 * authentic stay with the space side (`services/connectors/principal/server-principal.ts`).
 *
 * @module services/core/connections-lease/principal-types
 */

/** Installation or signed-in account that owns connector authority. */
export type ConnectorOwnerAuthority =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'local_install'; readonly installationId: string };

/** Supported runtime adapters that may receive a turn-bound connector principal. */
export type ConnectorRuntime = 'claude-code' | 'codex' | 'opencode' | 'doe' | 'computer-local';

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
