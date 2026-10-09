import { CanvasChannelGrantSchema } from '@dorkos/shared/canvas-channel-schemas';
import { queueCommittedDocEvent } from '../committed-events.js';
import { readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { appendDocEventsContext } from '../../../session/context-assembler.js';
import {
  requireClaudeOriginalRelayPreparedTuple,
  readOriginalClaudeRelayProjectedTurnStart,
  driveClaudeOriginalRelayDocument,
  stopClaudeOriginalRelayDocumentDrive,
  readOriginalClaudeRelayClosedTurn,
  readOriginalClaudeRelayClosedTurnData,
} from '../../../runtimes/claude-code/claude-code-runtime.js';
import type { PreparedRelayDocumentResponder } from './relay-native-types.js';
import {
  consumeServerNativeRelayConstruction,
  type ServerNativeRelayConstruction,
  type FixedNativeRelayFacts,
  type OriginalRelayNativeFacts,
  type OriginalRelayNativeClaim,
} from '@dorkos/db/internal-server';
import {
  requireOriginalNativePrincipalPort,
  requireNativePrincipalDatabase,
  requireSameOriginalNativePrincipalPorts,
  requireCurrentOriginalNativeTurn,
  resolveOriginalNativePrincipal,
} from '../../../connectors/principal/runtime-principal-service.js';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';
import type { OriginalFrozenRelayDocumentSource } from './relay-native-types.js';
/** Constructor-owned availability is an observation, never a source/claim token. */
const originalRelayAvailability = new WeakMap<
  object,
  (
    target: {
      scope: string;
      sessionId: string | null;
      agentId: string | null;
      runtime: string | null;
      agentPath: string | null;
    },
    openerAgentId: string | null
  ) => string | undefined
>();
/** Require the actual installed protected transport and explicit current opener ACL. */
export function readOriginalDocumentRelayAvailability(
  grants: object,
  target: {
    scope: string;
    sessionId: string | null;
    agentId: string | null;
    runtime: string | null;
    agentPath: string | null;
  },
  openerAgentId: string | null
): string | undefined {
  const read = originalRelayAvailability.get(grants);
  return read ? read(target, openerAgentId) : 'relay_disabled';
}
const originalRelayGenericClaimGuards = new WeakMap<
  Db,
  (tx: DbTransaction, id: string) => boolean
>();
/** Refusal fence only: native source ownership cannot be claimed by a generic dispatcher. */
export function originalRelayReceiptNeedsNativeDispatch(
  db: Db,
  tx: DbTransaction,
  id: string
): boolean {
  return originalRelayGenericClaimGuards.get(db)?.(tx, id) ?? false;
}
const originalRelayReceiptWakes = new WeakMap<
  object,
  {
    db: Db;
    wake: (sessionId: string, receiptIds: readonly string[]) => Promise<readonly string[]>;
  }
>();
/** Exact installed source constructor lookup. IDs select original rows; they mint no claim. */
export function wakeOriginalRelayAcceptedReceipts(
  owner: object,
  db: Db,
  sessionId: string,
  receiptIds: readonly string[]
): Promise<readonly string[]> {
  const own = originalRelayReceiptWakes.get(owner);
  if (!own || own.db !== db) throw new Error('Original installed Relay receipt source required');
  return own.wake(sessionId, receiptIds);
}
const originalRelaySources = new WeakMap<
  OriginalFrozenRelayDocumentSource,
  {
    db: Db;
    adapter: InstalledDocumentAdapterSource;
    principals: ConnectorRuntimePrincipalPort;
    authority: DocBatchAuthority;
    digest: string;
    refresh: () => DocBatchAuthority;
    requireGranted: () => void;
    committed?: {
      claim: OriginalRelayNativeClaim;
      runtime: object;
      prepared: PreparedRelayDocumentResponder;
      operation: object;
    };
    settlementStarted?: boolean;
    refundFailure?: { cause: unknown };
    native: FixedNativeRelayFacts;
    facts: OriginalRelayNativeFacts;
    access: ReturnType<typeof consumeServerDocumentRelayOrigin>;
  }
>();
/** Exact original approved private-session target; native producer recognition remains separate. */
export function readOriginalFrozenRelayDocumentTarget(
  source: OriginalFrozenRelayDocumentSource,
  principals: ConnectorRuntimePrincipalPort,
  runtime: string
) {
  const own = originalRelaySources.get(source);
  if (!own) throw new Error('Original Relay source required.');
  requireSameOriginalNativePrincipalPorts(own.principals, principals);
  const current = own.refresh();
  if (docBatchDigest(current) !== own.digest) refuseDocBatch('document_relay_source_changed');
  const target = current.target;
  if (
    current.batch.scope.startsWith('room:') ||
    !target.agentId ||
    !target.sessionId ||
    !target.agentPath ||
    target.runtime !== runtime
  )
    refuseDocBatch('document_relay_native_target_unavailable');
  return Object.freeze({
    agentId: target.agentId,
    sessionId: target.sessionId,
    agentPath: target.agentPath,
  });
}
/** Source-owned placeholder and canonical structured context; never caller prompt/source authority. */
export function readOriginalFrozenRelayDocumentLaunchInput(
  source: OriginalFrozenRelayDocumentSource,
  principals: ConnectorRuntimePrincipalPort
) {
  const own = originalRelaySources.get(source);
  if (!own) throw new Error('Original Relay source required');
  requireSameOriginalNativePrincipalPorts(own.principals, principals);
  const current = own.refresh();
  if (docBatchDigest(current) !== own.digest) refuseDocBatch('document_relay_source_changed');
  const count = current.batch.inputEventIds.length;
  const additionalContext: import('@dorkos/shared/additional-context').AdditionalContext = [];
  appendDocEventsContext(additionalContext, current.context);
  return {
    content: `[Document update: ${count} ${count === 1 ? 'action' : 'actions'}]`,
    additionalContext,
  };
}
/** Actual source-selected installed CCA runtime and SAME nonwaiting private capacity pool. */
export function reserveOriginalFrozenRelayDocumentProcess(
  source: OriginalFrozenRelayDocumentSource,
  principals: ConnectorRuntimePrincipalPort,
  runtime: object
) {
  const own = originalRelaySources.get(source);
  if (!own) throw new Error('Original Relay source required');
  requireSameOriginalNativePrincipalPorts(own.principals, principals);
  const current = own.refresh();
  if (docBatchDigest(current) !== own.digest) refuseDocBatch('document_relay_source_changed');
  own.adapter.requireReady();
  const installed = own.adapter.readRuntime('claude-code');
  if (
    (readOriginalRegisteredRuntime(installed) ?? installed) !==
    (readOriginalRegisteredRuntime(runtime) ?? runtime)
  )
    throw new Error('Original installed document CCA runtime changed');
  return own.adapter.reserveDocumentProcess('claude-code');
}
/** Fixed original tuple source/receipt/route-charge COMMIT. No request actor or SDK issuer accepted. */
export async function claimOriginalPreparedRelayDocumentFacts(
  source: OriginalFrozenRelayDocumentSource,
  runtime: object,
  prepared: PreparedRelayDocumentResponder,
  operation: object,
  principals: ConnectorRuntimePrincipalPort
) {
  const own = originalRelaySources.get(source);
  if (!own) throw new Error('Original Relay source required');
  requireSameOriginalNativePrincipalPorts(own.principals, principals);
  requireClaudeOriginalRelayPreparedTuple(runtime, prepared, source, operation);
  const resolved = await resolveOriginalNativePrincipal(principals, operation);
  if (resolved.status !== 'resolved' || resolved.principal.claims.kind !== 'runtime')
    throw new Error('Original Relay native principal unavailable');
  const claims = resolved.principal.claims;
  requireClaudeOriginalRelayPreparedTuple(runtime, prepared, source, operation);
  const authority = own.refresh(),
    target = authority.target;
  if (
    docBatchDigest(authority) !== own.digest ||
    claims.agentId !== target.agentId ||
    claims.agentPath !== target.agentPath ||
    claims.canonicalSessionId !== target.sessionId ||
    claims.canonicalCwd !== target.agentPath ||
    claims.runtime !== target.runtime
  )
    throw new Error('Original Relay native principal/source changed');
  const reservation = own.access.reserveDocumentTurn(claims.agentId);
  if (!reservation.allowed) throw new Error('Original shared Relay turn ceiling exhausted');
  try {
    // Actual configuration readers at reservation may reenter or retire an owner.
    // Reread the original source/principal/acquisition after them, before native SQL.
    own.access.requireOpen();
    const current = own.refresh();
    if (docBatchDigest(current) !== own.digest)
      throw new Error('Original Relay source changed at claim');
    requireClaudeOriginalRelayPreparedTuple(runtime, prepared, source, operation);
    requireCurrentOriginalNativeTurn(principals, operation);
    const seq = readOriginalClaudeRelayProjectedTurnStart(runtime, prepared, source, operation);
    const claim = own.native.claim(
      own.facts,
      new Date().toISOString(),
      CanvasChannelGrantSchema.shape.limits.parse(current.grant.limits).turnsPerHour,
      claims.bindingId,
      seq
    );
    own.committed = { claim, runtime, prepared, operation };
    // Post-positive-COMMIT hint is DATA only; observers independently reread authorized durable rows.
    queueCommittedDocEvent(own.db, own.native.readCommittedStartHint(claim));
    return claim;
  } catch (cause) {
    // Refund only an original native no-COMMIT closure. UNKNOWN stays charged.
    let noClaim = false;
    try {
      own.native.requireKnownNoClaim(own.facts);
      noClaim = true;
    } catch {
      /* Retain original charge/cause. */
    }
    if (noClaim) {
      try {
        reservation.refundKnownNoStart();
      } catch (refundCause) {
        own.refundFailure = { cause: refundCause };
      }
    } // Original failure remains first; refund uncertainty stays owned.
    throw cause;
  }
}
/** Original closed runtime/claim token owns terminal write; caller DTOs cannot supply outcome. */
function settleOriginalClosedRelaySource(
  source: OriginalFrozenRelayDocumentSource,
  runtime: object
): void {
  const own = originalRelaySources.get(source),
    committed = own?.committed;
  if (!own || !committed || own.settlementStarted)
    throw new Error('Original Relay settlement source unavailable');
  own.settlementStarted = true;
  const closed = readOriginalClaudeRelayClosedTurn(runtime, source);
  const data = readOriginalClaudeRelayClosedTurnData(
    closed,
    committed.runtime,
    source,
    committed.claim
  );
  const hint = own.native.settle(committed.claim, new Date().toISOString(), data.outcome);
  if (hint) queueCommittedDocEvent(own.db, hint); // Post-positive COMMIT DATA hint only.
}
/** Fixed committed tuple currentness, not caller DATA receipt/status or an SDK effect witness. */
export function requireOriginalPreparedRelayDocumentClaimCurrent(
  source: OriginalFrozenRelayDocumentSource,
  runtime: object,
  prepared: PreparedRelayDocumentResponder,
  operation: object,
  claim: OriginalRelayNativeClaim,
  principals: ConnectorRuntimePrincipalPort
): void {
  const own = originalRelaySources.get(source),
    committed = own?.committed;
  if (
    !own ||
    !committed ||
    committed.claim !== claim ||
    committed.runtime !== runtime ||
    committed.prepared !== prepared ||
    committed.operation !== operation
  )
    throw new Error('Original committed Relay tuple required');
  requireSameOriginalNativePrincipalPorts(own.principals, principals);
  requireClaudeOriginalRelayPreparedTuple(runtime, prepared, source, operation);
  own.adapter.requireReady();
  const installed = own.adapter.readRuntime('claude-code');
  if (
    (readOriginalRegisteredRuntime(installed) ?? installed) !==
    (readOriginalRegisteredRuntime(runtime) ?? runtime)
  )
    throw new Error('Original installed Relay runtime changed');
  own.access.requireOpen();
  own.requireGranted();
  own.access.requireExplicitOpenerAccess(
    own.authority.grant.openerAgentId!,
    own.authority.target.agentId!
  );
  requireClaudeOriginalRelayPreparedTuple(runtime, prepared, source, operation);
  requireCurrentOriginalNativeTurn(principals, operation);
  // Original manifest/ACL/native activity work is complete BEFORE this physical
  // native frame. No public Drizzle statement or configured callback after it.
  own.native.requireClaimCurrent(claim, new Date().toISOString());
}
/** Original source/grant and explicit opener ACL reread; no page routing authority. */
import { type Db, eq, sessionMessageAcceptanceReceipts, type DbTransaction } from '@dorkos/db';
import {
  consumeServerDocumentRelayOrigin,
  type ServerDocumentRelayOrigin,
  consumeInstalledDocumentAdapterOrigin,
  type InstalledDocumentAdapterOrigin,
  type InstalledDocumentAdapterSource,
} from '@dorkos/relay/server-private-document';
import {
  requireOriginalDocumentRelayStore,
  requireOriginalDocGrantStore,
  requireDocChannelStoreDatabase,
  type DocChannelStore,
  type DocBatchRow,
} from '../store.js';
import { requireOriginalDocumentRelayGrants } from '../grant-revalidation.js';
import type { DocChannelGrants } from '../grants.js';
import { currentRoomDueServicePort, type DocChannelService } from '../service.js';
import {
  readDocBatchAuthority,
  docBatchDigest,
  verifyDocReceipt,
  refuseDocBatch,
  type DocBatchAuthority,
} from './batch-authority.js';

/** One installation consumes one genuine freshly constructed bus origin. */
export function createDocumentRelaySourceAuthority(
  origin: ServerDocumentRelayOrigin,
  store: DocChannelStore,
  grants: DocChannelGrants,
  nativePrincipals?: ConnectorRuntimePrincipalPort,
  ownDb?: Db,
  serverNativeRelayConstruction?: ServerNativeRelayConstruction,
  installedAdapterOrigin?: InstalledDocumentAdapterOrigin,
  roomService?: DocChannelService
) {
  if (nativePrincipals || ownDb) {
    if (!nativePrincipals || !ownDb || !serverNativeRelayConstruction || !installedAdapterOrigin)
      throw new Error('Original Relay principal/database/installed adapter assembly required.');
    requireOriginalNativePrincipalPort(nativePrincipals);
    requireNativePrincipalDatabase(nativePrincipals, ownDb);
    requireDocChannelStoreDatabase(store, ownDb);
  }
  if (serverNativeRelayConstruction && (!nativePrincipals || !ownDb))
    throw new Error('Original Relay native assembly required');
  const native =
    serverNativeRelayConstruction && ownDb
      ? consumeServerNativeRelayConstruction(serverNativeRelayConstruction, ownDb)
      : undefined;
  const adapter = installedAdapterOrigin
    ? consumeInstalledDocumentAdapterOrigin(installedAdapterOrigin)
    : undefined;
  const access = consumeServerDocumentRelayOrigin(origin);
  const originalStore = requireOriginalDocumentRelayStore(store);
  const originalGrants = requireOriginalDocumentRelayGrants(grants, store);
  const roomDue = roomService ? currentRoomDueServicePort(roomService) : undefined;
  const originalGrantStore = ownDb ? requireOriginalDocGrantStore(store, ownDb) : undefined;
  type RoomWakeIdentity = { documentId: string; openerAgentId?: string; targetAgentId?: string };
  function requireRoomIdentity(
    batch: DocBatchRow,
    expected?: RoomWakeIdentity,
    tx?: DbTransaction
  ) {
    const storedGrant = originalGrantStore?.getGrant(batch.grantId, tx);
    if (
      !storedGrant ||
      storedGrant.documentId !== batch.documentId ||
      storedGrant.routeId !== batch.routeId ||
      storedGrant.revision !== batch.grantRevision ||
      (storedGrant.normalizedRoute as { to?: string }).to !== 'room:self' ||
      (expected &&
        (batch.documentId !== expected.documentId ||
          (expected.openerAgentId !== undefined &&
            storedGrant.openerAgentId !== expected.openerAgentId) ||
          (expected.targetAgentId !== undefined &&
            storedGrant.targetAgentId !== expected.targetAgentId)))
    )
      refuseDocBatch('document_relay_source_changed');
  }
  function readRoomWake(batchId: string, generation: string, expected?: RoomWakeIdentity) {
    access.requireOpen();
    const before = originalStore.getBatch(batchId);
    if (!before || before.generation !== generation || !before.scope.startsWith('room:'))
      refuseDocBatch('document_batch_changed');
    requireRoomIdentity(before, expected);
    // Native Room owns progress independently. A late identifier cannot relaunch it.
    if (
      [
        'dispatching',
        'turn_started',
        'turn_done',
        'failed',
        'cancelled',
        'in_doubt',
        'expired',
      ].includes(before.status)
    )
      return undefined;
    originalGrants.refreshGrantedAuthority(before.grantId);
    return originalStore.transaction((tx) => {
      const batch = originalStore.getBatch(batchId, tx);
      if (!batch || batch.generation !== generation || !batch.scope.startsWith('room:'))
        refuseDocBatch('document_batch_changed');
      requireRoomIdentity(batch, expected, tx);
      if (
        [
          'dispatching',
          'turn_started',
          'turn_done',
          'failed',
          'cancelled',
          'in_doubt',
          'expired',
        ].includes(batch.status)
      )
        return undefined;
      if (!['pending', 'waiting', 'accepted'].includes(batch.status))
        refuseDocBatch('document_batch_changed');
      const { grant, target } = originalGrants.revalidateBatchGrant(batch, tx);
      if (
        (grant.normalizedRoute as { to?: string }).to !== 'room:self' ||
        target.scope !== batch.scope ||
        !grant.openerAgentId ||
        !target.agentId ||
        !roomDue
      )
        refuseDocBatch('document_relay_native_target_unavailable');
      access.requireExplicitOpenerAccess(grant.openerAgentId, target.agentId);
      return { batch, grant, target };
    });
  }

  /** Only the owning source transaction may reread its accepted generation and private receipt. */
  function readAccepted(tx: DbTransaction, batchId: string, generation: string): DocBatchAuthority {
    access.requireOpen();
    const batch = originalStore.getBatch(batchId, tx);
    if (!batch || batch.generation !== generation || batch.status !== 'accepted')
      refuseDocBatch('document_batch_changed');
    const authority = readDocBatchAuthority(originalStore, originalGrants, tx, batch);
    // readDocBatchAuthority already revalidates the approved exact target, immutable input,
    // current origin membership and grant. This additional check never widens its result.
    if (!authority.grant.openerAgentId || !authority.target.agentId)
      refuseDocBatch('document_relay_opener_required');
    access.requireExplicitOpenerAccess(authority.grant.openerAgentId, authority.target.agentId);
    if (!batch.admissionReceiptId) refuseDocBatch('document_receipt_missing');
    const receipt = tx
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, batch.admissionReceiptId))
      .get();
    if (!receipt) refuseDocBatch('document_receipt_missing');
    if (
      receipt.state !== 'accepted' ||
      receipt.dispatchAttemptId !== null ||
      receipt.dispatchBootEpoch !== null ||
      receipt.dispatchClaimedAt !== null ||
      receipt.turnStartSeq !== null ||
      receipt.turnStartedAt !== null ||
      receipt.settledAt !== null ||
      receipt.settleOutcome !== null ||
      receipt.cancellationCode !== null
    )
      refuseDocBatch('document_receipt_already_claimed');
    verifyDocReceipt(authority, receipt);
    return authority;
  }

  // This captured read is an internal source prerequisite, not an ingress/claim/charge token.
  // The pending native operation and source+receipt+charge CAS must still run before dispatch.
  function currentAccepted(batchId: string, generation: string): DocBatchAuthority {
    access.requireOpen();
    const initial = originalStore.getBatch(batchId);
    if (!initial || initial.generation !== generation) refuseDocBatch('document_batch_changed');
    originalGrants.refreshGrantedAuthority(initial.grantId);
    return originalStore.transaction((tx) => readAccepted(tx, batchId, generation));
  }
  function prepareOriginalNativeSource(
    batchId: string,
    generation: string
  ): OriginalFrozenRelayDocumentSource {
    if (!nativePrincipals || !ownDb || !serverNativeRelayConstruction || !adapter || !native)
      throw new Error('Original Relay native principal/installed adapter assembly unavailable.');
    const authority = currentAccepted(batchId, generation),
      digest = docBatchDigest(authority);
    const token: OriginalFrozenRelayDocumentSource = Object.freeze({
      kind: 'original-frozen-relay-document-source',
    });
    const { batch, grant, target } = authority;
    if (!target.sessionId || !target.agentId || !target.runtime || !target.agentPath)
      refuseDocBatch('document_relay_native_target_unavailable');
    const facts = native.capture(
      {
        batchId: batch.batchId,
        generation: batch.generation,
        documentId: batch.documentId,
        routeId: batch.routeId,
        scope: batch.scope,
        grantId: grant.grantId,
        grantRevision: grant.revision,
        sessionId: target.sessionId,
        agentId: target.agentId,
        runtime: target.runtime,
        agentPath: target.agentPath,
        authorityDigest: digest,
      },
      new Date().toISOString()
    );
    originalRelaySources.set(token, {
      db: ownDb!,
      adapter,
      principals: nativePrincipals,
      authority,
      digest,
      native,
      facts,
      access,
      requireGranted: () => originalGrants.refreshGrantedAuthority(grant.grantId),
      refresh: () => currentAccepted(batchId, generation),
    });
    return token;
  }

  const active = new Map<
    string,
    {
      source?: OriginalFrozenRelayDocumentSource;
      runtime?: object;
      driveStarted: boolean;
      work?: Promise<void>;
    }
  >();
  let stopped = false,
    stopMemo: Promise<void> | undefined,
    unsubscribe: (() => void) | undefined,
    unsubscribeRoomRelay: (() => void) | undefined;
  const pendingWakes = new Set<Promise<readonly string[]>>();
  let wakeFailed = false,
    firstWakeCause: unknown;
  let operationalFailed = false,
    firstOperationalCause: unknown;
  let sinkFailed = false,
    firstSinkCause: unknown;
  const rememberSinkFailure = (cause: unknown) => {
    if (!sinkFailed) {
      sinkFailed = true;
      firstSinkCause = cause;
    }
  };
  const remember = (cause: unknown) => {
    rememberSinkFailure(cause);
    if (!operationalFailed) {
      operationalFailed = true;
      firstOperationalCause = cause;
    }
  };
  if (native && nativePrincipals && ownDb && adapter) {
    adapter.requireReady();
    originalRelayAvailability.set(grants, (target, opener) => {
      if (stopped) return 'relay_disabled';
      if (
        !opener ||
        !target.agentId ||
        !target.sessionId ||
        !target.agentPath ||
        target.runtime !== 'claude-code' ||
        !target.scope.startsWith('session:')
      )
        return 'runtime_unavailable';
      try {
        access.requireOpen();
        adapter.requireReady();
        adapter.readRuntime('claude-code');
      } catch {
        return 'relay_disabled';
      }
      try {
        access.requireExplicitOpenerAccess(opener, target.agentId);
      } catch {
        return 'relay_access_denied';
      }
      return undefined;
    });
    if (originalRelayGenericClaimGuards.has(ownDb))
      throw new Error('Original Relay native source already installed');
    originalRelayGenericClaimGuards.set(ownDb, (tx, id) => {
      const receipt = tx
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, id))
        .get();
      if (!receipt || receipt.sourceKind !== 'document_event_batch') return false;
      const batch = originalStore.getBatch(receipt.sourceId, tx);
      if (
        !batch ||
        batch.generation !== receipt.sourceGeneration ||
        batch.admissionReceiptId !== id
      )
        throw new Error('Original Relay generic claim source link differs');
      const authority = readDocBatchAuthority(originalStore, originalGrants, tx, batch);
      return (
        !!authority.grant.openerAgentId &&
        authority.target.runtime === 'claude-code' &&
        !!authority.target.agentId &&
        !authority.batch.scope.startsWith('room:')
      );
    }); // Retained after stop: stopped native owners never fall back to generic dispatch.
    const publishingRoom = new Set<string>();
    unsubscribeRoomRelay = roomDue?.subscribeRelay((documentId, batchId, generation) => {
      if (stopped) return;
      const key = JSON.stringify([batchId, generation]);
      if (publishingRoom.has(key)) return;
      if (publishingRoom.size >= 100) {
        if (!wakeFailed) {
          wakeFailed = true;
          firstWakeCause = new Error('Original Relay Room publication finite active frontier');
          rememberSinkFailure(firstWakeCause);
        }
        return;
      }
      publishingRoom.add(key);
      const work = Promise.resolve()
        .then(async () => {
          if (stopped) return Object.freeze([] as string[]);
          const current = readRoomWake(batchId, generation, { documentId });
          if (!current) return Object.freeze([] as string[]);
          if (current.batch.documentId !== documentId)
            throw new Error('Original Room publication source changed');
          await access.publishAcceptedDocumentWake({
            documentId,
            batchId,
            generation,
            openerAgentId: current.grant.openerAgentId!,
            targetAgentId: current.target.agentId!,
          });
          return Object.freeze([] as string[]);
        })
        .catch((cause) => {
          if (!wakeFailed) {
            wakeFailed = true;
            firstWakeCause = cause;
            rememberSinkFailure(cause);
          }
          throw cause;
        });
      pendingWakes.add(work);
      const release = () => {
        publishingRoom.delete(key);
        pendingWakes.delete(work);
      };
      void work.then(release, release);
    });
    unsubscribe = access.subscribeDocumentWakes((wake) => {
      if (stopped) return;
      const key = JSON.stringify([wake.batchId, wake.generation]);
      if (active.has(key)) return;
      if (active.size >= 100) throw new Error('Original Relay native sink finite active frontier');
      // Reserve the exact immutable DATA identity before source/native callbacks can reenter.
      const slot = {
        source: undefined as OriginalFrozenRelayDocumentSource | undefined,
        runtime: undefined as object | undefined,
        driveStarted: false,
        work: undefined as Promise<void> | undefined,
      };
      const work = Promise.resolve()
        .then(async () => {
          if (stopped) return;
          const selected = originalStore.getBatch(wake.batchId);
          if (selected?.scope.startsWith('room:')) {
            const room = readRoomWake(wake.batchId, wake.generation, wake);
            if (!room) return;
            if (
              room.batch.documentId !== wake.documentId ||
              room.grant.openerAgentId !== wake.openerAgentId ||
              room.target.agentId !== wake.targetAgentId
            )
              throw new Error('Original Relay Room wake/source correlation differs');
            roomDue!.hintRelay(wake.documentId, wake.batchId, wake.generation);
            return;
          }
          const source = prepareOriginalNativeSource(wake.batchId, wake.generation),
            own = originalRelaySources.get(source)!;
          if (
            own.authority.batch.documentId !== wake.documentId ||
            own.authority.grant.openerAgentId !== wake.openerAgentId ||
            own.authority.target.agentId !== wake.targetAgentId
          )
            throw new Error('Original Relay wake/source correlation differs');
          own.adapter.requireReady();
          const runtime = own.adapter.readRuntime('claude-code');
          slot.source = source;
          slot.runtime = runtime;
          if (stopped) return; // Captured source has no launched drive/process yet.
          const driving = driveClaudeOriginalRelayDocument(runtime, source);
          slot.driveStarted = true;
          let failed = false,
            first: unknown,
            closed = true,
            driveResult: 'busy' | 'drained' | undefined;
          const retain = (cause: unknown) => {
            rememberSinkFailure(cause);
            if (!failed) {
              failed = true;
              first = cause;
            }
          };
          try {
            driveResult = await driving;
          } catch (cause) {
            retain(cause);
          }
          // Attempt both actual closure recognizers without replacing an original operation failure.
          try {
            await stopClaudeOriginalRelayDocumentDrive(runtime, source);
          } catch (cause) {
            closed = false;
            retain(cause);
          }
          try {
            native.requireClosed();
          } catch (cause) {
            closed = false;
            retain(cause);
          }
          if (closed && !failed && driveResult === 'drained') {
            try {
              settleOriginalClosedRelaySource(source, runtime);
            } catch (cause) {
              retain(cause);
            }
          }
          // Terminal SQL owns a new original frame; earlier drive closure cannot certify it.
          try {
            native.requireClosed();
          } catch (cause) {
            closed = false;
            retain(cause);
          }
          if (closed && active.get(key) === slot) active.delete(key);
          if (failed) throw first;
        })
        .catch(remember)
        .finally(() => {
          // Identifier-only handoff acquired no native turn/custody to drain.
          if (!slot.source && active.get(key) === slot) active.delete(key);
        });
      slot.work = work;
      active.set(key, slot);
    });
  }
  const stopOriginalNativeSink = () => {
    if (stopMemo) return stopMemo;
    stopped = true;
    stopMemo = Promise.resolve().then(async () => {
      let failed = false,
        first: unknown;
      const retain = (cause: unknown) => {
        rememberSinkFailure(cause);
        if (!failed) {
          failed = true;
          first = firstSinkCause;
        }
      };
      if (operationalFailed) retain(firstOperationalCause);
      if (wakeFailed) retain(firstWakeCause); // Earlier original publication failure remains first.
      try {
        unsubscribeRoomRelay?.();
        unsubscribe?.();
      } catch (cause) {
        retain(cause);
      }
      const peers: Promise<unknown>[] = [
        ...pendingWakes,
        ...[...active.values()].flatMap((slot) => {
          const tasks: Promise<unknown>[] = [];
          // Launch cancellation independently before waiting for the real held stream/drive.
          if (slot.driveStarted && slot.source && slot.runtime)
            tasks.push(
              Promise.resolve().then(() =>
                stopClaudeOriginalRelayDocumentDrive(slot.runtime!, slot.source!)
              )
            );
          if (slot.work) tasks.push(slot.work);
          return tasks;
        }),
      ];
      await Promise.allSettled(peers.map((peer) => peer.catch(retain)));
      if (operationalFailed) retain(firstOperationalCause);
      if (wakeFailed) retain(firstWakeCause);
      try {
        native?.requireClosed();
      } catch (cause) {
        retain(cause);
      }
      if (failed) throw first;
      active.clear();
    });
    return stopMemo;
  };
  const owner = Object.freeze({
    stopOriginalNativeSink,
    readOriginalSinkDiagnostic() {
      return Object.freeze({ stopped, active: active.size, operationalFailed });
    },
    /** Original accepted-source reread precedes actual protected bus publication.
     * DeliveredTo/trace rows remain transport DATA, never native acceptance. */
    publishAcceptedWake(batchId: string, generation: string) {
      const selected = originalStore.getBatch(batchId);
      const authority = selected?.scope.startsWith('room:')
        ? readRoomWake(batchId, generation)
        : currentAccepted(batchId, generation);
      if (!authority) return Promise.resolve(undefined);
      const { batch, grant, target } = authority;
      if (!grant.openerAgentId || !target.agentId) refuseDocBatch('document_relay_opener_required');
      return access.publishAcceptedDocumentWake({
        documentId: batch.documentId,
        batchId: batch.batchId,
        generation: batch.generation,
        openerAgentId: grant.openerAgentId,
        targetAgentId: target.agentId,
      });
    },
    prepareOriginalNativeSource,
    readAccepted(batchId: string, generation: string): DocBatchAuthority {
      access.requireOpen();
      const initial = originalStore.getBatch(batchId);
      if (!initial || initial.generation !== generation) refuseDocBatch('document_batch_changed');
      // Manifest suspension must commit outside the source transaction, as in the original source.
      originalGrants.refreshGrantedAuthority(initial.grantId);
      return originalStore.transaction((tx) => readAccepted(tx, batchId, generation));
    },
  });
  if (native && nativePrincipals && ownDb && adapter) {
    originalRelayReceiptWakes.set(owner, {
      db: ownDb,
      wake(sessionId, receiptIds) {
        if (stopped) throw new Error('Original installed Relay source stopped');
        if (receiptIds.length > 100 || new Set(receiptIds).size !== receiptIds.length)
          throw new RangeError('Original Relay receipt selection differs');
        const selectedIds = Object.freeze([...receiptIds]);
        // Own the promise before any protected publisher/subscriber can reenter.
        const work = Promise.resolve()
          .then(async () => {
            if (stopped) throw new Error('Original installed Relay source stopped');
            const ordinary: string[] = [];
            for (const id of selectedIds) {
              const selected = originalStore.transaction((tx) => {
                const receipt = tx
                  .select()
                  .from(sessionMessageAcceptanceReceipts)
                  .where(eq(sessionMessageAcceptanceReceipts.id, id))
                  .get();
                if (
                  !receipt ||
                  receipt.sourceKind !== 'document_event_batch' ||
                  receipt.sessionId !== sessionId
                )
                  throw new Error('Original Relay receipt destination differs');
                // A concurrently committed native claim must not be fed to the generic pump.
                if (receipt.state !== 'accepted') return undefined;
                const batch = originalStore.getBatch(receipt.sourceId, tx);
                if (
                  !batch ||
                  batch.generation !== receipt.sourceGeneration ||
                  batch.admissionReceiptId !== id
                )
                  throw new Error('Original Relay receipt/source link differs');
                return {
                  batchId: batch.batchId,
                  generation: batch.generation,
                  grantId: batch.grantId,
                };
              });
              if (!selected) continue;
              // Original grant maintenance occurs outside SQL, just as in original admission.
              originalGrants.refreshGrantedAuthority(selected.grantId);
              const authority = originalStore.transaction((tx) => {
                const batch = originalStore.getBatch(selected.batchId, tx);
                if (
                  !batch ||
                  batch.generation !== selected.generation ||
                  batch.status !== 'accepted'
                )
                  throw new Error('Original Relay accepted source changed');
                const current = readDocBatchAuthority(originalStore, originalGrants, tx, batch);
                const receipt = tx
                  .select()
                  .from(sessionMessageAcceptanceReceipts)
                  .where(eq(sessionMessageAcceptanceReceipts.id, id))
                  .get();
                if (!receipt || receipt.state !== 'accepted')
                  throw new Error('Original Relay receipt changed');
                verifyDocReceipt(current, receipt);
                return current;
              });
              if (
                !authority.grant.openerAgentId ||
                authority.target.runtime !== 'claude-code' ||
                !authority.target.agentId ||
                authority.batch.scope.startsWith('room:')
              ) {
                ordinary.push(id);
                continue;
              }
              // Fixed native assembly owns this source. Full original ACL/currentness is reread
              // before protected publication; DeliveredTo is not the exclusion/claim authority.
              const current = currentAccepted(selected.batchId, selected.generation);
              await access.publishAcceptedDocumentWake({
                documentId: current.batch.documentId,
                batchId: current.batch.batchId,
                generation: current.batch.generation,
                openerAgentId: current.grant.openerAgentId!,
                targetAgentId: current.target.agentId!,
              });
            }
            return Object.freeze(ordinary);
          })
          .catch((cause) => {
            if (!wakeFailed) {
              wakeFailed = true;
              firstWakeCause = cause;
              rememberSinkFailure(cause);
            }
            throw cause;
          });
        pendingWakes.add(work);
        void work.then(
          () => pendingWakes.delete(work),
          () => pendingWakes.delete(work)
        );
        return work;
      },
    });
  }
  return owner;
}
