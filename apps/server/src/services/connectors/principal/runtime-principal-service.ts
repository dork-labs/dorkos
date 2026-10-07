import type { OriginalRoomEmissionStage } from '../../canvas/doc-channel/current/current-operation-types.js';
import {
  requireOriginalRoomEmissionPrincipalPort,
  requireOriginalRoomEmissionFrameTransaction,
  readOriginalRoomEmissionRuntimeBindingRow,
} from '../../canvas/doc-channel/operations/room-responder-operation.js';
import { readTestModeNativeOperation } from '../../runtimes/test-mode/test-mode-runtime.js';
import {
  readOriginalSnapshotPrincipalPort,
  openOriginalSnapshotNativeTurn,
} from '../../runtimes/connector-mcp/agent-identity-snapshots.js';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
} from '../../session/session-lock.js';
import { readCodexNativeOperation } from '../../runtimes/codex/codex-runtime.js';
import { readOpenCodeNativeOperation } from '../../runtimes/opencode/opencode-runtime.js';
import { readClaudeNativeOperation } from '../../runtimes/claude-code/claude-code-runtime.js';
import {
  type DbTransaction,
  sql,
  and,
  connectorRuntimeBindings,
  eq,
  isNull,
  type Db,
} from '@dorkos/db';
/** Durable, boot-bound runtime principal service for the internal connector listener. */
import { randomBytes, randomUUID } from 'node:crypto';

import {
  createServerPrincipal,
  isServerPrincipal,
  type ServerPrincipalProof,
} from './server-principal.js';
import type { ConnectorThreadKeyResolver } from './thread-keys.js';

type RuntimeBindingRow = typeof connectorRuntimeBindings.$inferSelect;
import type * as PrincipalData from '../runtime-principal-port.js';
import {
  readCurrentRuntimeBindingRow,
  runtimeBearerHash as tokenHash,
  projectRuntimeBindingInsert,
  projectNativeOperationOwnData,
  projectOriginalNativeOwnerData,
  projectResolvedRuntimeBindingClaims,
  sameNativeEntryContext,
  requireRuntimeBindingBootData,
  ConnectorRuntimeAuthorityError,
  projectRuntimeBindingClaims,
  sameRuntimeBindingData,
  runtimeBindingMatchesClaims,
} from '../runtime-principal-port.js';
export {
  ConnectorRuntimeAuthorityError,
  type ConnectorRuntimeAuthority,
  type ConnectorRuntimeAuthorityResolver,
  type ConnectorRuntimePrincipalServiceOptions,
} from '../runtime-principal-port.js';

const nativePrincipalCores = new WeakMap<object, PrincipalData.NativePrincipalCore>();
const roomEmissionPrincipalCaptures = new WeakMap<
  PrincipalData.NativePrincipalCore,
  (
    operation: object,
    time: number,
    stage: OriginalRoomEmissionStage
  ) => (tx: DbTransaction, emitter: object) => RuntimeBindingRow | undefined
>();
const roomEmissionPrincipalReads = new WeakMap<
  OriginalRoomEmissionStage,
  {
    core: PrincipalData.NativePrincipalCore;
    operation: object;
    read: (tx: DbTransaction, emitter: object) => RuntimeBindingRow | undefined;
  }
>();
/** Fresh original native activity belongs only to the owner-created emission stage, never a restored DTO. */
export function captureOriginalRoomEmissionPrincipal(
  service: object,
  db: Db,
  operation: object,
  stage: OriginalRoomEmissionStage
): number {
  requireOriginalRoomEmissionPrincipalPort(stage, db, service);
  const core = originalNativePrincipalCore(service)!;
  const capture = roomEmissionPrincipalCaptures.get(core);
  if (!capture || db.$client.inTransaction)
    throw new Error('Original emission principal capture unavailable');
  const time = captureOriginalPreparedNativeTime(service, db, operation);
  requireOriginalRoomEmissionPrincipalPort(stage, db, service);
  const read = capture(operation, time, stage);
  roomEmissionPrincipalReads.set(stage, { core, operation, read });
  return time;
}
/** Repeated callback-free current row reads require the exact active engine-generated frame. */
export function readOriginalRoomEmissionPrincipalBinding(
  service: object,
  db: Db,
  operation: object,
  stage: OriginalRoomEmissionStage,
  tx: DbTransaction,
  emitter: object
): RuntimeBindingRow | undefined {
  requireOriginalRoomEmissionFrameTransaction(
    stage,
    db,
    tx,
    emitter as import('../../canvas/doc-channel/downstream/native-room-emitter.js').OriginalDownstreamRoomEmitter
  );
  requireOriginalRoomEmissionPrincipalPort(stage, db, service);
  const own = roomEmissionPrincipalReads.get(stage);
  if (!own || own.core !== originalNativePrincipalCore(service) || own.operation !== operation)
    throw new Error('Original emission principal activity unavailable');
  return own.read(tx, emitter);
}

function nativeOperationData(token: object) {
  const native =
    readCodexNativeOperation(token) ??
    readOpenCodeNativeOperation(token) ??
    readClaudeNativeOperation(token) ??
    readTestModeNativeOperation(token);
  if (!native?.agentPath) return undefined;
  return { ...native, agentPath: native.agentPath };
}
/** Recognize only the actual service or its genuine constructor-captured snapshot wrapper. */
export function requireOriginalNativePrincipalService(port: object, service: object): void {
  if (
    !nativePrincipalCores.has(service) ||
    (port !== service && readOriginalSnapshotPrincipalPort(port) !== service)
  )
    throw new Error('Native principal port does not belong to the original service.');
}
function originalNativePrincipalCore(port: object) {
  return (
    nativePrincipalCores.get(port) ??
    nativePrincipalCores.get(readOriginalSnapshotPrincipalPort(port) ?? {})
  );
}
/** Fixed original native setup. Structural ownership callbacks and public method replacements are not accepted. */
export function openOriginalNativeTurn(
  service: object,
  input: PrincipalData.OpenConnectorTurnInput,
  token: object
): Promise<PrincipalData.OpenConnectorTurnResult> {
  const own = originalNativePrincipalCore(service),
    native = nativeOperationData(token);
  if (
    !own ||
    !native ||
    native.runtime !== input.runtime ||
    native.canonicalSessionId !== input.canonicalSessionId ||
    native.agentPath !== input.agentPath ||
    native.canonicalCwd !== input.canonicalCwd ||
    native.signal !== input.signal
  )
    throw new Error('Native preparation requires its genuine original runtime entry.');
  if (!nativePrincipalCores.has(service))
    return openOriginalSnapshotNativeTurn(service, input, token);
  return own.open(input, token);
}
/** Construction attestation only; a caller cannot register a service or obtain its database. */
export function requireNativePrincipalDatabase(service: object, db: Db): void {
  if (originalNativePrincipalCore(service)?.db !== db)
    throw new Error('Document native principal requires its exact owning database.');
}
/** Capture configured time in the owning read-only phase before any final row/currentness reads. */
export function captureNativePrincipalTime(
  service: object,
  db: Db,
  principal: ServerPrincipalProof
): number {
  requireNativePrincipalDatabase(service, db);
  return originalNativePrincipalCore(service)!.captureTime(principal);
}
/** Fixed constructor-owned SQL/native read; this does not accept a caller checker or mint actor authority. */
export function readCurrentNativePrincipal(
  service: object,
  db: Db,
  principal: ServerPrincipalProof,
  tx: DbTransaction | Db,
  time: number
): RuntimeBindingRow | undefined {
  return readCurrentNativePrincipalSource(service, db, principal, tx, time)?.binding;
}

/** Same successful native/lock/SQL read carries original private Room ancestry, never a binding-row reconstruction. */
export function readCurrentNativePrincipalSource(
  service: object,
  db: Db,
  principal: ServerPrincipalProof,
  tx: DbTransaction | Db,
  time: number
) {
  requireNativePrincipalDatabase(service, db);
  return originalNativePrincipalCore(service)!.current(principal, tx, time);
}

/** Fixed configured-time phase for one constructor-recognized prepared native operation. */
export function captureOriginalPreparedNativeTime(
  service: object,
  db: Db,
  operation: object
): number {
  requireNativePrincipalDatabase(service, db);
  const own = originalNativePrincipalCore(service)!;
  if (!own.recognizesPreparedOperation(operation))
    throw new Error('Prepared native time requires the original native operation identity.');
  if (db.$client.inTransaction)
    throw new Error('Prepared native time requires its inactive owning database.');
  const time = own.captureTime(operation);
  if (db.$client.inTransaction || !own.recognizesPreparedOperation(operation))
    throw new Error(
      'Prepared native time lost its original operation after configured clock work.'
    );
  return time;
}
/** One-use native/lock/current boot/SQL read; no caller binding id or fabricated principal is accepted. */
export function readOriginalPreparedNativePrincipal(
  service: object,
  db: Db,
  operation: object,
  time: number,
  tx: DbTransaction | Db
): RuntimeBindingRow | undefined {
  requireNativePrincipalDatabase(service, db);
  const own = originalNativePrincipalCore(service)!;
  if (!own.recognizesPreparedOperation(operation)) return undefined;
  if (tx !== db || db.$client.inTransaction)
    throw new Error('Prepared native currentness requires its inactive owning database.');
  const binding = own.current(operation, db, time)?.binding;
  if (db.$client.inTransaction)
    throw new Error('Prepared native currentness entered SQL during its fixed read.');
  return own.recognizesPreparedOperation(operation) ? binding : undefined;
}

/** SQLite-backed implementation of the runtime principal and boot-barrier ports. */
export class ConnectorRuntimePrincipalService
  implements
    PrincipalData.ConnectorRuntimePrincipalPort,
    PrincipalData.ConnectorRuntimeBindingBootPort
{
  private readonly db: Db;
  private readonly authority: PrincipalData.ConnectorRuntimeAuthorityResolver;
  private readonly bindingTtlMs: number;
  private readonly now: () => Date;
  private readonly makeBootEpoch: () => string;
  private readonly makeBearer: () => string;
  private readonly threadKeys: ConnectorThreadKeyResolver | undefined;
  /** Process-local deny fence installed before a durable revoke can fail. */
  private readonly revokedBindingIds = new Set<string>();
  /** Exact permit and adapter-owned liveness predicate for each open turn. */
  private readonly renewalOwners = new Map<
    string,
    {
      readonly permit: PrincipalData.ConnectorTurnRenewalPermit;
      readonly ownership: PrincipalData.ConnectorTurnOwnership;
    }
  >();
  private bootEpoch?: string;
  readonly #nativeOwners = new Map<string, PrincipalData.NativePrincipalOwnerData>();
  #nativeBootEpoch?: string;
  readonly #fixedOpen: PrincipalData.FixedNativePrincipalOpenData;

  /**
   * Construct the runtime principal service.
   *
   * @param options - Database, canonical authority resolver, and bounded test seams.
   */
  constructor(options: PrincipalData.ConnectorRuntimePrincipalServiceOptions) {
    this.db = options.db;
    this.authority = options.authority;
    this.bindingTtlMs = options.bindingTtlMs ?? 4 * 60 * 60 * 1_000;
    this.now = options.now ?? (() => new Date());
    this.makeBootEpoch = options.makeBootEpoch ?? randomUUID;
    this.makeBearer = options.makeBearer ?? (() => randomBytes(32).toString('base64url'));
    const authority = this.authority,
      authorize = authority.authorizeTurn,
      originalNow = this.now,
      originalBearer = this.makeBearer,
      revalidate = authority.revalidateTurn;
    this.#fixedOpen = Object.freeze<PrincipalData.FixedNativePrincipalOpenData>({
      db: this.db,
      authorize: (input) => Reflect.apply(authorize, authority, [input]),
      now: () => Reflect.apply(originalNow, this, []),
      bearer: () => Reflect.apply(originalBearer, this, []),
      ttl: this.bindingTtlMs,
    });
    const originalRevoke = this.revoke;
    const db = this.db,
      now = this.now,
      revoked = this.revokedBindingIds;
    // Build once before public exposure; final reads use the captured own-native statement,
    // never a replaceable Db.select/query-builder chain after configured callbacks.
    const bindingStatement = db
      .select()
      .from(connectorRuntimeBindings)
      .where(eq(connectorRuntimeBindings.id, sql.placeholder('bindingId')))
      .prepare();
    const getBinding = bindingStatement.get;
    const activities = new WeakMap<object, PrincipalData.NativePrincipalActivityData>();
    const originalFor = (identity: object) => {
      if (isServerPrincipal(identity))
        return identity.claims.kind === 'runtime'
          ? this.#nativeOwners.get(identity.claims.bindingId)
          : undefined;
      return [...this.#nativeOwners.values()].find((own) => own.token === identity);
    };
    const core: PrincipalData.NativePrincipalCore = {
      db,
      retireOriginal: async (operation, reason) => {
        const original = [...this.#nativeOwners.values()].find((own) => own.token === operation);
        if (original)
          await Reflect.apply(originalRevoke, this, [original.claims.bindingId, reason]);
      },
      resolveOriginal: async (operation) => {
        const original = [...this.#nativeOwners.values()].find((own) => own.token === operation);
        if (!original || db.$client.inTransaction) return { status: 'refused', reason: 'revoked' };
        const claims = original.claims;
        if (!(await Reflect.apply(revalidate, authority, [claims])))
          return { status: 'refused', reason: 'authority_changed' };
        // The configured policy/clock may retire or replace this exact entry.
        const time = captureOriginalPreparedNativeTime(this, db, operation);
        const row = readOriginalPreparedNativePrincipal(this, db, operation, time, db);
        if (!row || this.#nativeOwners.get(claims.bindingId) !== original)
          return { status: 'refused', reason: 'revoked' };
        return { status: 'resolved', principal: createServerPrincipal(claims) };
      },
      recognizesPreparedOperation: (operation) =>
        [...this.#nativeOwners.values()].some((own) => own.token === operation),
      open: (input, token) =>
        this.#openTurn(input, {
          isCurrent: () => !!nativeOperationData(token),
          nativeOperation: token,
        }),
      captureTime: (identity) => {
        activities.delete(identity);
        const original = originalFor(identity);
        const time = now().getTime();
        const live =
          original && originalFor(identity) === original
            ? nativeOperationData(original.token)
            : undefined;
        const acquisition = live?.acquisition;
        if (original && acquisition) {
          const activity = captureNativeSessionActivity(acquisition, time);
          if (activity && originalFor(identity) === original)
            activities.set(identity, { time, acquisition, activity, original });
        }
        return time;
      },
      current: (identity, _executor, time) => {
        const captured = activities.get(identity);
        activities.delete(identity);
        const original = originalFor(identity);
        if (!Number.isFinite(time) || !original || captured?.original !== original)
          return undefined;
        const claims =
          isServerPrincipal(identity) && identity.claims.kind === 'runtime'
            ? identity.claims
            : original.claims;
        if (revoked.has(claims.bindingId)) return undefined;
        const live = nativeOperationData(original.token);
        if (
          !captured ||
          captured.time !== time ||
          live?.acquisition !== captured.acquisition ||
          !readNativeSessionAcquisition(
            captured.acquisition,
            captured.activity,
            time,
            claims.canonicalSessionId
          )
        )
          return undefined;
        if (!sameNativeEntryContext(live, original, claims.canonicalSessionId)) return undefined;
        const binding = readCurrentRuntimeBindingRow(
          Reflect.apply(getBinding, bindingStatement, [{ bindingId: claims.bindingId }]),
          claims,
          time,
          this.#nativeBootEpoch
        );
        return binding &&
          originalFor(identity) === original &&
          !revoked.has(claims.bindingId) &&
          nativeOperationData(original.token)?.acquisition === captured.acquisition
          ? Object.freeze({ binding, roomCustody: live.roomCustody })
          : undefined;
      },
    };
    nativePrincipalCores.set(this, core);
    roomEmissionPrincipalCaptures.set(core, (operation, time, stage) => {
      const captured = activities.get(operation);
      activities.delete(operation);
      const original = originalFor(operation);
      if (!captured || captured.original !== original || captured.time !== time || !original)
        throw new Error('Original emission native activity unavailable');
      const claims = original.claims;
      return (tx, emitter) => {
        const live = nativeOperationData(original.token);
        if (
          originalFor(operation) !== original ||
          revoked.has(claims.bindingId) ||
          live?.acquisition !== captured.acquisition ||
          !readNativeSessionAcquisition(
            captured.acquisition,
            captured.activity,
            time,
            claims.canonicalSessionId
          ) ||
          !sameNativeEntryContext(live, original, claims.canonicalSessionId)
        )
          return undefined;
        const raw = readOriginalRoomEmissionRuntimeBindingRow(
          stage,
          db,
          tx,
          emitter as import('../../canvas/doc-channel/downstream/native-room-emitter.js').OriginalDownstreamRoomEmitter,
          claims.bindingId
        );
        const row = raw
          ? ({
              id: raw.id,
              tokenHash: raw.token_hash,
              bootEpoch: raw.boot_epoch,
              ownerKind: raw.owner_kind,
              ownerId: raw.owner_id,
              runtime: raw.runtime,
              canonicalSessionId: raw.canonical_session_id,
              agentId: raw.agent_id,
              agentPath: raw.agent_path,
              canonicalCwd: raw.canonical_cwd,
              createdAt: raw.created_at,
              expiresAt: raw.expires_at,
              revokedAt: raw.revoked_at,
              revokeReason: raw.revoke_reason,
            } as RuntimeBindingRow)
          : undefined;
        const binding = readCurrentRuntimeBindingRow(row, claims, time, this.#nativeBootEpoch);
        return binding &&
          originalFor(operation) === original &&
          !revoked.has(claims.bindingId) &&
          nativeOperationData(original.token)?.acquisition === captured.acquisition
          ? binding
          : undefined;
      };
    });
    this.threadKeys = options.threadKeys;
  }

  /** Revoke every prior-process binding and establish the current boot epoch. */
  async initializeBoot(): Promise<{ readonly bootEpoch: string }> {
    const now = this.now().toISOString();
    const bootEpoch = this.makeBootEpoch();
    this.db
      .update(connectorRuntimeBindings)
      .set({ revokedAt: now, revokeReason: 'server_restart' })
      .where(isNull(connectorRuntimeBindings.revokedAt))
      .run();
    this.revokedBindingIds.clear();
    this.renewalOwners.clear();
    this.bootEpoch = bootEpoch;
    this.#nativeBootEpoch = bootEpoch;
    this.#nativeOwners.clear();
    return Promise.resolve({ bootEpoch });
  }

  /** Open one bearer after resolving live canonical runtime authority. */
  async openTurn(
    input: PrincipalData.OpenConnectorTurnInput,
    ownership: PrincipalData.ConnectorTurnOwnership
  ): Promise<PrincipalData.OpenConnectorTurnResult> {
    return this.#openTurn(input, ownership);
  }

  async #openTurn(
    input: PrincipalData.OpenConnectorTurnInput,
    ownership: PrincipalData.ConnectorTurnOwnership
  ): Promise<PrincipalData.OpenConnectorTurnResult> {
    input.signal.throwIfAborted();
    const bootEpoch = this.requireBootEpoch();
    let resolved: PrincipalData.ConnectorRuntimeAuthority;
    try {
      resolved = await this.#fixedOpen.authorize(input);
    } catch {
      input.signal.throwIfAborted();
      throw new ConnectorRuntimeAuthorityError(
        'authority_refused',
        'DorkOS couldn’t confirm this chat can use connected apps. Start a new turn and try again.'
      );
    }
    input.signal.throwIfAborted();
    if (!ownership.isCurrent()) {
      throw new ConnectorRuntimeAuthorityError(
        'authority_refused',
        'DorkOS couldn’t confirm this chat can use connected apps. Start a new turn and try again.'
      );
    }

    const bindingId = randomUUID();
    const bearer = this.#fixedOpen.bearer();
    const createdAt = this.#fixedOpen.now();
    const expiresAt = new Date(createdAt.getTime() + this.#fixedOpen.ttl);
    this.#fixedOpen.db
      .insert(connectorRuntimeBindings)
      .values(
        projectRuntimeBindingInsert(
          input,
          resolved,
          bindingId,
          bearer,
          bootEpoch,
          createdAt,
          expiresAt
        )
      )
      .run();
    const renewalPermit = Object.freeze({}) as PrincipalData.ConnectorTurnRenewalPermit;
    this.renewalOwners.set(bindingId, { permit: renewalPermit, ownership });
    const nativeToken = projectNativeOperationOwnData(ownership);
    const native = nativeToken ? nativeOperationData(nativeToken) : undefined;
    if (nativeToken && sameNativeEntryContext(native, input, input.canonicalSessionId)) {
      this.#nativeOwners.set(
        bindingId,
        projectOriginalNativeOwnerData(input, resolved, bindingId, nativeToken)
      );
    }
    return { bindingId, bearer, expiresAt: expiresAt.toISOString(), renewalPermit };
  }

  /** Renew only while the exact process-owned turn and durable claims remain current. */
  async renew(
    input: PrincipalData.RenewConnectorTurnInput
  ): Promise<PrincipalData.RenewConnectorTurnResult> {
    const owner = this.renewalOwners.get(input.bindingId);
    if (!owner || owner.permit !== input.permit) {
      return { status: 'refused', reason: 'invalid' };
    }
    if (!owner.ownership.isCurrent()) {
      this.denyForInactiveOwner(input.bindingId);
      return { status: 'refused', reason: 'inactive_owner' };
    }

    const initial = this.bindingRow(input.bindingId);
    if (!initial) return { status: 'refused', reason: 'invalid' };
    const initialRefusal = this.bindingRefusal(initial);
    if (initialRefusal) return { status: 'refused', reason: initialRefusal };
    const claims = projectRuntimeBindingClaims(initial);
    if (!(await this.authority.revalidateTurn(claims))) {
      this.denyForAuthorityChange(initial.id);
      return { status: 'refused', reason: 'authority_changed' };
    }

    // Everything from this fresh read through the SQLite CAS is synchronous.
    // No callback can replace the active turn or cross expiry between the final
    // process and durable fences and the update.
    const current = this.bindingRow(input.bindingId);
    if (!current) return { status: 'refused', reason: 'invalid' };
    const currentRefusal = this.bindingRefusal(current);
    if (currentRefusal) return { status: 'refused', reason: currentRefusal };
    if (!sameRuntimeBindingData(initial, current)) {
      return { status: 'refused', reason: 'authority_changed' };
    }
    const currentOwner = this.renewalOwners.get(input.bindingId);
    if (
      !currentOwner ||
      currentOwner.permit !== input.permit ||
      this.revokedBindingIds.has(input.bindingId)
    ) {
      return { status: 'refused', reason: 'revoked' };
    }
    if (!currentOwner.ownership.isCurrent()) {
      this.denyForInactiveOwner(input.bindingId);
      return { status: 'refused', reason: 'inactive_owner' };
    }

    const renewedAt = this.now().getTime();
    if (Date.parse(current.expiresAt) <= renewedAt) {
      return { status: 'refused', reason: 'expired' };
    }
    const expiresAt = new Date(
      Math.max(Date.parse(current.expiresAt), renewedAt + this.bindingTtlMs)
    ).toISOString();
    const changed = this.db
      .update(connectorRuntimeBindings)
      .set({ expiresAt })
      .where(
        and(
          eq(connectorRuntimeBindings.id, current.id),
          eq(connectorRuntimeBindings.expiresAt, current.expiresAt),
          eq(connectorRuntimeBindings.bootEpoch, current.bootEpoch),
          isNull(connectorRuntimeBindings.revokedAt)
        )
      )
      .run().changes;
    if (changed === 1) return { status: 'renewed', expiresAt };

    const committed = this.bindingRow(input.bindingId);
    const committedOwner = this.renewalOwners.get(input.bindingId);
    if (
      committed &&
      !this.bindingRefusal(committed) &&
      sameRuntimeBindingData(current, committed) &&
      committedOwner?.permit === input.permit &&
      committedOwner.ownership.isCurrent()
    ) {
      return { status: 'renewed', expiresAt: committed.expiresAt };
    }
    return { status: 'refused', reason: 'revoked' };
  }

  /**
   * Resolve a bearer against current process, context, expiry, and live authority.
   *
   * A thread key (ADR 261005-113107) is first turned into the turn binding
   * attached to it right now; with none attached it is refused exactly as an
   * expired bearer is. From there both kinds take the same checks, plus one: the
   * binding must belong to the session the key was minted for.
   */
  async resolve(
    input: PrincipalData.ResolveConnectorTurnInput
  ): Promise<PrincipalData.ResolveConnectorTurnResult> {
    if (this.threadKeys?.isThreadKey(input.bearer)) return this.resolveThreadKey(input);
    const row = this.db
      .select()
      .from(connectorRuntimeBindings)
      .where(eq(connectorRuntimeBindings.tokenHash, tokenHash(input.bearer)))
      .get();
    if (!row) return { status: 'refused', reason: 'invalid' };
    return this.resolveRow(row, input);
  }

  private async resolveThreadKey(
    input: PrincipalData.ResolveConnectorTurnInput
  ): Promise<PrincipalData.ResolveConnectorTurnResult> {
    const key = this.threadKeys?.lookup(input.bearer);
    if (!key) return { status: 'refused', reason: 'invalid' };
    if (key.scope.runtime !== input.expectedRuntime) {
      return { status: 'refused', reason: 'wrong_runtime' };
    }
    if (key.scope.canonicalCwd !== input.expectedCanonicalCwd) {
      return { status: 'refused', reason: 'wrong_cwd' };
    }
    // Between turns: the key authorizes nothing.
    if (key.bindingId === undefined) return { status: 'refused', reason: 'expired' };
    const row = this.bindingRow(key.bindingId);
    if (!row || row.canonicalSessionId !== key.scope.canonicalSessionId) {
      return { status: 'refused', reason: 'invalid' };
    }
    const result = await this.resolveRow(row, input);
    // The turn may have ended while the authority check awaited.
    if (
      result.status === 'resolved' &&
      this.threadKeys?.lookup(input.bearer)?.bindingId !== row.id
    ) {
      return { status: 'refused', reason: 'expired' };
    }
    return result;
  }

  private async resolveRow(
    row: RuntimeBindingRow,
    input: PrincipalData.ResolveConnectorTurnInput
  ): Promise<PrincipalData.ResolveConnectorTurnResult> {
    const initialRefusal = this.bindingRefusal(row);
    if (initialRefusal) return { status: 'refused', reason: initialRefusal };
    if (row.runtime !== input.expectedRuntime) {
      return { status: 'refused', reason: 'wrong_runtime' };
    }
    if ((row.canonicalCwd ?? undefined) !== input.expectedCanonicalCwd) {
      return { status: 'refused', reason: 'wrong_cwd' };
    }
    if (!this.hasCurrentOwner(row.id)) {
      return { status: 'refused', reason: 'revoked' };
    }

    const claims = projectResolvedRuntimeBindingClaims(row);
    if (!(await this.authority.revalidateTurn(claims))) {
      this.denyForAuthorityChange(row.id);
      return { status: 'refused', reason: 'authority_changed' };
    }
    const current = this.bindingRow(row.id);
    if (!current) return { status: 'refused', reason: 'invalid' };
    const currentRefusal = this.bindingRefusal(current);
    if (currentRefusal) return { status: 'refused', reason: currentRefusal };
    if (!sameRuntimeBindingData(row, current)) {
      return { status: 'refused', reason: 'authority_changed' };
    }
    if (!this.hasCurrentOwner(row.id)) {
      return { status: 'refused', reason: 'revoked' };
    }
    return { status: 'resolved', principal: createServerPrincipal(claims) };
  }

  /** Check the authentic current boot binding and its live turn owner without awaiting. */
  isPrincipalCurrent(principal: ServerPrincipalProof): boolean {
    if (!isServerPrincipal(principal) || principal.claims.kind !== 'runtime') return false;
    const claims = principal.claims;
    const row = this.bindingRow(claims.bindingId);
    return Boolean(
      row &&
      !this.bindingRefusal(row) &&
      runtimeBindingMatchesClaims(row, claims) &&
      this.hasCurrentOwner(claims.bindingId)
    );
  }

  /** Recheck live authority and repeat the synchronous gate after it awaits. */
  async revalidatePrincipal(principal: ServerPrincipalProof): Promise<boolean> {
    if (!this.isPrincipalCurrent(principal) || principal.claims.kind !== 'runtime') return false;
    const claims = principal.claims;
    if (await this.authority.revalidateTurn(claims)) return this.isPrincipalCurrent(principal);
    this.denyForAuthorityChange(claims.bindingId);
    return false;
  }

  /** Revoke one binding on a terminal, cancelled, setup-failed, or runtime-failed path. */
  async revoke(bindingId: string, reason: PrincipalData.RevokeConnectorTurnReason): Promise<void> {
    this.renewalOwners.delete(bindingId);
    this.revokedBindingIds.add(bindingId);
    this.db
      .update(connectorRuntimeBindings)
      .set({ revokedAt: this.now().toISOString(), revokeReason: reason })
      .where(
        and(eq(connectorRuntimeBindings.id, bindingId), isNull(connectorRuntimeBindings.revokedAt))
      )
      .run();
  }

  private bindingRow(bindingId: string): RuntimeBindingRow | undefined {
    return this.db
      .select()
      .from(connectorRuntimeBindings)
      .where(eq(connectorRuntimeBindings.id, bindingId))
      .get();
  }

  private denyForAuthorityChange(bindingId: string): void {
    this.renewalOwners.delete(bindingId);
    this.revokedBindingIds.add(bindingId);
    this.db
      .update(connectorRuntimeBindings)
      .set({ revokedAt: this.now().toISOString(), revokeReason: 'authority_changed' })
      .where(
        and(eq(connectorRuntimeBindings.id, bindingId), isNull(connectorRuntimeBindings.revokedAt))
      )
      .run();
  }

  private denyForInactiveOwner(bindingId: string): void {
    this.renewalOwners.delete(bindingId);
    this.revokedBindingIds.add(bindingId);
    this.db
      .update(connectorRuntimeBindings)
      .set({ revokedAt: this.now().toISOString(), revokeReason: 'turn_cancelled' })
      .where(
        and(eq(connectorRuntimeBindings.id, bindingId), isNull(connectorRuntimeBindings.revokedAt))
      )
      .run();
  }

  private hasCurrentOwner(bindingId: string): boolean {
    const owner = this.renewalOwners.get(bindingId);
    if (owner?.ownership.isCurrent()) return true;
    this.denyForInactiveOwner(bindingId);
    return false;
  }

  private bindingRefusal(row: RuntimeBindingRow): 'revoked' | 'stale_boot' | 'expired' | undefined {
    if (!this.bootEpoch || row.bootEpoch !== this.bootEpoch) return 'stale_boot';
    if (this.revokedBindingIds.has(row.id) || row.revokedAt) return 'revoked';
    if (Date.parse(row.expiresAt) <= this.now().getTime()) return 'expired';
    return undefined;
  }

  private requireBootEpoch(): string {
    return requireRuntimeBindingBootData(this.bootEpoch);
  }
}

/** Fixed owning-native gate for the genuine test/runtime entry; no caller Db, clock or checker. */
export function requireCurrentOriginalNativeTurn(service: object, operation: object): void {
  const own = originalNativePrincipalCore(service);
  if (!own || !own.recognizesPreparedOperation(operation) || own.db.$client.inTransaction)
    throw new Error('Original native operation is unavailable.');
  const time = captureOriginalPreparedNativeTime(service, own.db, operation);
  if (!readOriginalPreparedNativePrincipal(service, own.db, operation, time, own.db))
    throw new Error('Original native principal is no longer current.');
}

/** Resolve only the originally opened private SDK operation, never claims or a binding-row DTO. */
export function resolveOriginalNativePrincipal(
  service: object,
  operation: object
): Promise<PrincipalData.ResolveConnectorTurnResult> {
  const own = originalNativePrincipalCore(service);
  if (!own || !own.recognizesPreparedOperation(operation))
    return Promise.resolve({ status: 'refused', reason: 'revoked' });
  return own.resolveOriginal(operation);
}

/** Original service or original snapshot wrapper only; no structural principal port attestation. */
export function requireOriginalNativePrincipalPort(port: object): void {
  if (!originalNativePrincipalCore(port))
    throw new Error('Original native principal constructor is required.');
}
/** Require both native principal ports to resolve to the same original core. */
export function requireSameOriginalNativePrincipalPorts(first: object, second: object): void {
  const own = originalNativePrincipalCore(first);
  if (!own || originalNativePrincipalCore(second) !== own)
    throw new Error('TestMode requires the same original principal construction.');
}

/** Captured original revocation for this exact SDK entry; replacement public methods cannot skip the duty. */
export function retireOriginalNativeTurn(
  service: object,
  operation: object,
  reason: PrincipalData.RevokeConnectorTurnReason
): Promise<void> {
  const own = originalNativePrincipalCore(service);
  if (!own) throw new Error('Original native principal constructor is required.');
  return own.retireOriginal(operation, reason);
}
