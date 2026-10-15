import { createRunOutcomeTracker } from '@dorkos/shared/run-outcome';
import { requireOriginalSessionProjection } from '../../../session/session-state-projector.js';
import {
  requireOriginalSessionProjectionFeed,
  type OriginalSessionProjectionFeed,
} from '../../../session/projection/session-event-normalizer.js';
import type { OriginalDocumentProcessReservation } from '@dorkos/relay/server-private-document';
import {
  requireOriginalPreparedRelaySdkLaunch,
  stopOriginalRelaySdkQuery,
  drainOriginalRelaySdkQuery,
  type OriginalPreparedRelaySdkLaunch,
} from '../messaging/relay/relay-sdk-launch.js';
import {
  requireOriginalPreparedRelayDocumentClaimCurrent,
  readOriginalFrozenRelayDocumentTarget,
} from '../../../canvas/doc-channel/delivery/relay-authority.js';
import type {
  OriginalFrozenRelayDocumentSource,
  PreparedRelayDocumentResponder,
} from '../../../canvas/doc-channel/delivery/relay-native-types.js';
import { readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import type { StreamEvent } from '@dorkos/shared/types';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  type NativeSessionAcquisition,
} from '../../../session/session-lock.js';
import type { AgentSession } from '../agent-types.js';
import { getOrCreateProjector } from '../../../session/session-state-projector.js';
import type { SessionStateProjector } from '../../../session/index.js';
import type { readClaudeNativeOperation as NativeOperationReader } from '../claude-code-runtime.js';

export interface OriginalClaudeRelayClosedTurn {
  readonly kind: 'original-claude-relay-closed-turn';
}
/**
 * Allocate isolated Relay custody; the actual runtime module alone holds its original instance.
 * @param readClaudeNativeOperation - Original lexical native-operation lookup captured by that instance.
 * @returns Isolated maps and original lookup/stream functions; no registration in another instance.
 */
export function createIsolatedClaudeRelayCustody(
  readClaudeNativeOperation: typeof NativeOperationReader
) {
  const claudeRelayDriverStops = new WeakMap<
    object,
    (source: OriginalFrozenRelayDocumentSource) => Promise<void>
  >();
  /** Fixed original drive cancellation/drain; no caller stream or physical closure checker. */
  function stopClaudeOriginalRelayDocumentDrive(
    runtime: object,
    source: OriginalFrozenRelayDocumentSource
  ): Promise<void> {
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    const stop = claudeRelayDriverStops.get(runtime);
    if (!stop) throw new Error('Original Claude Relay drive stop unavailable');
    return stop(source);
  }
  const claudeRelayDrivers = new WeakMap<
    object,
    (source: OriginalFrozenRelayDocumentSource) => Promise<'busy' | 'drained'>
  >();
  /** Fixed lookup of the original constructor drive, never a caller holder/stream/projector/emitter. */
  function driveClaudeOriginalRelayDocument(
    runtime: object,
    source: OriginalFrozenRelayDocumentSource
  ): Promise<'busy' | 'drained'> {
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    const run = claudeRelayDrivers.get(runtime);
    if (!run) throw new Error('Original installed Claude Relay drive unavailable');
    return run(source);
  }
  const claudeRelayPreparers = new WeakMap<
    object,
    (
      source: OriginalFrozenRelayDocumentSource,
      holder: SseResponse,
      key: string
    ) => Promise<PreparedRelayDocumentResponder | undefined>
  >();
  const claudeRelayPrepared = new WeakMap<
    PreparedRelayDocumentResponder,
    {
      runtime: object;
      source: OriginalFrozenRelayDocumentSource;
      operation: object;
      acquisition: NativeSessionAcquisition;
      retire: () => Promise<void>;
      claimStarted?: boolean;
      launch: OriginalPreparedRelaySdkLaunch;
      session: AgentSession;
      process: OriginalDocumentProcessReservation;
      commit: () => Promise<import('@dorkos/db/internal-server').OriginalRelayNativeClaim>;
      claim?: import('@dorkos/db/internal-server').OriginalRelayNativeClaim;
      principals: import('../../../connectors/runtime-principal-port.js').ConnectorRuntimePrincipalPort;
      send: () => AsyncGenerator<StreamEvent>;
      sendStarted?: boolean;
      projector?: SessionStateProjector;
      projectionStream?: object;
      projectionFeed?: OriginalSessionProjectionFeed;
      projectedStart?: SessionEvent;
      turnStartSeq?: number;
      completed?: boolean;
      lastDone?: StreamEvent;
      projectedEnd?: SessionEvent;
      runOutcome?: ReturnType<ReturnType<typeof createRunOutcomeTracker>['settle']>;
    }
  >();
  const originalRelayLaunchPreparations = new WeakMap<
    OriginalPreparedRelaySdkLaunch,
    PreparedRelayDocumentResponder
  >();
  const originalClaudeRelayProjectionStreams = new WeakMap<
    object,
    PreparedRelayDocumentResponder
  >();
  /** Lookup-only exact original stream/projector binding; no caller projection flag or registration. */
  function readOriginalClaudeRelayProjectionProjector(
    stream: object
  ): SessionStateProjector | undefined {
    const prepared = originalClaudeRelayProjectionStreams.get(stream),
      own = prepared && claudeRelayPrepared.get(prepared);
    if (!prepared || !own || !own.sendStarted || !own.projector) return undefined;
    requireClaudeOriginalRelayPreparedTuple(own.runtime, prepared, own.source, own.operation);
    return own.projector;
  }
  /** Called by the actual fixed normalizer with its private active feed token and original stamped start. */
  function observeOriginalClaudeRelayProjection(
    stream: object,
    projector: SessionStateProjector,
    event: SessionEvent,
    feed: OriginalSessionProjectionFeed
  ): void {
    const prepared = originalClaudeRelayProjectionStreams.get(stream),
      own = prepared && claudeRelayPrepared.get(prepared);
    if (
      !prepared ||
      !own ||
      own.projector !== projector ||
      own.projectedStart ||
      own.turnStartSeq !== undefined
    )
      throw new Error('Original Relay projection already consumed or unavailable');
    requireClaudeOriginalRelayPreparedTuple(own.runtime, prepared, own.source, own.operation);
    requireOriginalSessionProjectionFeed(feed, stream, projector, event);
    if (event.type !== 'turn_start' || !Number.isSafeInteger(event.seq) || event.seq < 1)
      throw new Error('Original Relay durable turn_start required');
    own.projectionStream = stream;
    own.projectionFeed = feed;
    own.projectedStart = event;
    own.turnStartSeq = event.seq;
  }
  /** Original sender done identity plus actual fixed stamped end; no caller terminal flag. */
  function observeOriginalClaudeRelayTerminalProjection(
    stream: object,
    projector: SessionStateProjector,
    event: SessionEvent,
    feed: OriginalSessionProjectionFeed,
    terminal: StreamEvent
  ): void {
    const prepared = originalClaudeRelayProjectionStreams.get(stream),
      own = prepared && claudeRelayPrepared.get(prepared);
    if (
      !own ||
      !own.sendStarted ||
      !own.claim ||
      own.lastDone !== terminal ||
      terminal.type !== 'done' ||
      own.projector !== projector ||
      own.projectionStream !== stream ||
      own.projectionFeed !== feed ||
      !own.projectedStart ||
      event.type !== 'turn_end' ||
      event.seq <= own.projectedStart.seq
    )
      throw new Error('Original Relay terminal projection differs');
    requireOriginalSessionProjectionFeed(feed, stream, projector, own.projectedStart);
    // Event identity is retained by the fixed projector, not a caller DATA sequence.
    requireOriginalSessionProjection(projector, event);
    own.projectedEnd = event;
  }
  const originalRelayClosedTurns = new WeakMap<
    OriginalClaudeRelayClosedTurn,
    {
      runtime: object;
      source: OriginalFrozenRelayDocumentSource;
      claim: import('@dorkos/db/internal-server').OriginalRelayNativeClaim;
      turnStartSeq: number;
      turnEndSeq: number;
      outcome: 'completed' | 'failed' | 'blocked';
    }
  >();
  const originalRelayClosedTurnReaders = new WeakMap<
    object,
    (source: OriginalFrozenRelayDocumentSource) => OriginalClaudeRelayClosedTurn
  >();
  /** Lookup-only actual constructor drive closure; no supplied projection/holder/process flag. */
  function readOriginalClaudeRelayClosedTurn(
    runtime: object,
    source: OriginalFrozenRelayDocumentSource
  ): OriginalClaudeRelayClosedTurn {
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    const read = originalRelayClosedTurnReaders.get(runtime);
    if (!read) throw new Error('Original Relay closed turn reader unavailable');
    return read(source);
  }
  /** Correlation DATA follows original token identity; model outcome still needs actual terminal policy. */
  function readOriginalClaudeRelayClosedTurnData(
    token: OriginalClaudeRelayClosedTurn,
    runtime: object,
    source: OriginalFrozenRelayDocumentSource,
    claim: import('@dorkos/db/internal-server').OriginalRelayNativeClaim
  ) {
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    const own = originalRelayClosedTurns.get(token);
    if (!own || own.runtime !== runtime || own.source !== source || own.claim !== claim)
      throw new Error('Original Relay closed turn identity differs');
    return Object.freeze({
      turnStartSeq: own.turnStartSeq,
      turnEndSeq: own.turnEndSeq,
      outcome: own.outcome,
    });
  }
  /** Actual durable projector sequence only, separate from query/spawn FIRST facts. */
  function readOriginalClaudeRelayProjectedTurnStart(
    runtime: object,
    prepared: PreparedRelayDocumentResponder,
    source: OriginalFrozenRelayDocumentSource,
    operation: object
  ): number {
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    requireClaudeOriginalRelayPreparedTuple(runtime, prepared, source, operation);
    const own = claudeRelayPrepared.get(prepared)!;
    if (
      !own.projector ||
      !own.projectionStream ||
      !own.projectionFeed ||
      !own.projectedStart ||
      own.turnStartSeq === undefined
    )
      throw new Error('Original Relay projected turn_start unavailable');
    const feed = own.projectionFeed;
    // The fixed feed recognizer checks its original stream, projector, stamped event and active lifetime.
    requireOriginalSessionProjectionFeed(
      feed,
      own.projectionStream,
      own.projector,
      own.projectedStart
    );
    return own.turnStartSeq;
  }

  /** Commit the original Claude Relay query-start handoff. */
  async function commitOriginalClaudeRelayQueryStart(
    session: AgentSession,
    launch: OriginalPreparedRelaySdkLaunch
  ): Promise<void> {
    const prepared = originalRelayLaunchPreparations.get(launch),
      own = prepared && claudeRelayPrepared.get(prepared);
    if (!prepared || !own || own.session !== session || own.launch !== launch || !own.sendStarted)
      throw new Error('Original Relay sender unavailable');
    readOriginalClaudeRelayProjectedTurnStart(own.runtime, prepared, own.source, own.operation);
    own.claim = await claimClaudeOriginalRelayDocument(own.runtime, prepared);
  }
  /** Require currentness of the original Claude Relay query-start handoff. */
  function requireOriginalClaudeRelayQueryStart(
    session: AgentSession,
    launch: OriginalPreparedRelaySdkLaunch
  ): void {
    const prepared = originalRelayLaunchPreparations.get(launch),
      own = prepared && claudeRelayPrepared.get(prepared);
    if (
      !prepared ||
      !own ||
      own.session !== session ||
      own.launch !== launch ||
      !own.sendStarted ||
      !own.claim
    )
      throw new Error('Original committed Relay sender unavailable');
    requireOriginalPreparedRelayDocumentClaimCurrent(
      own.source,
      own.runtime,
      prepared,
      own.operation,
      own.claim,
      own.principals
    );
  }
  /** One actual constructor-owned stream. Return/throw reach actual query before queued delegate drain. */
  function sendClaudeOriginalRelayDocument(
    runtime: object,
    prepared: PreparedRelayDocumentResponder
  ): AsyncGenerator<StreamEvent> {
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    const own = claudeRelayPrepared.get(prepared);
    if (!own || own.runtime !== runtime || own.sendStarted)
      throw new Error('Original Relay sender consumed or unavailable');
    // Consume before original source/projector lookups: their listeners may reenter.
    own.sendStarted = true;
    const target = readOriginalFrozenRelayDocumentTarget(own.source, own.principals, 'claude-code');
    own.projector = getOrCreateProjector(target.sessionId, target.agentPath);
    const delegate = own.send();
    const tracker = createRunOutcomeTracker(),
      observe = tracker.observe.bind(tracker),
      settle = tracker.settle.bind(tracker);
    const close = async (kind: 'return' | 'throw', value: unknown) => {
      let failed = false;
      let first: unknown;
      let result: IteratorResult<StreamEvent, void> | undefined;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      // This call runs synchronously before the first await, reaching a held next().
      try {
        stopOriginalRelaySdkQuery(own.launch, own.session);
      } catch (cause) {
        remember(cause);
      }
      const delegateDrain = Promise.resolve()
        .then(async () => {
          result =
            kind === 'return' ? await delegate.return(value as void) : await delegate.throw(value);
        })
        .catch(remember);
      const physicalDrain = Promise.resolve()
        .then(() => drainOriginalRelaySdkQuery(own.launch, own.session))
        .catch(remember);
      await Promise.allSettled([delegateDrain, physicalDrain]);
      if (failed) throw first;
      return result!;
    };
    const stream: AsyncGenerator<StreamEvent> = {
      next(value) {
        return delegate.next(value).then((result) => {
          if (result.done) {
            own.runOutcome = settle();
            own.completed = true;
          } else {
            observe(result.value);
            if (result.value.type === 'done') own.lastDone = result.value;
          }
          return result;
        });
      },
      return(value) {
        return close('return', value);
      },
      throw(cause) {
        return close('throw', cause);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      [Symbol.asyncDispose]() {
        return close('return', undefined).then(() => {});
      },
    };
    originalClaudeRelayProjectionStreams.set(stream, prepared);
    return stream;
  }
  /** Only the original constructor lock/session/native operation preparation; no SDK start capability. */
  function prepareClaudeOriginalRelayDocument(
    runtime: object,
    source: OriginalFrozenRelayDocumentSource,
    holder: SseResponse,
    key: string
  ): Promise<PreparedRelayDocumentResponder | undefined> {
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    return claudeRelayPreparers.get(runtime)?.(source, holder, key) ?? Promise.resolve(undefined);
  }
  /** Read the original Claude Relay document preparation. */
  function readClaudePreparedRelayDocument(
    runtime: object,
    prepared: PreparedRelayDocumentResponder
  ) {
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    const own = claudeRelayPrepared.get(prepared);
    if (!own || own.runtime !== runtime) return undefined;
    const native = readClaudeNativeOperation(own.operation),
      at = Date.now();
    const activity = captureNativeSessionActivity(own.acquisition, at);
    if (
      !native ||
      !activity ||
      !readNativeSessionAcquisition(own.acquisition, activity, at, native.canonicalSessionId)
    )
      return undefined;
    return Object.freeze({
      source: own.source,
      nativeOperation: own.operation,
      acquisition: own.acquisition,
      native,
    });
  }
  /** Fixed actual constructor tuple, never a caller-supplied currentness callback. */
  function requireClaudeOriginalRelayPreparedTuple(
    runtime: object,
    prepared: PreparedRelayDocumentResponder,
    source: OriginalFrozenRelayDocumentSource,
    operation: object
  ): void {
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    const own = claudeRelayPrepared.get(prepared);
    if (
      !own ||
      own.runtime !== runtime ||
      own.source !== source ||
      own.operation !== operation ||
      !readClaudePreparedRelayDocument(runtime, prepared)
    )
      throw new Error('Original current Relay native preparation required');
    requireOriginalPreparedRelaySdkLaunch(own.launch, own.session);
  }
  /** Consume only the real constructor's original source/operation. This commits DATA, not SDK FIRST. */
  function claimClaudeOriginalRelayDocument(
    runtime: object,
    prepared: PreparedRelayDocumentResponder
  ) {
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    const own = claudeRelayPrepared.get(prepared);
    if (!own || own.runtime !== runtime || own.claimStarted)
      throw new Error('Original Relay claim already consumed or unavailable');
    // Consume before native acquisition/currentness work, which may invoke original observers.
    own.claimStarted = true;
    readOriginalClaudeRelayProjectedTurnStart(runtime, prepared, own.source, own.operation);
    return own.commit();
  }
  /** Retire the original Claude Relay document preparation. */
  function retireClaudePreparedRelayDocument(
    runtime: object,
    prepared: PreparedRelayDocumentResponder
  ): Promise<void> {
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    const own = claudeRelayPrepared.get(prepared);
    if (!own || own.runtime !== runtime) throw new Error('Original Relay preparation required.');
    claudeRelayPrepared.delete(prepared);
    return own.retire();
  }
  return Object.freeze({
    claudeRelayDriverStops,
    claudeRelayDrivers,
    claudeRelayPreparers,
    claudeRelayPrepared,
    originalRelayLaunchPreparations,
    originalClaudeRelayProjectionStreams,
    originalRelayClosedTurns,
    originalRelayClosedTurnReaders,
    stopClaudeOriginalRelayDocumentDrive,
    driveClaudeOriginalRelayDocument,
    readOriginalClaudeRelayProjectionProjector,
    observeOriginalClaudeRelayProjection,
    observeOriginalClaudeRelayTerminalProjection,
    readOriginalClaudeRelayClosedTurn,
    readOriginalClaudeRelayClosedTurnData,
    readOriginalClaudeRelayProjectedTurnStart,
    requireOriginalClaudeRelayQueryStart,
    commitOriginalClaudeRelayQueryStart,
    sendClaudeOriginalRelayDocument,
    prepareClaudeOriginalRelayDocument,
    readClaudePreparedRelayDocument,
    requireClaudeOriginalRelayPreparedTuple,
    claimClaudeOriginalRelayDocument,
    retireClaudePreparedRelayDocument,
  });
}
