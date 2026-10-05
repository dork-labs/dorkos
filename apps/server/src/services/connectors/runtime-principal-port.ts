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

declare const connectorTurnRenewalPermitBrand: unique symbol;

/** Opaque process-local proof that one exact runtime turn still owns its binding. */
export interface ConnectorTurnRenewalPermit {
  /** Compile-time brand; the service also requires exact object identity at runtime. */
  readonly [connectorTurnRenewalPermitBrand]: true;
}

/** Process-owned identity guard registered when a runtime turn opens. */
export interface ConnectorTurnOwnership {
  /** Whether the same adapter-owned turn object still occupies its active slot. */
  readonly isCurrent: () => boolean;
}

/** Opaque bearer and durable binding reference for one active runtime turn. */
export interface OpenConnectorTurnResult {
  /** Server-minted durable binding identifier. */
  readonly bindingId: string;
  /** Secret bearer accepted only by the internal connector projection. */
  readonly bearer: string;
  /** Absolute ISO 8601 expiry ceiling for the active turn. */
  readonly expiresAt: string;
  /** Process-local authority kept outside every serialization boundary. */
  readonly renewalPermit: ConnectorTurnRenewalPermit;
}

/** Inputs for renewing one unchanged runtime-turn binding. */
export interface RenewConnectorTurnInput {
  /** Exact durable binding opened for this turn. */
  readonly bindingId: string;
  /** Exact process-local permit returned with that binding. */
  readonly permit: ConnectorTurnRenewalPermit;
}

/** Terminal reason why a binding cannot be renewed. */
export type ConnectorTurnRenewalRefusalReason =
  'invalid' | 'expired' | 'revoked' | 'stale_boot' | 'authority_changed' | 'inactive_owner';

/** Result of one internal lease renewal attempt. */
export type RenewConnectorTurnResult =
  | { readonly status: 'renewed'; readonly expiresAt: string }
  | { readonly status: 'refused'; readonly reason: ConnectorTurnRenewalRefusalReason };

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
  openTurn(
    input: OpenConnectorTurnInput,
    ownership: ConnectorTurnOwnership
  ): Promise<OpenConnectorTurnResult>;
  /** Renew one unchanged binding through its exact process-owned permit. */
  renew(input: RenewConnectorTurnInput): Promise<RenewConnectorTurnResult>;
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

/**
 * What one thread key may ever stand for (ADR 261005-113107): one runtime, one
 * session, one working directory, inside one long-lived runtime process.
 */
export interface ConnectorThreadKeyScope {
  /** Runtime whose loaded thread carries the key. */
  readonly runtime: ConnectorRuntime;
  /** Canonical session the thread belongs to. */
  readonly canonicalSessionId: string;
  /** Canonical working directory the thread was loaded in. */
  readonly canonicalCwd: string;
  /** Opaque key of the runtime process holding the thread; revokes with it. */
  readonly processKey: string;
}

/** A freshly minted thread key. `key` is the secret; `keyId` is safe to log. */
export interface MintedConnectorThreadKey {
  /** Non-secret identifier for logs and lifecycle calls. */
  readonly keyId: string;
  /** Secret bearer, sent once in the thread's config and never persisted. */
  readonly key: string;
}

/** Why a thread key stopped existing. */
export type RevokeConnectorThreadKeyReason =
  'thread_unloaded' | 'process_exited' | 'shutdown' | 'superseded';

/**
 * Lifecycle of thread keys: the bearer a long-lived runtime process holds for
 * a loaded thread, which authorizes nothing by itself. Each turn attaches its
 * own turn binding to the key and detaches it when the turn ends; the listener
 * resolves the key to whichever binding is attached and refuses it when none
 * is. Memory only.
 */
export interface ConnectorThreadKeyPort {
  /** Mint a 256-bit key bound to one scope. */
  mint(scope: ConnectorThreadKeyScope): MintedConnectorThreadKey;
  /**
   * Attach the open turn's binding. Refuses (throws) a key that is unknown,
   * revoked, owned by another session, or still attached to another turn.
   */
  attach(keyId: string, binding: { bindingId: string; canonicalSessionId: string }): void;
  /** Detach a binding; a no-op unless that exact binding is attached. */
  detach(keyId: string, bindingId: string): void;
  /** Revoke one key for good. Idempotent. */
  revoke(keyId: string, reason: RevokeConnectorThreadKeyReason): void;
  /** Revoke every key minted for one runtime process. Idempotent. */
  revokeProcess(processKey: string, reason: RevokeConnectorThreadKeyReason): void;
}
