import { CanvasChannelGrantSchema } from '@dorkos/shared/canvas-channel-schemas';
import { queueCommittedDocEvent } from '../committed-events.js';
import { readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { appendDocEventsContext } from '../../../session/context-assembler.js';
import {
  requireClaudeOriginalRelayPreparedTuple,
  readOriginalClaudeRelayProjectedTurnStart,
  readOriginalClaudeRelayClosedTurn,
  readOriginalClaudeRelayClosedTurnData,
} from '../../../runtimes/claude-code/claude-code-runtime.js';
import type { PreparedRelayDocumentResponder } from './relay-native-types.js';
import {
  type FixedNativeRelayFacts,
  type OriginalRelayNativeFacts,
  type OriginalRelayNativeClaim,
} from '@dorkos/db/internal-server';
import {
  requireSameOriginalNativePrincipalPorts,
  requireCurrentOriginalNativeTurn,
  resolveOriginalNativePrincipal,
} from '../../../connectors/principal/runtime-principal-service.js';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';
import type { OriginalFrozenRelayDocumentSource } from './relay-native-types.js';
import { type Db, type DbTransaction } from '@dorkos/db';
import {
  consumeServerDocumentRelayOrigin,
  type InstalledDocumentAdapterSource,
} from '@dorkos/relay/server-private-document';

import { docBatchDigest, refuseDocBatch, type DocBatchAuthority } from './batch-authority.js';

/** Named exact original custody shape; actual installed membership remains private. */
export interface OriginalRelaySourceCustody {
  originalRelayAvailability: WeakMap<
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
  >;
  originalRelayGenericClaimGuards: WeakMap<Db, (tx: DbTransaction, id: string) => boolean>;
  originalRelayReceiptWakes: WeakMap<
    object,
    {
      db: Db;
      wake: (sessionId: string, receiptIds: readonly string[]) => Promise<readonly string[]>;
    }
  >;
  originalRelaySources: WeakMap<
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
  >;
  readOriginalDocumentRelayAvailability(
    grants: object,
    target: {
      scope: string;
      sessionId: string | null;
      agentId: string | null;
      runtime: string | null;
      agentPath: string | null;
    },
    openerAgentId: string | null
  ): string | undefined;
  originalRelayReceiptNeedsNativeDispatch(db: Db, tx: DbTransaction, id: string): boolean;
  wakeOriginalRelayAcceptedReceipts(
    owner: object,
    db: Db,
    sessionId: string,
    receiptIds: readonly string[]
  ): Promise<readonly string[]>;
  readOriginalFrozenRelayDocumentTarget(
    source: OriginalFrozenRelayDocumentSource,
    principals: ConnectorRuntimePrincipalPort,
    runtime: string
  ): Readonly<{ agentId: string; sessionId: string; agentPath: string }>;
  readOriginalFrozenRelayDocumentLaunchInput(
    source: OriginalFrozenRelayDocumentSource,
    principals: ConnectorRuntimePrincipalPort
  ): {
    content: string;
    additionalContext: import('@dorkos/shared/additional-context').AdditionalContext;
  };
  reserveOriginalFrozenRelayDocumentProcess(
    source: OriginalFrozenRelayDocumentSource,
    principals: ConnectorRuntimePrincipalPort,
    runtime: object
  ): ReturnType<InstalledDocumentAdapterSource['reserveDocumentProcess']>;
  claimOriginalPreparedRelayDocumentFacts(
    source: OriginalFrozenRelayDocumentSource,
    runtime: object,
    prepared: PreparedRelayDocumentResponder,
    operation: object,
    principals: ConnectorRuntimePrincipalPort
  ): Promise<OriginalRelayNativeClaim>;
  requireOriginalPreparedRelayDocumentClaimCurrent(
    source: OriginalFrozenRelayDocumentSource,
    runtime: object,
    prepared: PreparedRelayDocumentResponder,
    operation: object,
    claim: OriginalRelayNativeClaim,
    principals: ConnectorRuntimePrincipalPort
  ): void;
  settleOriginalClosedRelaySource(source: OriginalFrozenRelayDocumentSource, runtime: object): void;
}

/** Isolated original Relay custody; unrelated factories cannot acquire installed membership. */
export function createIsolatedRelaySourceCustody(): OriginalRelaySourceCustody {
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
  function readOriginalDocumentRelayAvailability(
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
  function originalRelayReceiptNeedsNativeDispatch(db: Db, tx: DbTransaction, id: string): boolean {
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
  function wakeOriginalRelayAcceptedReceipts(
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
  function readOriginalFrozenRelayDocumentTarget(
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
  function readOriginalFrozenRelayDocumentLaunchInput(
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
  function reserveOriginalFrozenRelayDocumentProcess(
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
  async function claimOriginalPreparedRelayDocumentFacts(
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
  function requireOriginalPreparedRelayDocumentClaimCurrent(
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

  return Object.freeze({
    originalRelayAvailability,
    originalRelayGenericClaimGuards,
    originalRelayReceiptWakes,
    originalRelaySources,
    readOriginalDocumentRelayAvailability,
    originalRelayReceiptNeedsNativeDispatch,
    wakeOriginalRelayAcceptedReceipts,
    readOriginalFrozenRelayDocumentTarget,
    readOriginalFrozenRelayDocumentLaunchInput,
    reserveOriginalFrozenRelayDocumentProcess,
    claimOriginalPreparedRelayDocumentFacts,
    requireOriginalPreparedRelayDocumentClaimCurrent,
    settleOriginalClosedRelaySource,
  });
}
