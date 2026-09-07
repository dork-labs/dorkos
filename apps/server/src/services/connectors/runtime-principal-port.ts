/** Runtime-facing port for short-lived, turn-bound connector principals. */
import type { ServerPrincipalProof, ConnectorRuntime } from './principal/server-principal.js';

export type { ConnectorRuntime } from './principal/server-principal.js';

/** Canonical runtime context from which the server resolves live authority. */
export interface OpenConnectorTurnInput {
  /** Runtime opening the turn. */
  readonly runtime: ConnectorRuntime;
  /** Runtime-owned canonical session identifier. */
  readonly canonicalSessionId: string;
  /** Canonical path of the agent running the turn. */
  readonly agentPath: string;
  /** Canonical runtime working directory, when that runtime binds one. */
  readonly canonicalCwd?: string;
  /** Cancels setup before the binding becomes usable. */
  readonly signal: AbortSignal;
}

/** Opaque bearer and durable binding reference for one active runtime turn. */
export interface OpenConnectorTurnResult {
  /** Server-minted durable binding identifier. */
  readonly bindingId: string;
  /** Secret bearer accepted only by the internal connector projection. */
  readonly bearer: string;
  /** Absolute ISO 8601 expiry ceiling for the active turn. */
  readonly expiresAt: string;
}

/** Context an internal projection must match while resolving a bearer. */
export interface ResolveConnectorTurnInput {
  /** Secret bearer received by the internal connector projection. */
  readonly bearer: string;
  /** Runtime expected by the receiving adapter boundary. */
  readonly expectedRuntime: ConnectorRuntime;
  /** Canonical working directory expected by runtimes that bind one. */
  readonly expectedCanonicalCwd?: string;
}

/** Refusal reason kept internal and mapped to one external unauthorized response. */
export type ConnectorTurnRefusalReason =
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'wrong_runtime'
  | 'wrong_cwd'
  | 'stale_boot'
  | 'authority_changed';

/** Result of resolving a runtime bearer against current boot and live authority. */
export type ResolveConnectorTurnResult =
  | { readonly status: 'resolved'; readonly principal: ServerPrincipalProof }
  | { readonly status: 'refused'; readonly reason: ConnectorTurnRefusalReason };

/** Why a runtime turn binding stopped being usable. */
export type RevokeConnectorTurnReason =
  'turn_terminal' | 'turn_cancelled' | 'setup_failed' | 'runtime_failed';

/** Server-owned lifecycle for runtime connector authority. */
export interface ConnectorRuntimePrincipalPort {
  /** Open one binding after resolving live canonical runtime context. */
  openTurn(input: OpenConnectorTurnInput): Promise<OpenConnectorTurnResult>;
  /** Resolve one bearer and recheck current process and durable authority. */
  resolve(input: ResolveConnectorTurnInput): Promise<ResolveConnectorTurnResult>;
  /**
   * Revoke one binding on every terminal or failed runtime path. The binding
   * becomes unusable in this process before the durable write is attempted;
   * a rejected write therefore reports degraded persistence without restoring
   * bearer authority.
   */
  revoke(bindingId: string, reason: RevokeConnectorTurnReason): Promise<void>;
}

/** Boot barrier that invalidates bindings from every prior process generation. */
export interface ConnectorRuntimeBindingBootPort {
  /** Initialize this process generation before the internal listener is reachable. */
  initializeBoot(): Promise<{ readonly bootEpoch: string }>;
}
