import type { OriginalRoomEmissionStage } from '../../canvas/doc-channel/current/current-operation-types.js';
import {
  requireOriginalRoomEmissionPrincipalPort,
  requireOriginalRoomEmissionFrameTransaction,
} from '../../canvas/doc-channel/operations/room-responder-operation.js';
import { readTestModeNativeOperation } from '../../runtimes/test-mode/test-mode-runtime.js';
import {
  readOriginalSnapshotPrincipalPort,
  openOriginalSnapshotNativeTurn,
} from '../../runtimes/connector-mcp/agent-identity-snapshots.js';
import { readCodexNativeOperation } from '../../runtimes/codex/codex-runtime.js';
import { readOpenCodeNativeOperation } from '../../runtimes/opencode/opencode-runtime.js';
import { readClaudeNativeOperation } from '../../runtimes/claude-code/claude-code-runtime.js';
import type { Db, DbTransaction, connectorRuntimeBindings } from '@dorkos/db';
import { createServerPrincipal, type ServerPrincipalProof } from './server-principal.js';
import type * as PrincipalData from '../runtime-principal-port.js';
type RuntimeBindingRow = typeof connectorRuntimeBindings.$inferSelect;

/** Create separate private custody per call. Main never exports its actual factory result. */
export function createIsolatedNativePrincipalCustody() {
  const nativePrincipalCores = new WeakMap<object, PrincipalData.NativePrincipalCore>();
  const resolvedRuntimePrincipals = new WeakMap<ServerPrincipalProof, object>();
  function resolvedRuntimePrincipal(
    service: object,
    claims: Extract<import('./server-principal.js').ServerPrincipalClaims, { kind: 'runtime' }>
  ): ServerPrincipalProof {
    const principal = createServerPrincipal(claims);
    resolvedRuntimePrincipals.set(principal, service);
    return principal;
  }
  /** Recognize a proof issued by this original credential resolver, not copied runtime claims. */
  function isOriginalResolvedRuntimePrincipal(
    service: object,
    principal: ServerPrincipalProof
  ): boolean {
    const issuer = resolvedRuntimePrincipals.get(principal);
    return (
      !!issuer &&
      originalNativePrincipalCore(issuer) === originalNativePrincipalCore(service) &&
      originalNativePrincipalCore(service) !== undefined
    );
  }

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
  function captureOriginalRoomEmissionPrincipal(
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
  function readOriginalRoomEmissionPrincipalBinding(
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
  function requireOriginalNativePrincipalService(port: object, service: object): void {
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
  function openOriginalNativeTurn(
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
  function requireNativePrincipalDatabase(service: object, db: Db): void {
    if (originalNativePrincipalCore(service)?.db !== db)
      throw new Error('Document native principal requires its exact owning database.');
  }
  /** Capture configured time in the owning read-only phase before any final row/currentness reads. */
  function captureNativePrincipalTime(
    service: object,
    db: Db,
    principal: ServerPrincipalProof
  ): number {
    requireNativePrincipalDatabase(service, db);
    return originalNativePrincipalCore(service)!.captureTime(principal);
  }
  /** Fixed constructor-owned SQL/native read; this does not accept a caller checker or mint actor authority. */
  function readCurrentNativePrincipal(
    service: object,
    db: Db,
    principal: ServerPrincipalProof,
    tx: DbTransaction | Db,
    time: number
  ): RuntimeBindingRow | undefined {
    return readCurrentNativePrincipalSource(service, db, principal, tx, time)?.binding;
  }

  /** Same successful native/lock/SQL read carries original private Room ancestry, never a binding-row reconstruction. */
  function readCurrentNativePrincipalSource(
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
  function captureOriginalPreparedNativeTime(service: object, db: Db, operation: object): number {
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
  function readOriginalPreparedNativePrincipal(
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

  /** Fixed owning-native gate for the genuine test/runtime entry; no caller Db, clock or checker. */
  function requireCurrentOriginalNativeTurn(service: object, operation: object): void {
    const own = originalNativePrincipalCore(service);
    if (!own || !own.recognizesPreparedOperation(operation) || own.db.$client.inTransaction)
      throw new Error('Original native operation is unavailable.');
    const time = captureOriginalPreparedNativeTime(service, own.db, operation);
    if (!readOriginalPreparedNativePrincipal(service, own.db, operation, time, own.db))
      throw new Error('Original native principal is no longer current.');
  }

  /** Resolve only the originally opened private SDK operation, never claims or a binding-row DTO. */
  function resolveOriginalNativePrincipal(
    service: object,
    operation: object
  ): Promise<PrincipalData.ResolveConnectorTurnResult> {
    const own = originalNativePrincipalCore(service);
    if (!own || !own.recognizesPreparedOperation(operation))
      return Promise.resolve({ status: 'refused', reason: 'revoked' });
    return own.resolveOriginal(operation);
  }

  /** Original service or original snapshot wrapper only; no structural principal port attestation. */
  function requireOriginalNativePrincipalPort(port: object): void {
    if (!originalNativePrincipalCore(port))
      throw new Error('Original native principal constructor is required.');
  }
  /** Require both native principal ports to resolve to the same original core. */
  function requireSameOriginalNativePrincipalPorts(first: object, second: object): void {
    const own = originalNativePrincipalCore(first);
    if (!own || originalNativePrincipalCore(second) !== own)
      throw new Error('TestMode requires the same original principal construction.');
  }

  /** Captured original revocation for this exact SDK entry; replacement public methods cannot skip the duty. */
  function retireOriginalNativeTurn(
    service: object,
    operation: object,
    reason: PrincipalData.RevokeConnectorTurnReason
  ): Promise<void> {
    const own = originalNativePrincipalCore(service);
    if (!own) throw new Error('Original native principal constructor is required.');
    return own.retireOriginal(operation, reason);
  }

  return Object.freeze({
    resolvedRuntimePrincipal,
    isOriginalResolvedRuntimePrincipal,
    captureOriginalRoomEmissionPrincipal,
    readOriginalRoomEmissionPrincipalBinding,
    requireOriginalNativePrincipalService,
    openOriginalNativeTurn,
    requireNativePrincipalDatabase,
    captureNativePrincipalTime,
    readCurrentNativePrincipal,
    readCurrentNativePrincipalSource,
    captureOriginalPreparedNativeTime,
    readOriginalPreparedNativePrincipal,
    requireCurrentOriginalNativeTurn,
    resolveOriginalNativePrincipal,
    requireOriginalNativePrincipalPort,
    requireSameOriginalNativePrincipalPorts,
    retireOriginalNativeTurn,
    nativeOperationData,
    registerCore: (owner: object, core: PrincipalData.NativePrincipalCore): void => {
      nativePrincipalCores.set(owner, core);
    },
    registerEmissionCapture: (
      core: PrincipalData.NativePrincipalCore,
      capture: NonNullable<ReturnType<typeof roomEmissionPrincipalCaptures.get>>
    ): void => {
      roomEmissionPrincipalCaptures.set(core, capture);
    },
  });
}
