import type { ConnectorThreadKeyResolver } from './principal/thread-keys.js';
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { NativeSessionAcquisition, NativeSessionActivity } from '../session/session-lock.js';
import type { OriginalRoomDispatchCustody } from '../rooms/service/room-core.js';
/** Runtime-facing port for short-lived, turn-bound connector principals. */
import {
  type ServerPrincipalProof,
  type ServerPrincipalClaims,
  type ConnectorRuntime,
  type ConnectorOwnerAuthority,
} from './principal/server-principal.js';

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
  /** Actual runtime-only operation identity; legacy callers cannot confer F2 authority. */
  readonly nativeOperation?: object;
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

/** Project the original owner columns used by runtime binding checks. */
export function runtimeOwnerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

/** Read runtime binding owner DATA from its native row. */
export function runtimeRowOwner(row: {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
}): ConnectorOwnerAuthority {
  return row.ownerKind === 'user'
    ? { kind: 'user', userId: row.ownerId }
    : { kind: 'local_install', installationId: row.ownerId };
}

import { connectorRuntimeBindings, type Db, type DbTransaction } from '@dorkos/db';
/** Pure checked binding-row projection only. Native/boot/principal issuance and ownership stay in the genuine service. */
export function readCurrentRuntimeBindingRow(
  row: typeof connectorRuntimeBindings.$inferSelect | undefined,
  claims: Extract<ServerPrincipalProof['claims'], { kind: 'runtime' }>,
  time: number,
  bootEpoch: string | undefined
): typeof connectorRuntimeBindings.$inferSelect | undefined {
  if (!row) return undefined;
  return row.revokedAt === null &&
    row.bootEpoch === bootEpoch &&
    row.runtime === claims.runtime &&
    row.canonicalSessionId === claims.canonicalSessionId &&
    row.agentId === claims.agentId &&
    row.agentPath === claims.agentPath &&
    row.canonicalCwd === claims.canonicalCwd &&
    row.ownerKind === claims.owner.kind &&
    row.ownerId ===
      (claims.owner.kind === 'user' ? claims.owner.userId : claims.owner.installationId) &&
    Number.isFinite(Date.parse(row.expiresAt)) &&
    Date.parse(row.expiresAt) > time
    ? row
    : undefined;
}

/** Live server authority resolved from canonical runtime context. */
export interface ConnectorRuntimeAuthority {
  /** Owner whose grants may be used during the turn. */
  readonly owner: ConnectorOwnerAuthority;
  /** Stable agent identity bound to the canonical path. */
  readonly agentId: string;
}

/** Canonical identity resolver kept outside runtime-controlled inputs. */
export interface ConnectorRuntimeAuthorityResolver {
  /** Resolve and authorize a new turn from canonical server/runtime state. */
  authorizeTurn(input: OpenConnectorTurnInput): Promise<ConnectorRuntimeAuthority>;
  /** Recheck the exact stored claims before every connector projection call. */
  revalidateTurn(claims: Extract<ServerPrincipalClaims, { kind: 'runtime' }>): Promise<boolean>;
}

/** Typed setup refusal mapped by the runtime boundary without exposing private claims. */
export class ConnectorRuntimeAuthorityError extends Error {
  /** Stable internal refusal code. */
  readonly code: 'boot_not_initialized' | 'authority_refused';

  /**
   * Construct a safe runtime authority error.
   *
   * @param code - Stable setup refusal category.
   * @param message - Secret-free diagnostic.
   */
  constructor(code: ConnectorRuntimeAuthorityError['code'], message: string) {
    super(message);
    this.name = 'ConnectorRuntimeAuthorityError';
    this.code = code;
  }
}

/** Construction options for the durable runtime principal service. */
export interface ConnectorRuntimePrincipalServiceOptions {
  /** Canonical DorkOS database. */
  readonly db: Db;
  /** Resolver that owns canonical runtime/session/agent identity checks. */
  readonly authority: ConnectorRuntimeAuthorityResolver;
  /** Maximum binding lifetime in milliseconds. */
  readonly bindingTtlMs?: number;
  /** Injectable clock for deterministic expiry tests. */
  readonly now?: () => Date;
  /** Injectable process-generation source for deterministic boot tests. */
  readonly makeBootEpoch?: () => string;
  /** Injectable bearer source for deterministic hashing tests. */
  readonly makeBearer?: () => string;
  /** Resolve a loaded thread key to its currently attached turn binding. */
  readonly threadKeys?: ConnectorThreadKeyResolver;
}

/** Data captured in the configured-time phase; the owner service retains the private activity map. */
export interface NativePrincipalActivityData {
  time: number;
  acquisition: NativeSessionAcquisition;
  activity: NativeSessionActivity;
  original: NativePrincipalOwnerData;
}

export interface NativePrincipalCore {
  readonly retireOriginal: (operation: object, reason: RevokeConnectorTurnReason) => Promise<void>;
  readonly resolveOriginal: (operation: object) => Promise<ResolveConnectorTurnResult>;
  readonly recognizesPreparedOperation: (operation: object) => boolean;
  readonly open: (input: OpenConnectorTurnInput, token: object) => Promise<OpenConnectorTurnResult>;
  readonly db: Db;
  readonly captureTime: (principal: ServerPrincipalProof | object) => number;
  readonly current: (
    principal: ServerPrincipalProof | object,
    tx: DbTransaction | Db,
    time: number
  ) =>
    | Readonly<{
        binding: typeof connectorRuntimeBindings.$inferSelect;
        roomCustody?: OriginalRoomDispatchCustody;
      }>
    | undefined;
}

export interface NativePrincipalOwnerData {
  claims: Extract<ServerPrincipalClaims, { kind: 'runtime' }>;
  token: object;
  runtime: OpenConnectorTurnInput['runtime'];
  signal: AbortSignal;
  agentPath: string;
  canonicalCwd?: string;
}

export interface FixedNativePrincipalOpenData {
  db: Db;
  authorize: (input: OpenConnectorTurnInput) => Promise<ConnectorRuntimeAuthority>;
  now: () => Date;
  bearer: () => string;
  ttl: number;
}

/** Project runtime binding claims from the original row DATA. */
export function projectRuntimeBindingClaims(
  row: typeof connectorRuntimeBindings.$inferSelect
): Extract<ServerPrincipalClaims, { kind: 'runtime' }> {
  return {
    kind: 'runtime',
    owner: runtimeRowOwner(row),
    bindingId: row.id,
    runtime: row.runtime,
    canonicalSessionId: row.canonicalSessionId,
    agentId: row.agentId,
    agentPath: row.agentPath,
    ...(row.canonicalCwd && { canonicalCwd: row.canonicalCwd }),
  };
}

/** Compare the retained runtime binding DATA fields. */
export function sameRuntimeBindingData(
  left: typeof connectorRuntimeBindings.$inferSelect,
  right: typeof connectorRuntimeBindings.$inferSelect
): boolean {
  return (
    left.tokenHash === right.tokenHash &&
    left.bootEpoch === right.bootEpoch &&
    left.ownerKind === right.ownerKind &&
    left.ownerId === right.ownerId &&
    left.runtime === right.runtime &&
    left.canonicalSessionId === right.canonicalSessionId &&
    left.agentId === right.agentId &&
    left.agentPath === right.agentPath &&
    left.canonicalCwd === right.canonicalCwd
  );
}

/** Compare current runtime binding DATA with the retained claims. */
export function runtimeBindingMatchesClaims(
  row: typeof connectorRuntimeBindings.$inferSelect,
  claims: Extract<ServerPrincipalClaims, { kind: 'runtime' }>
): boolean {
  return (
    row.runtime === claims.runtime &&
    row.canonicalSessionId === claims.canonicalSessionId &&
    row.agentId === claims.agentId &&
    row.agentPath === claims.agentPath &&
    (row.canonicalCwd ?? undefined) === claims.canonicalCwd &&
    row.ownerKind === claims.owner.kind &&
    row.ownerId === runtimeOwnerColumns(claims.owner).ownerId
  );
}

/** Pure legacy resolver data projection, including its conditional cwd own-property. */
export function projectResolvedRuntimeBindingClaims(
  row: typeof connectorRuntimeBindings.$inferSelect
) {
  return {
    kind: 'runtime',
    owner: runtimeRowOwner(row),
    bindingId: row.id,
    runtime: row.runtime,
    canonicalSessionId: row.canonicalSessionId,
    agentId: row.agentId,
    agentPath: row.agentPath,
    ...(row.canonicalCwd && { canonicalCwd: row.canonicalCwd }),
  } as const;
}
/** Pure bearer projection; no registration, database or principal issuance. */
export function runtimeBearerHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
/** Literal immutable-row data projection before the original owning insert. */
export function projectRuntimeBindingInsert(
  input: OpenConnectorTurnInput,
  resolved: ConnectorRuntimeAuthority,
  bindingId: string,
  bearer: string,
  bootEpoch: string,
  createdAt: Date,
  expiresAt: Date
) {
  return {
    id: bindingId,
    tokenHash: runtimeBearerHash(bearer),
    bootEpoch,
    ...runtimeOwnerColumns(resolved.owner),
    runtime: input.runtime,
    canonicalSessionId: input.canonicalSessionId,
    agentId: resolved.agentId,
    agentPath: input.agentPath,
    canonicalCwd: input.canonicalCwd,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}
/** Own-data extraction only; the owning service separately recognizes actual native membership. */
export function projectNativeOperationOwnData(
  ownership: ConnectorTurnOwnership
): object | undefined {
  const nativeDescriptor = nodeTypes.isProxy(ownership)
    ? undefined
    : Object.getOwnPropertyDescriptor(ownership, 'nativeOperation');
  return nativeDescriptor &&
    'value' in nativeDescriptor &&
    typeof nativeDescriptor.value === 'object' &&
    nativeDescriptor.value !== null
    ? nativeDescriptor.value
    : undefined;
}
/** Immutable data shape only; callers cannot install it into the original private owner map. */
export function projectOriginalNativeOwnerData(
  input: OpenConnectorTurnInput,
  resolved: ConnectorRuntimeAuthority,
  bindingId: string,
  nativeToken: object
): NativePrincipalOwnerData {
  return {
    claims: Object.freeze({
      kind: 'runtime',
      bindingId,
      owner: Object.freeze({ ...resolved.owner }),
      runtime: input.runtime,
      canonicalSessionId: input.canonicalSessionId,
      agentId: resolved.agentId,
      agentPath: input.agentPath,
      canonicalCwd: input.canonicalCwd,
    }),
    token: nativeToken,
    runtime: input.runtime,
    signal: input.signal,
    agentPath: input.agentPath,
    canonicalCwd: input.canonicalCwd,
  };
}

/** Literal data equality only; no native identity, currentness, principal or opening is issued. */
export function sameNativeEntryContext(
  native:
    | Pick<
        OpenConnectorTurnInput,
        'runtime' | 'canonicalSessionId' | 'agentPath' | 'canonicalCwd' | 'signal'
      >
    | undefined,
  original: Pick<OpenConnectorTurnInput, 'runtime' | 'agentPath' | 'canonicalCwd' | 'signal'>,
  canonicalSessionId: string
): boolean {
  return (
    !!native &&
    native.canonicalSessionId === canonicalSessionId &&
    native.runtime === original.runtime &&
    native.signal === original.signal &&
    native.agentPath === original.agentPath &&
    native.canonicalCwd === original.canonicalCwd
  );
}

/** Literal boot-data validation/error projection, not proof of current constructor ownership. */
export function requireRuntimeBindingBootData(bootEpoch: string | undefined): string {
  if (!bootEpoch) {
    throw new ConnectorRuntimeAuthorityError(
      'boot_not_initialized',
      'DorkOS is still starting, so connected apps aren’t ready yet. Try again in a moment.'
    );
  }
  return bootEpoch;
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
