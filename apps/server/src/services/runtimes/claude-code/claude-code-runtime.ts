import { createRunOutcomeTracker } from '@dorkos/shared/run-outcome';
import {
  requireOriginalSessionProjection,
  readOriginalSessionProjectionSequence,
} from '../../session/session-state-projector.js';
import { DetachedTurnLifecycle, readOriginalRoomLaunchHolder } from '../../session/trigger-turn.js';
import { feedProjector } from '../../session/session-event-normalizer.js';
import {
  requireOriginalSessionProjectionFeed,
  requireOriginalClosedSessionProjectionFeed,
  type OriginalSessionProjectionFeed,
} from '../../session/session-event-normalizer.js';
import type { OriginalDocumentProcessReservation } from '@dorkos/relay/server-private-document';
import {
  prepareOriginalRelaySdkLaunch,
  requireOriginalPreparedRelaySdkLaunch,
  retireOriginalPreparedRelaySdkLaunch,
  stopOriginalRelaySdkQuery,
  drainOriginalRelaySdkQuery,
  type OriginalPreparedRelaySdkLaunch,
} from './messaging/relay/relay-sdk-launch.js';
import {
  claimOriginalPreparedRelayDocumentFacts,
  requireOriginalPreparedRelayDocumentClaimCurrent,
  readOriginalFrozenRelayDocumentTarget,
  readOriginalFrozenRelayDocumentLaunchInput,
  reserveOriginalFrozenRelayDocumentProcess,
} from '../../canvas/doc-channel/delivery/relay-authority.js';
import type {
  OriginalFrozenRelayDocumentSource,
  PreparedRelayDocumentResponder,
} from '../../canvas/doc-channel/delivery/relay-native-types.js';
const claudeRelayDriverStops = new WeakMap<
  object,
  (source: OriginalFrozenRelayDocumentSource) => Promise<void>
>();
/** Fixed original drive cancellation/drain; no caller stream or physical closure checker. */
export function stopClaudeOriginalRelayDocumentDrive(
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
export function driveClaudeOriginalRelayDocument(
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
    principals: import('../../connectors/runtime-principal-port.js').ConnectorRuntimePrincipalPort;
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
const originalClaudeRelayProjectionStreams = new WeakMap<object, PreparedRelayDocumentResponder>();
/** Lookup-only exact original stream/projector binding; no caller projection flag or registration. */
export function readOriginalClaudeRelayProjectionProjector(
  stream: object
): SessionStateProjector | undefined {
  const prepared = originalClaudeRelayProjectionStreams.get(stream),
    own = prepared && claudeRelayPrepared.get(prepared);
  if (!prepared || !own || !own.sendStarted || !own.projector) return undefined;
  requireClaudeOriginalRelayPreparedTuple(own.runtime, prepared, own.source, own.operation);
  return own.projector;
}
/** Called by the actual fixed normalizer with its private active feed token and original stamped start. */
export function observeOriginalClaudeRelayProjection(
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
export function observeOriginalClaudeRelayTerminalProjection(
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
export interface OriginalClaudeRelayClosedTurn {
  readonly kind: 'original-claude-relay-closed-turn';
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
export function readOriginalClaudeRelayClosedTurn(
  runtime: object,
  source: OriginalFrozenRelayDocumentSource
): OriginalClaudeRelayClosedTurn {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const read = originalRelayClosedTurnReaders.get(runtime);
  if (!read) throw new Error('Original Relay closed turn reader unavailable');
  return read(source);
}
/** Correlation DATA follows original token identity; model outcome still needs actual terminal policy. */
export function readOriginalClaudeRelayClosedTurnData(
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
export function readOriginalClaudeRelayProjectedTurnStart(
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
export async function commitOriginalClaudeRelayQueryStart(
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
export function requireOriginalClaudeRelayQueryStart(
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
export function sendClaudeOriginalRelayDocument(
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
export function prepareClaudeOriginalRelayDocument(
  runtime: object,
  source: OriginalFrozenRelayDocumentSource,
  holder: SseResponse,
  key: string
): Promise<PreparedRelayDocumentResponder | undefined> {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return claudeRelayPreparers.get(runtime)?.(source, holder, key) ?? Promise.resolve(undefined);
}
/** Read the original Claude Relay document preparation. */
export function readClaudePreparedRelayDocument(
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
export function requireClaudeOriginalRelayPreparedTuple(
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
export function claimClaudeOriginalRelayDocument(
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
export function retireClaudePreparedRelayDocument(
  runtime: object,
  prepared: PreparedRelayDocumentResponder
): Promise<void> {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = claudeRelayPrepared.get(prepared);
  if (!own || own.runtime !== runtime) throw new Error('Original Relay preparation required.');
  claudeRelayPrepared.delete(prepared);
  return own.retire();
}
import {
  readOriginalRegisteredNativeStream,
  readOriginalRegisteredRuntime,
} from '../../core/runtime-registry.js';
const originalClaudeLockedStreams = new WeakMap<
  object,
  { runtime: object; sessionId: string; current(): boolean }
>();
/** Fixed constructor-created stream identity plus the original live acquisition; never a supplied stream matcher. */
export function readClaudeOriginalLockedStream(
  runtime: object,
  sessionId: string,
  stream: object
): boolean {
  const own = originalClaudeLockedStreams.get(stream);
  return !!own && own.runtime === runtime && own.sessionId === sessionId && own.current();
}
import { isNonFatalErrorCode, isAbsolvingTerminalReason } from '@dorkos/shared/run-outcome';
import { isInterruptedTerminalReason } from '@dorkos/shared/schemas';
const originalClaudeRoomStreams = new WeakMap<
  object,
  {
    runtime: object;
    prepared: PreparedRoomResponder;
    operation: object;
    committed: OriginalCommittedRoomResponder;
    emitted: WeakSet<object>;
    close(): Promise<IteratorResult<StreamEvent, void>>;
    reason?: string;
    failed: boolean;
    done: boolean;
  }
>();
/** Retire the original Claude Room responder stream and its captured lifecycle. */
export async function retireClaudeOriginalRoomResponderStream(stream: object): Promise<void> {
  const own = originalClaudeRoomStreams.get(stream);
  if (!own) return;
  originalClaudeRoomStreams.delete(stream);
  let failed = false,
    first: unknown;
  try {
    retireOriginalCommittedRoomResponder(own.committed, own.runtime, own.prepared, own.operation);
  } catch (cause) {
    failed = true;
    first = cause;
  }
  try {
    await own.close();
  } catch (cause) {
    if (!failed) {
      failed = true;
      first = cause;
    }
  }
  if (failed) throw first;
}
/** Read evidence from the original Claude Room responder stream. */
export function readClaudeOriginalRoomResponderStream(
  runtime: object | undefined,
  stream: object,
  event?: StreamEvent
) {
  stream = readOriginalRegisteredNativeStream(stream) ?? stream;
  if (runtime) runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;

  const own = originalClaudeRoomStreams.get(stream);
  if (!own) return undefined;
  if (
    (runtime !== undefined && own.runtime !== runtime) ||
    readClaudePreparedRoomResponder(own.runtime, own.prepared)?.nativeOperation !== own.operation ||
    (event !== undefined && !own.emitted.has(event))
  )
    throw new Error('Original Room stream retired or changed.');
  return Object.freeze({
    runtime: own.runtime,
    prepared: own.prepared,
    operation: own.operation,
    committed: own.committed,
    outcome: own.done
      ? own.reason === 'error' || (own.failed && !isAbsolvingTerminalReason(own.reason))
        ? ('failed' as const)
        : isInterruptedTerminalReason(own.reason)
          ? ('cancelled' as const)
          : ('turn_done' as const)
      : undefined,
  });
}
import { readOriginalPersistentRoomState } from './sessions/persistent-dispatch.js';
import {
  captureOriginalRoomDispatchLifecycle,
  readOriginalRoomDispatchLifecycle,
} from '../../session/trigger-turn.js';
import type { OriginalRoomDispatchCustody } from '../../rooms/service/room-core.js';
import {
  readOriginalFrozenRoomTarget,
  requireOriginalRoomPrincipalService,
  requireOriginalCommittedRoomResponder,
  consumeOriginalCommittedRoomResponder,
  retireOriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/operations/room-current-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/current/current-operation-types.js';
import { readClaudeConnectorContext } from './connector-turn-context.js';
import { isCurrentClaudeNativeSession } from './sessions/session-store.js';
import { AccountsAccessContext } from '../shared/accounts-access-context.js';
/**
 * Claude Code Runtime — implements the AgentRuntime interface for the Claude Agent SDK.
 *
 * Thin facade that coordinates SessionStore, RuntimeCache, TranscriptReader,
 * SessionLockManager, and CommandRegistryService.
 *
 * @module services/runtimes/claude-code/claude-code-runtime
 */
import { runtimeEnvironment } from '../shared/runtime-environment-config.js';
import { setAccountProbeBinaryResolver } from './accounts/account-probe.js';
import path from 'path';
import { renameSession as sdkRenameSession, query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, Query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type {
  StreamEvent,
  ModelOption,
  SubagentInfo,
  Session,
  HistoryMessage,
  TaskItem,
  CommandRegistry,
  ReloadPluginsResult,
  SessionListWarning,
  SessionSettings,
} from '@dorkos/shared/types';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  SessionOpts,
  MessageOpts,
  CommandIntentOpts,
  SseResponse,
  AgentRegistryPort,
  RelayPort,
  SessionSettingsPort,
  McpAppServerConnection,
  InteractionAnswerOptions,
  ToolDecisionOptions,
  SessionWarmth,
  DeliverIntoTurnOpts,
  RuntimeDeliveryResult,
  SessionUpdateResult,
  InterruptReceipt,
} from '@dorkos/shared/agent-runtime';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { CLAUDE_CODE_CAPABILITIES, narrowToClaudeCodeMode } from './runtime-constants.js';
import { ControlRequestTimeoutError } from './sessions/bounded-control.js';
import { SessionStore, isOriginalClaudeSessionAlias } from './sessions/session-store.js';
import { RuntimeCache } from './messaging/runtime-cache.js';
import {
  PluginReloadScheduler,
  PluginReloadSessionGoneError,
  conversationTokens,
  pluginReloadIsWorthHolding,
  readCacheImpact,
  type PaidPluginReload,
  type PluginReloadCacheImpact,
} from './messaging/plugin-reload-policy.js';
import {
  SessionLockManager,
  runtimeLockHolder,
  requireOriginalNativeSessionAcquisitionRetired,
  captureNativeSessionAcquisition,
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  isNativeSessionAcquisitionMove,
  isOriginalNativeSessionAcquisitionAlias,
  type NativeSessionAcquisition,
} from '../../session/session-lock.js';
import type { AgentSession } from './agent-types.js';
import {
  resolveClaudeBinaryBeforePath,
  resolveClaudeCliPath,
  createIdlePrompt,
} from './sdk/sdk-utils.js';
import {
  claudeConfigDirEnv,
  resolveActiveClaudeRoot,
  resolveLaunchAccountRoot,
  accountIdForRoot,
  type LaunchAccountResolution,
} from './claude-config-dir.js';
import { isCreditsClaudeRoot } from './credits-root.js';
import { detectAuthError } from '@dorkos/shared/runtime-error-classification';
import {
  asCreditsStopped,
  creditsStoppedEvent,
  onCreditsSession,
} from './messaging/credits-launch.js';
import { withClaudeConfigDir } from './claude-config-env-lock.js';
import { logger } from '../../../lib/logger.js';
import { SESSIONS } from '../../../config/constants.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { TranscriptReader } from './sessions/transcript-reader.js';
import type { TranscriptImageRef } from './sessions/transcript-parser.js';
import { attachTranscriptImages } from './media-capture.js';
import type { SessionAttachmentStore } from '../../session/attachments/index.js';
import { SessionPumpRegistry } from './sessions/session-pump-registry.js';
import { CommandRegistryService } from './tooling/command-registry.js';
import { executeSdkQuery } from './messaging/message-sender.js';
import type { McpServerFactory, MessageSenderOpts } from './messaging/message-sender-shared.js';
import { PersistentDispatch } from './sessions/persistent-dispatch.js';
import { BackgroundWorkLedger } from './messaging/background-work-ledger.js';
import { watchSessionList } from './sessions/session-list-watcher.js';
import {
  homeOf,
  readHomeManifest,
  resolveAgentHome,
  turnAgentOf,
} from '../../core/agent-identity/index.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { projectOfFolder } from '../../core/usage/account-eligibility.js';
import { checkClaudeLaunchAccount } from './launch-account-check.js';
import { predictLaunchBillsPerToken, readPerTokenSignals } from './messaging/per-token-billing.js';
import {
  disposeProjector,
  getOrCreateProjector,
  overlayApprovalReceipts,
  overlayModelSubstitutions,
  overlayAgentCompactions,
  overlayPermissionDenials,
  peekProjector,
  streamGenerationOf,
} from '../../session/index.js';
import { mcpAuthEvidenceFrom } from '../../mesh/mcp-revocation.js';
import type { McpAuthEvidencePort } from '../../mesh/mcp-revocation.js';

/**
 * Where a plugin reload that cost something goes to be remembered.
 *
 * Best-effort by contract: it is handed a fact and must never throw one back —
 * a feed that cannot be written is not a reason for a reload to fail.
 */
export type PluginReloadActivityPort = (entry: PaidPluginReload) => void;
import { editBaselineStore } from '../../diff/index.js';
import type { SessionStateProjector } from '../../session/index.js';
import type { ConnectorRuntimeTools } from '../connector-tools.js';
import type { RevokeConnectorTurnReason } from '../../connectors/runtime-principal-port.js';
import {
  resolveOriginalClaudeConnectorPrincipal,
  ClaudeConnectorTurnContext,
} from './connector-turn-context.js';

export { buildTaskEvent } from './sdk/build-task-event.js';

/**
 * Claude Code runtime implementing the universal AgentRuntime interface.
 *
 * Manages Claude Agent SDK sessions — creation, resumption, streaming, tool approval,
 * and session locking. Delegates to focused collaborators for session state (SessionStore),
 * SDK response caching (RuntimeCache), transcript reading, broadcasting, and locking.
 */
type ClaudeNativeEntry = {
  roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
  acquisition?: NativeSessionAcquisition;
  instance: object;
  session: AgentSession;
  store: SessionStore;
  retired: boolean;
  runtime: 'claude-code';
  key: string;
  agentPath: string | undefined;
  cwd: string;
  context?: ClaudeConnectorTurnContext;
};
const claudeLockMoves = new WeakMap<
  object,
  (oldKey: string, canonicalKey: string, holder: SseResponse) => boolean
>();
/** Closed genuine Claude canonical move; caller strings cannot change the runtime's original session identity. */
export function moveClaudeOriginalLockedAcquisition(
  runtime: object,
  oldKey: string,
  canonicalKey: string,
  holder: SseResponse
): boolean | undefined {
  return claudeLockMoves.get(runtime)?.(oldKey, canonicalKey, holder);
}
const claudeLockedRunners = new WeakMap<
  object,
  (
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    holder: SseResponse,
    lockKey: string
  ) => AsyncGenerator<StreamEvent>
>();
/** Original constructor-owned turn entry. A holder selects data; it cannot issue lock/principal authority. */
export function sendClaudeOriginalLockedMessage(
  runtime: object,
  sessionId: string,
  content: string,
  opts: MessageOpts | undefined,
  holder: SseResponse,
  lockKey: string
): AsyncGenerator<StreamEvent> | undefined {
  return claudeLockedRunners.get(runtime)?.(sessionId, content, opts, holder, lockKey);
}
const claudeRoomPreparers = new WeakMap<
  object,
  (
    source: OriginalFrozenRoomSource,
    holder: SseResponse,
    key: string
  ) => Promise<PreparedRoomResponder | undefined>
>();
type ClaudePreparedRoomContinuation = {
  prepared: PreparedRoomResponder;
  committed?: OriginalCommittedRoomResponder;
  runtime: ClaudeCodeRuntime;
  session: AgentSession;
  sessionId: string;
  nativeOperation: object;
  nativeEntry: ClaudeNativeEntry;
  runtimeEntries: Map<string, ClaudeNativeEntry>;
  connectorTurn: ClaudeConnectorTurnContext;
  acquisition: NativeSessionAcquisition;
  started: boolean;
  entered: boolean;
  finished: boolean;
  consumed: boolean;
  stopRead?: () => Promise<void>;
  retire: () => Promise<void>;
};
const claudeRoomQuerySessions = new WeakMap<AgentSession, ClaudePreparedRoomContinuation>();
/** Fixed sender boundary: ordinary sessions do not acquire dedicated start authority. */
export function requireOriginalClaudeRoomQueryStart(
  session: AgentSession
): ((query: Query) => void) | undefined {
  const own = claudeRoomQuerySessions.get(session);
  if (!own) return;
  if (
    !own.started ||
    own.finished ||
    own.consumed ||
    !own.committed ||
    !readClaudePreparedRoomResponder(own.runtime, own.prepared) ||
    own.nativeEntry.session !== session ||
    session.connectorTurn !== own.connectorTurn
  )
    throw new Error('Room committed start authority is not available.');
  own.consumed = true;
  consumeOriginalCommittedRoomResponder(
    own.committed,
    own.runtime,
    own.prepared,
    own.nativeOperation
  );
  // Returned only by the original one-use committed query-start boundary.
  return (query) => {
    own.stopRead = () => {
      query.close();
      return Promise.resolve();
    };
    if (own.finished || own.nativeEntry.retired) query.close();
  };
}
const claudeRoomPrepared = new WeakMap<
  PreparedRoomResponder,
  {
    runtime: object;
    retire: () => Promise<void>;
    source: OriginalFrozenRoomSource;
    nativeOperation: object;
    acquisition: NativeSessionAcquisition;
    start: (committed: OriginalCommittedRoomResponder) => AsyncGenerator<StreamEvent>;
  }
>();
const claudeOriginalStores = new WeakMap<object, SessionStore>();
/** Preparation uses only the original constructor, approved source data and real lock acquisition. */
export function prepareClaudeOriginalLockedRoomResponder(
  runtime: object,
  holder: SseResponse,
  key: string,
  source: OriginalFrozenRoomSource
): Promise<PreparedRoomResponder | undefined> {
  const prepare = claudeRoomPreparers.get(runtime);
  if (!prepare) return Promise.resolve(undefined);
  return prepare(source, holder, key);
}
/** Retire only the captured preparation before awaited context revocation. */
export function retireClaudePreparedRoomResponder(
  runtime: object,
  prepared: PreparedRoomResponder
): Promise<void> {
  const own = claudeRoomPrepared.get(prepared);
  if (!own || own.runtime !== runtime)
    throw new Error('Room responder preparation is not original.');
  claudeRoomPrepared.delete(prepared);
  return own.retire();
}
/** Fixed lookup of one genuinely constructor-prepared entry; returned identities never register authority. */
export function readClaudePreparedRoomResponder(runtime: object, prepared: PreparedRoomResponder) {
  const own = claudeRoomPrepared.get(prepared);
  if (!own || own.runtime !== runtime) return undefined;
  const at = Date.now(),
    activity = captureNativeSessionActivity(own.acquisition, at);
  const native = readClaudeNativeOperation(own.nativeOperation);
  if (
    !activity ||
    !native ||
    native.acquisition !== own.acquisition ||
    !readNativeSessionAcquisition(own.acquisition, activity, at, native.canonicalSessionId) ||
    claudeRoomPrepared.get(prepared) !== own ||
    !readClaudeNativeOperation(own.nativeOperation)
  )
    return undefined;
  return Object.freeze({
    source: own.source,
    nativeOperation: own.nativeOperation,
    acquisition: own.acquisition,
    native,
  });
}

/** Continue the exact prepared entry only with authentic COMMIT and private FIRST custody. */
export function startClaudeCommittedRoomResponder(
  runtime: object,
  prepared: PreparedRoomResponder,
  committed?: OriginalCommittedRoomResponder
): AsyncGenerator<StreamEvent> {
  const own = claudeRoomPrepared.get(prepared);
  if (!own || own.runtime !== runtime)
    throw new Error('Room responder preparation is not original.');
  requireOriginalCommittedRoomResponder(committed, runtime, prepared, own.nativeOperation);
  return own.start(committed!);
}
const originalClaudePersistentRequests = new WeakMap<
  object,
  { persistent: PersistentDispatch; continuation: ClaudePreparedRoomContinuation }
>();
/** Fixed request lookup; copied args or a public dispatch cannot issue a dedicated turn. */
export function readOriginalClaudeRoomPersistentRequest(
  persistent: object,
  args: object
): object | undefined {
  const own = originalClaudePersistentRequests.get(args);
  if (!own) return undefined;
  const entry = own.continuation;
  if (
    own.persistent !== persistent ||
    !entry.started ||
    entry.finished ||
    !entry.committed ||
    readClaudePreparedRoomResponder(entry.runtime, entry.prepared)?.nativeOperation !==
      entry.nativeOperation
  )
    throw new Error('Original persistent Room request retired.');
  return args;
}
/** Every final effect is bound to the exact private request/session/prepared entry. */
export function requireOriginalClaudeRoomPersistentEffect(persistent: object, args: object): void {
  const own = originalClaudePersistentRequests.get(args);
  if (!own || readOriginalClaudeRoomPersistentRequest(persistent, args) !== args)
    throw new Error('Persistent Room effect lacks original request custody.');
  requireOriginalClaudeRoomQueryStart(own.continuation.session);
}
/** Ordinary persistent calls cannot operate a live dedicated native session. */
export function requireOriginalClaudePersistentSession(
  persistent: object,
  args: { session: AgentSession }
): void {
  const dedicated = claudeRoomQuerySessions.get(args.session);
  if (dedicated && !dedicated.finished && !originalClaudePersistentRequests.has(args))
    throw new Error('Dedicated Room session requires its original persistent request.');
  if (originalClaudePersistentRequests.has(args))
    readOriginalClaudeRoomPersistentRequest(persistent, args);
}
const claudeOriginalLaunchAliases = new WeakMap<
  object,
  (request: import('../../rooms/room-turn-port.js').RoomTurnRequest, retiredId: string) => boolean
>();
/** Fixed original constructor lookup; no runtime method override or caller checker grants an exemption. */
export function isClaudeOriginalRoomLaunchAlias(
  runtime: object,
  request: import('../../rooms/room-turn-port.js').RoomTurnRequest,
  retiredId: string
): boolean {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return claudeOriginalLaunchAliases.get(runtime)?.(request, retiredId) === true;
}
const claudeNativeConstructors = new WeakSet<object>();
const claudeNativeOperations = new WeakMap<object, ClaudeNativeEntry>();
const claudeRuntimeEntries = new WeakMap<object, Map<string, ClaudeNativeEntry>>();
/** Fixed constructor-owned session and turn lifetime; a reinserted evicted object stays retired. */
export function readClaudeNativeOperation(token: object) {
  const entry = claudeNativeOperations.get(token);
  if (
    entry?.roomOrigin &&
    readOriginalRoomDispatchLifecycle(entry.roomOrigin.holder, entry.instance) !==
      entry.roomOrigin.custody
  ) {
    entry.retired = true;
    return undefined;
  }
  const slot = entry ? Object.getOwnPropertyDescriptor(entry.instance, 'sessionStore') : undefined;
  if (
    entry &&
    (!claudeNativeConstructors.has(entry.instance) ||
      !slot ||
      !('value' in slot) ||
      slot.value !== entry.store)
  ) {
    entry.retired = true;
    return undefined;
  }
  if (!entry || entry.retired || !isCurrentClaudeNativeSession(entry.store, entry.session))
    return undefined;
  const context = Object.getOwnPropertyDescriptor(entry.session, 'connectorTurn');
  const canonical = Object.getOwnPropertyDescriptor(entry.session, 'sdkSessionId');
  if (
    !context ||
    !('value' in context) ||
    context.value !== entry.context ||
    !canonical ||
    !('value' in canonical) ||
    typeof canonical.value !== 'string'
  )
    return undefined;
  const signal = entry.context ? readClaudeConnectorContext(entry.context) : undefined;
  if (!signal || signal.aborted) return undefined;
  return {
    roomCustody: entry.roomOrigin?.custody,
    acquisition: entry.acquisition,
    runtime: entry.runtime,
    canonicalSessionId: canonical.value || entry.key,
    agentPath: entry.agentPath,
    canonicalCwd: entry.cwd,
    signal,
  };
}

/** Run Claude Code sessions with their original SDK and native turn lifetimes. */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly type = 'claude-code' as const;

  // Collaborators
  private readonly sessionStore = new SessionStore();
  private readonly cache: RuntimeCache;
  private readonly transcriptReader: TranscriptReader;
  private readonly lockManager = new SessionLockManager();
  /**
   * The warm SDK processes this runtime holds (spec `persistent-session-runtime`
   * §4). Empty until a session opts in: with
   * `runtimes.claudeCode.persistentSession` off — how it ships — nothing
   * launches a pump, every session reads `cold`, and every reap is a no-op,
   * which is the truth rather than a stub.
   *
   * Keyed through `sessionStore.sessionKeyOf` (below), the ONE resolver that
   * answers "which key is this session's pump filed under" whichever id in
   * its rename chain the caller holds (DOR-1309).
   */
  private readonly pumps = new SessionPumpRegistry((id) => this.sessionStore.sessionKeyOf(id));
  /**
   * The path a message takes when its session holds its process open. Reads the
   * opt-in per session and wires the pump, the turn windower and the crash
   * policy together; see `sessions/persistent-dispatch.ts`. Shares
   * {@link pumps}'s SAME resolver, so the two structures can never learn about
   * a rekey at different times.
   */
  readonly #persistent = new PersistentDispatch(
    this.pumps,
    (id) => this.sessionStore.sessionKeyOf(id),
    (sessionId, impact, contextTokens) =>
      this.notePluginReloadHeld(sessionId, impact, contextTokens),
    // Read on use: the ledger is built in the constructor, after this field.
    () => this.backgroundWork
  );
  /**
   * The durable record of chats whose warm process holds background work, in
   * this runtime's data directory (DOR-2065).
   */
  private readonly backgroundWork: BackgroundWorkLedger;
  /**
   * Plugin reloads this runtime asked for and the CLI held back, waiting for a
   * moment when applying them is free (spec `plugin-reload-cache-cost`).
   *
   * Given the runtime's own session store to read a session's clock from, and
   * this runtime's plain reload to apply with — so a held reload lands through
   * exactly the same call as an unheld one.
   */
  private readonly pluginReloads = new PluginReloadScheduler({
    recheck: (sessionId) => this.recheckHeldPluginReload(sessionId),
    applyNow: (sessionId) => this.applyHeldPluginReload(sessionId),
    recordPaidReload: (entry) => this.recordPaidPluginReload(entry),
  });
  private commandRegistries = new Map<string, CommandRegistryService>();
  private static readonly MAX_COMMAND_REGISTRIES = 50;

  // Configuration
  private readonly cwd: string;
  /**
   * The binary every spawn is pointed at, as last resolved. Read through
   * {@link spawnBinaryPath}, never directly — while it is `undefined` the ladder
   * is re-walked, which is what lets a one-click install reach the very next
   * session (DOR-1334).
   */
  private claudeCliPath: string | undefined;

  // Injected dependencies
  private mcpServerFactory: McpServerFactory | null = null;
  private meshCore: AgentRegistryPort | null = null;
  /** Internal connector tool boundary, installed after boot opens its listener. */
  private connectorRuntimeTools: ConnectorRuntimeTools | undefined;
  private readonly accountsAccess = new AccountsAccessContext();
  private mcpAuthEvidence: McpAuthEvidencePort | undefined;
  private pluginReloadActivity: PluginReloadActivityPort | undefined;
  private bindingRouter: import('../../relay/binding-router.js').BindingRouter | undefined;
  private bindingStore: import('../../relay/binding-store.js').BindingStore | undefined;
  private adapterManager: import('../../relay/adapter-manager.js').AdapterManager | undefined;

  /**
   * Cached Claude Agent SDK `options.plugins` array for the current set of
   * GLOBALLY installed marketplace packages. Empty until
   * `refreshActivatedPlugins()` is called; mutated by that method. This is the
   * only plugin set passed to the SDK: PROJECT-scoped installs are no longer
   * SDK-injected; they reach Claude Code as harness-native projected files
   * (command wrappers, skill symlinks, `.claude/settings.local.json` hooks) via
   * `@dorkos/harness`, so external CLI and DorkOS sessions see the same thing
   * (ADR 260706-192819, amending ADR-0239). Global-scope projection is deferred
   * (DOR-174), so global installs keep SDK injection for now. A global package
   * that runs anything on its own is in it only when a person approved exactly
   * what it runs (`marketplace/global-plugin-consent.ts`, DOR-2306).
   */
  private activatedPlugins: Array<{ type: 'local'; path: string }> = [];

  /**
   * cwds with a command-cache warm probe currently in flight. Dedupes
   * concurrent `getCommands` calls so one cold cwd spawns at most one probe.
   */
  private readonly warmingCwds = new Set<string>();

  /**
   * Last warm-probe failure time (epoch ms) per cwd. Bounds re-probing when the
   * SDK is persistently broken: `warmingCwds` only dedupes concurrent probes, so
   * without this a broken runtime would spawn a fresh timeout-length subprocess
   * on every cold `getCommands` (remount, stale-time expiry, each new cwd).
   */
  private readonly warmFailedAt = new Map<string, number>();

  /** Defensive cap on how long a warm probe waits for `supportedCommands()`. */
  private static readonly WARM_TIMEOUT_MS = 8_000;

  /** After a warm failure, skip re-probing the same cwd for this long. */
  private static readonly WARM_FAILURE_COOLDOWN_MS = 60_000;

  /**
   * Where images this runtime's turns produce are stored, or `null` when the
   * composition root wired none. What makes {@link getCapabilities} answer
   * `mediaOutput: 'attachments'`.
   */
  private readonly attachments: SessionAttachmentStore | null;

  /**
   * Build the runtime over a data directory and a default working directory.
   *
   * @param dorkHome - The resolved data directory.
   * @param cwd - The default working directory.
   * @param attachments - Where a turn's images go. Omitted, the runtime
   *   declares `mediaOutput: 'none'` and says so per image rather than dropping
   *   one quietly — see {@link getCapabilities}.
   */
  readonly #roomPreparing = new Map<string, { retired: boolean }>();

  constructor(dorkHome: string, cwd?: string, attachments?: SessionAttachmentStore) {
    claudeNativeConstructors.add(this);
    const originalLocks = this.lockManager;
    claudeOriginalStores.set(this, this.sessionStore);
    const originalStore = this.sessionStore;
    claudeOriginalLaunchAliases.set(this, (request, retiredId) => {
      const launch = readOriginalRoomLaunchHolder(request);
      if (
        !launch ||
        (readOriginalRegisteredRuntime(launch.runtime) ?? launch.runtime) !== this ||
        !isOriginalClaudeSessionAlias(originalStore, retiredId, launch.key)
      )
        return false;
      const acquisition = captureNativeSessionAcquisition(originalLocks, launch.key, launch.holder);
      return (
        !!acquisition &&
        isOriginalNativeSessionAcquisitionAlias(
          originalLocks,
          acquisition,
          launch.holder,
          launch.key,
          retiredId
        ) &&
        readOriginalRoomLaunchHolder(request) === launch &&
        isOriginalClaudeSessionAlias(originalStore, retiredId, launch.key)
      );
    });
    const originalAcquire = SessionLockManager.prototype.acquireRuntimeLock;
    const originalRelease = SessionLockManager.prototype.releaseLock;
    const originalHolderClose = DetachedTurnLifecycle.prototype.close;
    const originalHolderTouch = DetachedTurnLifecycle.prototype.touch;
    const drives = new WeakMap<OriginalFrozenRelayDocumentSource, Promise<'busy' | 'drained'>>();
    // Failed/UNKNOWN drive resources stay retained by their original constructor until genuine closure.
    const heldDrives = new Map<
      OriginalFrozenRelayDocumentSource,
      {
        holder: DetachedTurnLifecycle;
        acquisition?: NativeSessionAcquisition;
        sessionId: string;
        stopping: boolean;
        naturallyCompleted: boolean;
        prepared?: PreparedRelayDocumentResponder;
        stream?: AsyncGenerator<StreamEvent>;
      }
    >();
    const settlements = new WeakMap<
      OriginalFrozenRelayDocumentSource,
      { settled: boolean; closed: boolean }
    >();
    const stops = new WeakMap<OriginalFrozenRelayDocumentSource, Promise<void>>();
    const closedTurns = new WeakMap<
      OriginalFrozenRelayDocumentSource,
      OriginalClaudeRelayClosedTurn
    >();
    originalRelayClosedTurnReaders.set(this, (source) => {
      const settled = settlements.get(source),
        token = closedTurns.get(source);
      if (!settled?.settled || !settled.closed || heldDrives.has(source) || !token)
        throw new Error('Original Relay closed terminal remains UNKNOWN');
      return token;
    });
    claudeRelayDriverStops.set(this, (source) => {
      const previous = stops.get(source);
      if (previous) return previous;
      const stop = Promise.resolve().then(async () => {
        const drive = drives.get(source),
          settled = settlements.get(source);
        if (!drive || !settled) throw new Error('Original Relay drive identity unavailable');
        const held = heldDrives.get(source);
        let failed = false,
          first: unknown;
        const remember = (cause: unknown) => {
          if (!failed) {
            failed = true;
            first = cause;
          }
        };
        if (held) {
          if (!held.naturallyCompleted) held.stopping = true;
          const preparing = this.#relayPreparing.get(held.sessionId);
          if (preparing) preparing.retired = true;
          if (held.prepared) {
            const own = claudeRelayPrepared.get(held.prepared);
            if (own) {
              try {
                stopOriginalRelaySdkQuery(own.launch, own.session);
              } catch (cause) {
                remember(cause);
              }
            }
          }
          // Invoking original return synchronously reaches owned SDK stop before held next settles.
          let streamDrain: Promise<unknown> | undefined;
          try {
            if (held.stream) streamDrain = held.stream.return(undefined).catch(remember);
          } catch (cause) {
            remember(cause);
          }
          await Promise.allSettled([drive.catch(() => {}), ...(streamDrain ? [streamDrain] : [])]);
        } else await drive.catch(() => {});
        // Only original positive physical/principal/lock closure can absolve an ordinary operation refusal.
        if (!settled.settled || !settled.closed || heldDrives.has(source))
          remember(new Error('Original Relay drive closure UNKNOWN'));
        if (failed) throw first;
      });
      stops.set(source, stop);
      return stop;
    });
    claudeRelayDrivers.set(this, (source) => {
      const previous = drives.get(source);
      if (previous) return previous;
      // Memo before source/native/projector access can reenter the original constructor drive.
      const settlement = { settled: false, closed: false };
      settlements.set(source, settlement);
      const pending = Promise.resolve()
        .then(async (): Promise<'busy' | 'drained'> => {
          const tools = this.connectorRuntimeTools;
          if (!tools) throw new Error('Original Relay native principal assembly unavailable');
          const target = readOriginalFrozenRelayDocumentTarget(
            source,
            tools.principals,
            'claude-code'
          );
          const holder = new DetachedTurnLifecycle();
          const token = Symbol('original-relay-document-lock');
          const held: {
            holder: DetachedTurnLifecycle;
            acquisition?: NativeSessionAcquisition;
            sessionId: string;
            stopping: boolean;
            naturallyCompleted: boolean;
            prepared?: PreparedRelayDocumentResponder;
            stream?: AsyncGenerator<StreamEvent>;
          } = { holder, sessionId: target.sessionId, stopping: false, naturallyCompleted: false };
          heldDrives.set(source, held);
          let acquired = false,
            prepared: PreparedRelayDocumentResponder | undefined,
            stream: AsyncGenerator<StreamEvent> | undefined;
          let preparedOwn: ReturnType<typeof claudeRelayPrepared.get>;
          let failed = false,
            first: unknown,
            nativeClosed = true;
          const remember = (cause: unknown) => {
            if (!failed) {
              failed = true;
              first = cause;
            }
          };
          // Join this scope to its captured cleanup before returning or reporting failure.
          const drainOriginalCleanup = async () => {
            // Start both real drains before awaiting either; no held next can block physical cancellation.
            const drains: Promise<unknown>[] = [];
            if (stream)
              drains.push(
                Promise.resolve()
                  .then(() => stream!.return(undefined))
                  .catch((cause) => {
                    nativeClosed = false;
                    remember(cause);
                  })
              );
            if (prepared)
              drains.push(
                Promise.resolve()
                  .then(() => retireClaudePreparedRelayDocument(this, prepared!))
                  .catch((cause) => {
                    nativeClosed = false;
                    remember(cause);
                  })
              );
            await Promise.allSettled(drains);
            // Private preparation itself may have retained an unresolved original setup owner.
            const unresolved = acquired ? this.#relayPreparing.get(target.sessionId) : undefined;
            if (unresolved) {
              nativeClosed = false;
              remember(
                unresolved.cleanupFailed
                  ? unresolved.cleanupCause
                  : new Error('Original Relay preparation owner remains unresolved')
              );
            }
            if (nativeClosed) {
              try {
                if (acquired)
                  originalRelease.call(
                    originalLocks,
                    target.sessionId,
                    runtimeLockHolder(target.sessionId),
                    token
                  );
              } catch (cause) {
                nativeClosed = false;
                remember(cause);
              }
              try {
                originalHolderClose.call(holder);
              } catch (cause) {
                nativeClosed = false;
                remember(cause);
              }
              if (acquired) {
                try {
                  if (!held.acquisition)
                    throw new Error('Original Relay lock closure witness unavailable');
                  requireOriginalNativeSessionAcquisitionRetired(
                    originalLocks,
                    held.acquisition,
                    holder
                  );
                } catch (cause) {
                  nativeClosed = false;
                  remember(cause);
                }
              }
            }
            if (nativeClosed) {
              heldDrives.delete(source);
              settlement.closed = true;
            }
          };
          try {
            acquired = originalAcquire.call(originalLocks, target.sessionId, holder, token);
            if (acquired) {
              held.acquisition = captureNativeSessionAcquisition(
                originalLocks,
                target.sessionId,
                holder
              );
              if (!held.acquisition)
                throw new Error('Original Relay acquired native holder unavailable');
              prepared = await this.#prepareRelayDocument(source, target, held.acquisition);
              held.prepared = prepared;
              if (held.stopping) throw new Error('Original Relay drive stopped during preparation');
              if (!prepared) throw new Error('Original Relay private capacity unavailable');
              const own = claudeRelayPrepared.get(prepared);
              if (!own || own.runtime !== this)
                throw new Error('Original Relay prepared drive unavailable');
              preparedOwn = own;
              stream = sendClaudeOriginalRelayDocument(this, prepared);
              held.stream = stream;
              const next = stream.next.bind(stream);
              // Keep the exact original iterator identity; this private drive only adds real holder activity.
              stream.next = (...args) => {
                originalHolderTouch.call(holder);
                return next(...args);
              };
              await feedProjector(own.projector!, stream, { origin: 'runtime' });
              held.naturallyCompleted = true;
            }
          } catch (cause) {
            remember(cause);
          } finally {
            await drainOriginalCleanup();
          }
          if (failed) throw first;
          if (!nativeClosed) throw new Error('Original Relay drive closure UNKNOWN');
          if (acquired) {
            const own = preparedOwn;
            if (
              held.stopping ||
              !held.naturallyCompleted ||
              !own?.completed ||
              !own.runOutcome ||
              !own.lastDone ||
              !own.claim ||
              !own.projectedStart ||
              !own.projectedEnd ||
              !own.projectionFeed ||
              !own.projectionStream ||
              !own.projector
            )
              throw new Error('Original Relay terminal evidence unavailable');
            requireOriginalClosedSessionProjectionFeed(
              own.projectionFeed,
              own.projectionStream,
              own.projector,
              own.projectedStart,
              own.projectedEnd
            );
            const turnStartSeq = readOriginalSessionProjectionSequence(
              own.projector,
              own.projectedStart
            );
            const turnEndSeq = readOriginalSessionProjectionSequence(
              own.projector,
              own.projectedEnd
            );
            if (turnEndSeq <= turnStartSeq)
              throw new Error('Original Relay terminal sequence differs');
            const closed: OriginalClaudeRelayClosedTurn = Object.freeze({
              kind: 'original-claude-relay-closed-turn',
            });
            originalRelayClosedTurns.set(closed, {
              runtime: this,
              source,
              claim: own.claim,
              turnStartSeq,
              turnEndSeq,
              outcome: own.runOutcome.outcome,
            });
            closedTurns.set(source, closed);
          }
          return acquired ? 'drained' : 'busy'; // Positive original owner closure only, not model outcome/native acceptance.
        })
        .finally(() => {
          settlement.settled = true;
        });
      drives.set(source, pending);
      return pending;
    });

    claudeRelayPreparers.set(this, (source, holder, key) => {
      if (!this.connectorRuntimeTools) return Promise.resolve(undefined);
      const target = readOriginalFrozenRelayDocumentTarget(
        source,
        this.connectorRuntimeTools.principals,
        'claude-code'
      );
      const acquisition = captureNativeSessionAcquisition(originalLocks, key, holder);
      if (key !== target.sessionId || !acquisition) return Promise.resolve(undefined);
      return this.#prepareRelayDocument(source, target, acquisition);
    });
    claudeRoomPreparers.set(this, (source, holder, key) => {
      const target = readOriginalFrozenRoomTarget(source, 'claude-code');
      const acquisition = captureNativeSessionAcquisition(originalLocks, key, holder);
      if (!target || key !== target.sessionId || !acquisition) return Promise.resolve(undefined);
      return this.#prepareRoomResponder(source, target, acquisition);
    });
    claudeLockMoves.set(this, (oldKey, canonicalKey, holder) => {
      const entry = claudeRuntimeEntries.get(this)?.get(oldKey);
      const canonical = entry && Object.getOwnPropertyDescriptor(entry.session, 'sdkSessionId');
      if (
        !entry ||
        entry.retired ||
        !entry.acquisition ||
        !canonical ||
        !('value' in canonical) ||
        canonical.value !== canonicalKey
      )
        return false;
      const time = Date.now();
      const activity = captureNativeSessionActivity(entry.acquisition, time);
      if (
        !activity ||
        !readNativeSessionAcquisition(entry.acquisition, activity, time, oldKey) ||
        entry.retired ||
        !isCurrentClaudeNativeSession(entry.store, entry.session)
      )
        return false;
      const next = captureNativeSessionAcquisition(originalLocks, canonicalKey, holder);
      if (!next || !isNativeSessionAcquisitionMove(entry.acquisition, next, holder)) return false;
      entry.acquisition = next;
      return true;
    });
    claudeLockedRunners.set(this, (sessionId, content, opts, holder, lockKey) => {
      const acquisition = captureNativeSessionAcquisition(originalLocks, lockKey, holder);
      if (!acquisition)
        throw new Error('Native turn requires its exact original session lock acquisition.');
      const custody = captureOriginalRoomDispatchLifecycle(holder, this);
      const roomOrigin = custody ? Object.freeze({ holder, custody }) : undefined;
      return this.#createMessage(sessionId, content, opts, acquisition, roomOrigin);
    });
    this.attachments = attachments ?? null;
    this.cwd = cwd ?? DEFAULT_CWD;
    this.claudeCliPath = resolveClaudeCliPath();
    this.cache = new RuntimeCache(dorkHome);
    this.backgroundWork = new BackgroundWorkLedger(dorkHome);
    this.cache.setDefaultCwd(this.cwd);
    // Warm-up spawns the SDK too; give it the same resolved binary path so it
    // works in the packaged desktop app (see setClaudeCliPath's doc).
    this.cache.setClaudeCliPath(this.claudeCliPath);
    // The account probe spawns too; it runs the binary a session would.
    setAccountProbeBinaryResolver(() => this.spawnBinaryPath);
    this.transcriptReader = new TranscriptReader();
  }

  /**
   * The Claude Code binary to spawn, refreshed when there wasn't one.
   *
   * Resolution at construction is the fast path and, once it has succeeded, the
   * answer is kept: a resolved binary does not move underneath a running server.
   * The case that DOES change underneath it is the empty one — a host with no
   * `claude` anywhere is exactly the host where somebody presses "Install
   * Claude", and the provisioner writes a binary the ladder can now see. Without
   * this re-check the requirements payload flipped to Ready while every session
   * started afterwards still spawned with no `pathToClaudeCodeExecutable`, so
   * the SDK self-resolved and threw until the server was restarted (DOR-1334
   * review).
   *
   * The re-check walks only the rungs that touch the filesystem
   * ({@link resolveClaudeBinaryBeforePath}: env override → bundled →
   * provisioned) — a few `existsSync` calls, never the synchronous `which`,
   * which must not run on a spawn path. A newly-installed `claude` on `PATH`
   * therefore still needs the next restart; a provisioned one does not, and
   * provisioning is the path DorkOS itself offers.
   */
  private get spawnBinaryPath(): string | undefined {
    if (this.claudeCliPath) return this.claudeCliPath;
    const refreshed = resolveClaudeBinaryBeforePath() ?? undefined;
    if (refreshed) {
      this.claudeCliPath = refreshed;
      // The warm-up query spawns too, and reads its own copy.
      this.cache.setClaudeCliPath(refreshed);
      logger.info('[ClaudeCode] resolved a Claude Code binary that was missing at startup', {
        binary: refreshed,
      });
    }
    return refreshed;
  }

  /** Warm up the model cache by fetching models from the SDK. */
  async warmup(): Promise<void> {
    return this.cache.warmup(this.cwd);
  }

  // ---------------------------------------------------------------------------
  // Capabilities
  // ---------------------------------------------------------------------------

  /**
   * Return static Claude Code capability flags.
   *
   * `mediaOutput` is resolved per INSTANCE rather than baked into
   * {@link CLAUDE_CODE_CAPABILITIES}, because it is the one capability here that
   * depends on how the runtime was wired: with no attachment store there is
   * nowhere to put an image, and claiming otherwise would be exactly the silent
   * promise this field exists to end. Same arrangement as the OpenCode adapter.
   */
  getCapabilities(): RuntimeCapabilities {
    if (!this.attachments) return CLAUDE_CODE_CAPABILITIES;
    return { ...CLAUDE_CODE_CAPABILITIES, mediaOutput: 'attachments' };
  }

  /** Check whether the Claude Code CLI binary is available and Claude is authenticated. */
  async checkDependencies(): Promise<import('@dorkos/shared/agent-runtime').DependencyCheck[]> {
    const { checkClaudeDependencies } = await import('./tooling/check-dependency.js');
    return checkClaudeDependencies();
  }

  // ---------------------------------------------------------------------------
  // Dependency injection
  // ---------------------------------------------------------------------------

  /** Set the agent registry for agent manifest resolution and peer agent context. */
  setMeshCore(meshCore: AgentRegistryPort): void {
    this.meshCore = meshCore;
  }

  /** Install the internal connector tool boundary after its listener starts. */
  setConnectorRuntimeTools(tools: ConnectorRuntimeTools): void {
    this.connectorRuntimeTools = tools;
  }

  /**
   * Inject the port that reacts to a managed MCP server refusing its credentials
   * mid-session (DOR-981).
   *
   * The SDK reports each MCP server's connection status once per turn, and
   * `needs-auth` there is the one place DorkOS ever learns that the bearer it
   * injected was rejected — the subprocess is what dials the server, so it is the
   * only thing that sees the 401. Everything the answer implies (evict, refresh,
   * draw a sign-in card) is somebody else's business, hence a port: this runtime
   * reports and forgets.
   */
  setMcpAuthEvidence(port: McpAuthEvidencePort | undefined): void {
    this.mcpAuthEvidence = port;
  }

  /**
   * Bound a plugin reload the warm-process pin held on the way into a turn
   * (spec `plugin-reload-cache-cost`).
   *
   * That path holds without an install behind it — a scope change, an agent
   * change, an uninstall all move the `plugins` pin — and its own recovery is
   * only "the next dispatch asks again", which on a session that dispatches all
   * afternoon never ends. Reporting the hold here puts it under the same
   * ceiling as every other one, so it is applied and paid for eventually
   * instead of re-asked for ever.
   *
   * Idempotent, and it never restarts a wait already running: the scheduler
   * folds a repeat hold into the first record.
   *
   * @param sessionId - The session whose pin stayed put
   * @param impact - What the CLI said applying would change
   * @param contextTokens - Size of the conversation at that moment
   */
  private notePluginReloadHeld(
    sessionId: string,
    impact: PluginReloadCacheImpact,
    contextTokens: number | undefined
  ): void {
    this.pluginReloads.hold({ sessionId, impact, contextTokens });
  }

  /**
   * Inject the port that writes a paid plugin reload to the activity feed.
   *
   * A port rather than a direct dependency for the same reason as the one above:
   * this runtime knows what a reload disturbed and what it waited for, and
   * nothing about where such a fact is kept. Without the port the reloads still
   * happen and still reach the debug log; only the feed entry is missing, which
   * is the right degradation for a record nothing depends on.
   */
  setPluginReloadActivity(port: PluginReloadActivityPort | undefined): void {
    this.pluginReloadActivity = port;
  }

  /**
   * Inject the core session-settings store (ADR-0260). Forwards it to the
   * session store along with this runtime's declared default permission mode,
   * so evicted/restarted sessions hydrate the operator's chosen settings.
   */
  setSessionSettings(port: SessionSettingsPort): void {
    this.sessionStore.configureSettings(
      port,
      // A descriptor's `id` is a plain string — a runtime names its own modes —
      // so the declared default is CHECKED into this adapter's narrower union
      // rather than asserted into it (DOR-885). `'default'` is the same answer
      // either way; the fallback exists because `permissionModes.default` is
      // optional on the capability shape.
      narrowToClaudeCodeMode(CLAUDE_CODE_CAPABILITIES.permissionModes.default, 'default')
    );
  }

  /** Inject relay binding context for outbound awareness. */
  setRelayBindingContext(
    bindingRouter: import('../../relay/binding-router.js').BindingRouter,
    bindingStore: import('../../relay/binding-store.js').BindingStore,
    adapterManager: import('../../relay/adapter-manager.js').AdapterManager
  ): void {
    this.bindingRouter = bindingRouter;
    this.bindingStore = bindingStore;
    this.adapterManager = adapterManager;
  }

  /** Inject a Relay core instance for Relay-aware context building. */
  setRelay(_relay: RelayPort): void {
    // No-op: broadcaster no longer needs relay.
    // Method retained to satisfy AgentRuntime interface.
  }

  /** Register a factory that creates fresh MCP tool server configs per query() call. */
  setMcpServerFactory(factory: McpServerFactory): void {
    this.mcpServerFactory = factory;
  }

  // ---------------------------------------------------------------------------
  // Internal service accessors
  // ---------------------------------------------------------------------------

  /** Expose the internal TranscriptReader for routes that need direct access. */
  getTranscriptReader(): TranscriptReader {
    return this.transcriptReader;
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle (delegated to SessionStore)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  ensureSession(sessionId: string, opts: SessionOpts): void {
    this.sessionStore.ensureSession(sessionId, opts);
  }

  /** @inheritdoc */
  async forkSession(
    projectDir: string,
    sessionId: string,
    opts?: { upToMessageId?: string; title?: string }
  ): Promise<Session | null> {
    return this.sessionStore.forkSession(projectDir, sessionId, this.transcriptReader, opts);
  }

  /** @inheritdoc */
  hasSession(sessionId: string): boolean {
    return this.sessionStore.hasSession(sessionId);
  }

  /**
   * @inheritdoc
   *
   * The same three places {@link interruptQuery} looks for something to stop:
   * a dispatched turn's query, a persistent session's first turn still booting,
   * and a turn the agent started itself. A Relay delivery calls `sendMessage`
   * directly and arms the first, so it is seen here though the server never
   * dispatched it.
   */
  isTurnOpen(sessionId: string): boolean {
    return (
      this.sessionStore.findSession(sessionId)?.activeQuery !== undefined ||
      this.#persistent.bootingQuery(sessionId) !== undefined ||
      this.#persistent.runtimeTurnQuery(sessionId) !== undefined
    );
  }

  /** @inheritdoc */
  async updateSession(sessionId: string, opts: SessionSettings): Promise<SessionUpdateResult> {
    return this.sessionStore.updateSession(sessionId, opts);
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /**
   * The registered agent a session's connector tools act for, when this
   * runtime has the connector boundary at all (DOR-2685).
   *
   * One answer for the per-turn connector context in {@link sendMessage} and
   * for whether the in-session server lists the connector tools, so the two
   * cannot disagree, and a stage that warms a process builds the same list as
   * the turn after it.
   *
   * @param cwdKey - The folder the turn or stage runs in
   * @param turnAgent - The agent a turn is dispatched as, when it names one
   * @returns The agent's home and its registry entry, or `undefined`
   */
  #connectorAgentFor(
    cwdKey: string,
    turnAgent?: string
  ):
    | { agentPath: string; meshAgent: NonNullable<ReturnType<AgentRegistryPort['getByPath']>> }
    | undefined {
    if (!this.connectorRuntimeTools) return undefined;
    const agentPath = homeOf(resolveAgentHome(cwdKey, turnAgent));
    const meshAgent = agentPath ? this.meshCore?.getByPath(agentPath) : undefined;
    return agentPath && meshAgent ? { agentPath, meshAgent } : undefined;
  }

  /**
   * Assemble the runtime ports one turn (or one staged warm-up) launches with.
   *
   * Extracted from {@link sendMessage} so {@link deliverIntoTurn}'s `stage` path
   * can boot a cold session with the SAME options a turn would — a stage that
   * warms a process must not build it differently from the message that follows
   * it, or the two would disagree about model, plugins and connectors.
   *
   * @param sessionId - The id this call was asked with (a hint the store resolves)
   * @param session - The resolved session record
   * @param cwdKey - The working directory the caches and command list key on
   * @param turnAgent - The agent a turn is dispatched as, when it names one
   */
  #buildSenderOpts(
    sessionId: string,
    session: AgentSession,
    cwdKey: string,
    turnAgent?: string
  ): MessageSenderOpts {
    // Resolve the selected model's capabilities once: thinking config + whether it
    // supports auto permission mode (undefined when the model isn't cached yet).
    const modelCapability = this.cache.resolveModelCapability(session.model);
    const cacheCallbacks = this.cache.buildSendCallbacks(cwdKey);

    return {
      cwd: this.cwd,
      sessionCwd: session.cwd,
      claudeCliPath: this.spawnBinaryPath,
      ...(this.attachments ? { attachments: this.attachments } : {}),
      meshCore: this.meshCore,
      bindingRouter: this.bindingRouter,
      bindingStore: this.bindingStore,
      adapterManager: this.adapterManager,
      mcpServerFactory: this.mcpServerFactory,
      connectorTools: this.#connectorAgentFor(cwdKey, turnAgent) !== undefined,
      ...cacheCallbacks,
      // Composed over the cache's own handler rather than replacing it: the
      // per-turn status snapshot is one observation with two readers — the
      // cache, which answers "what is connected?", and the revocation watch,
      // which acts on the single status that means "the token you sent me was
      // refused" (DOR-981). The session id is read when the snapshot ARRIVES,
      // not now, so a session that was assigned its canonical id mid-turn
      // reports the id its projector is keyed by.
      onMcpStatusReceived: (servers) => {
        cacheCallbacks.onMcpStatusReceived?.(servers);
        this.reportMcpAuthFailures(session.sdkSessionId || sessionId, cwdKey, servers);
      },
      // `sessionId` is the id THIS turn was asked with, which is only a hint:
      // after the session's first rename it is an alias, not the key the
      // store holds it under. The store resolves the real key itself.
      onSdkSessionRebind: (previousSdkSessionId, nextSdkSessionId) =>
        this.sessionStore.rebindSdkSession(previousSdkSessionId, nextSdkSessionId, sessionId),
      modelThinkingCapability: modelCapability,
      modelSupportsAutoMode: modelCapability
        ? (modelCapability.supportsAutoMode ?? false)
        : undefined,
      lookupModel: (value) => this.cache.resolveModelCapability(value),
      rememberSessionModel: (model) => this.sessionStore.rememberModel(session, sessionId, model),
      plugins: this.activatedPlugins,
      getKnownCommands: async () => {
        // Cold SDK cache → null: built-ins are unknowable before the first
        // query for this cwd, so the sender passes command-shaped content
        // through unverified (DOR-107).
        if (!this.cache.hasSdkCommands(cwdKey)) return null;
        const { commands } = await this.cache.getCommands(this.getOrCreateRegistry(cwdKey), cwdKey);
        return commands.map((c) => c.fullCommand);
      },
    };
  }

  /** @inheritdoc */
  sendMessage(sessionId: string, content: string, opts?: MessageOpts): AsyncGenerator<StreamEvent> {
    return this.#createMessage(sessionId, content, opts);
  }

  #createMessage(
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    acquisition?: NativeSessionAcquisition,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
    roomPrepared?: ClaudePreparedRoomContinuation
  ): AsyncGenerator<StreamEvent> {
    const lifetime: {
      closed: boolean;
      entered: boolean;
      retire?: () => void;
      acquisition?: NativeSessionAcquisition;
      roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
      roomPrepared?: ClaudePreparedRoomContinuation;
    } = {
      closed: false,
      entered: false,
      acquisition,
      roomOrigin,
      roomPrepared,
      retire: roomPrepared
        ? () => {
            roomPrepared.nativeEntry.retired = true;
          }
        : undefined,
    };
    const stream = this.#sendOwnedMessage(sessionId, content, opts, lifetime);
    const close = () => {
      lifetime.closed = true;
      lifetime.retire?.();
      // Cancel the actual prepared native owner before generator return queues
      // behind a pending transport read. Its memo is joined below and in finally.
      if (roomPrepared) void roomPrepared.retire().catch(() => {});
    };
    const joinOriginalClose = async (result: ReturnType<typeof stream.return>) => {
      let failed = false;
      let first: unknown;
      let outcome: Awaited<ReturnType<typeof stream.return>> | undefined;
      try {
        outcome = await result;
      } catch (cause) {
        failed = true;
        first = cause;
      }
      const own = lifetime.roomPrepared!;
      try {
        retireOriginalCommittedRoomResponder(
          own.committed!,
          this,
          own.prepared,
          own.nativeOperation
        );
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      try {
        await own.retire();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      if (failed) throw first;
      return outcome!;
    };
    const capturedReturn = stream.return.bind(stream);
    const returnOriginal: AsyncGenerator<StreamEvent>['return'] = (value) => {
      close();
      const result = capturedReturn(value);
      return roomPrepared ? joinOriginalClose(result) : result;
    };
    const returned: AsyncGenerator<StreamEvent> = {
      next: (value) => {
        if (!roomPrepared) return stream.next(value);
        return stream.next(value).then((result) => {
          const own = originalClaudeRoomStreams.get(returned)!;
          if (!result.done && result.value) {
            own.emitted.add(result.value);
            const data = result.value.data;
            if (
              data &&
              typeof data === 'object' &&
              'terminalReason' in data &&
              typeof data.terminalReason === 'string'
            )
              own.reason = data.terminalReason;
            if (
              result.value.type === 'error' &&
              !isNonFatalErrorCode(
                data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
                  ? data.code
                  : undefined
              )
            )
              own.failed = true;
            if (result.value.type === 'done') own.done = true;
          }
          return result;
        });
      },
      return: returnOriginal,
      [Symbol.asyncDispose]: async () => {
        await returnOriginal(undefined);
      },
      throw: (error) => {
        close();
        const result = stream.throw(error);
        return roomPrepared ? joinOriginalClose(result) : result;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    if (acquisition)
      originalClaudeLockedStreams.set(returned, {
        runtime: this,
        sessionId,
        current: () => {
          if (lifetime.closed) return false;
          const at = Date.now(),
            activity = captureNativeSessionActivity(acquisition, at);
          return !!activity && !!readNativeSessionAcquisition(acquisition, activity, at, sessionId);
        },
      });
    const originalReturn = returned.return.bind(returned);
    if (roomPrepared && roomPrepared.committed)
      originalClaudeRoomStreams.set(returned, {
        runtime: this,
        prepared: roomPrepared.prepared,
        operation: roomPrepared.nativeOperation,
        committed: roomPrepared.committed,
        emitted: new WeakSet(),
        close: () => originalReturn(undefined),
        failed: false,
        done: false,
      });
    return returned;
  }

  #installNativeTurn(
    sessionId: string,
    session: AgentSession,
    cwdKey: string,
    agentPath: string | undefined,
    meshAgent: { id: string } | undefined,
    acquisition?: NativeSessionAcquisition,
    refuseExisting = false,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
    relayOwner?: { retired: boolean; cleanupFailed?: boolean; cleanupCause?: unknown }
  ) {
    const relayOwned = this.#relayPreparing.get(sessionId);
    if (relayOwned && (relayOwned !== relayOwner || relayOwned.retired))
      throw new Error('Original Relay session owner remains unresolved');
    if (
      roomOrigin &&
      readOriginalRoomDispatchLifecycle(roomOrigin.holder, this) !== roomOrigin.custody
    )
      throw new Error('Original Room dispatch lifetime is retired.');
    const store = claudeOriginalStores.get(this),
      slot = Object.getOwnPropertyDescriptor(this, 'sessionStore');
    if (
      !store ||
      !slot ||
      !('value' in slot) ||
      slot.value !== store ||
      !isCurrentClaudeNativeSession(store, session)
    )
      throw new Error('Native preparation requires its original session store.');
    const dedicated = claudeRoomQuerySessions.get(session);
    if (dedicated && !dedicated.finished)
      throw new Error('A prepared Room session cannot be replaced while its continuation is live.');
    if (dedicated) claudeRoomQuerySessions.delete(session);
    const existing = claudeRuntimeEntries.get(this)?.get(sessionId);
    if (refuseExisting && existing && !existing.retired)
      throw new Error('Native preparation cannot replace a live entry.');
    const nativeOperation = Object.freeze({});
    if (!claudeNativeConstructors.has(this))
      throw new Error('Native runtime operation requires its genuine constructor.');
    const nativeEntry = {
      roomOrigin,
      acquisition,
      instance: this,
      session,
      store,
      retired: false,
      runtime: 'claude-code' as const,
      key: sessionId,
      agentPath,
      cwd: cwdKey,
      context: undefined as ClaudeConnectorTurnContext | undefined,
    };
    claudeNativeOperations.set(nativeOperation, nativeEntry);
    let runtimeEntries = claudeRuntimeEntries.get(this);
    if (!runtimeEntries) {
      runtimeEntries = new Map();
      claudeRuntimeEntries.set(this, runtimeEntries);
    }
    runtimeEntries.set(sessionId, nativeEntry);
    const connectorTurn =
      this.connectorRuntimeTools && meshAgent && agentPath
        ? new ClaudeConnectorTurnContext({
            tools: this.connectorRuntimeTools,
            canonicalSessionId: () => session.sdkSessionId || sessionId,
            agentPath,
            cwd: cwdKey,
            nativeOperation,
            retireNative: () => {
              nativeEntry.retired = true;
            },
          })
        : undefined;
    nativeEntry.context = connectorTurn;
    return { nativeOperation, nativeEntry, runtimeEntries, connectorTurn };
  }

  readonly #relayPreparing = new Map<
    string,
    { retired: boolean; cleanupFailed?: boolean; cleanupCause?: unknown }
  >();
  async #prepareRelayDocument(
    source: OriginalFrozenRelayDocumentSource,
    target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
    acquisition: NativeSessionAcquisition
  ): Promise<PreparedRelayDocumentResponder | undefined> {
    const { sessionId, agentPath } = target,
      tools = this.connectorRuntimeTools;
    if (
      !tools ||
      this.#relayPreparing.has(sessionId) ||
      this.#roomPreparing.has(sessionId) ||
      (claudeRuntimeEntries.get(this)?.get(sessionId) &&
        !claudeRuntimeEntries.get(this)!.get(sessionId)!.retired)
    )
      return undefined;
    const capacity = readOriginalPersistentRoomState(this.#persistent, sessionId);
    if (capacity === 'running' || capacity === 'warming' || capacity === 'resuming')
      return undefined;
    const current = readOriginalFrozenRelayDocumentTarget(source, tools.principals, 'claude-code');
    const meshAgent = this.meshCore?.getByPath(agentPath);
    if (
      current.sessionId !== sessionId ||
      current.agentPath !== agentPath ||
      current.agentId !== target.agentId ||
      homeOf(resolveAgentHome(agentPath, agentPath)) !== agentPath ||
      meshAgent?.id !== target.agentId
    )
      throw new Error('Original Relay target changed.');
    const pending: { retired: boolean; cleanupFailed?: boolean; cleanupCause?: unknown } = {
      retired: false,
    };
    this.#relayPreparing.set(sessionId, pending);
    let process: OriginalDocumentProcessReservation | undefined;
    let launch: OriginalPreparedRelaySdkLaunch | undefined;
    let setup:
      | {
          nativeOperation: object;
          nativeEntry: ClaudeNativeEntry;
          runtimeEntries: Map<string, ClaudeNativeEntry>;
          connectorTurn: ClaudeConnectorTurnContext | undefined;
        }
      | undefined;
    try {
      const reserved = reserveOriginalFrozenRelayDocumentProcess(source, tools.principals, this);
      if (!reserved) {
        if (this.#relayPreparing.get(sessionId) === pending) this.#relayPreparing.delete(sessionId);
        return undefined;
      }
      process = reserved;
      const store = claudeOriginalStores.get(this)!;
      const session = await store.ensureForMessage(sessionId, this.transcriptReader, this.cwd, {
        cwd: agentPath,
      });
      if (pending.retired) throw new Error('Original Relay preparation retired.');
      setup = this.#installNativeTurn(
        sessionId,
        session,
        agentPath,
        agentPath,
        meshAgent,
        acquisition,
        true,
        undefined,
        pending
      );
      if (!setup.connectorTurn) throw new Error('Original Relay connector unavailable.');
      session.connectorTurn = setup.connectorTurn;
      await resolveOriginalClaudeConnectorPrincipal(setup.connectorTurn);
      const input = readOriginalFrozenRelayDocumentLaunchInput(source, tools.principals);
      session.unattendedApprovals = true;
      session.unattendedTurn = true;
      const senderOpts = this.#buildSenderOpts(sessionId, session, agentPath, agentPath);
      const messageOpts = {
        cwd: agentPath,
        unattended: true,
        unattendedApprovals: true,
        additionalContext: input.additionalContext,
      };
      launch = await prepareOriginalRelaySdkLaunch(
        sessionId,
        input.content,
        session,
        senderOpts,
        messageOpts,
        process
      );
      // Launch resolution awaits real credential/identity/configuration readers.
      // Revalidate the original source and acquisition after ALL of them.
      readOriginalFrozenRelayDocumentTarget(source, tools.principals, 'claude-code');
      requireOriginalPreparedRelaySdkLaunch(launch, session);
      const native = readClaudeNativeOperation(setup.nativeOperation),
        at = Date.now();
      const activity = captureNativeSessionActivity(acquisition, at);
      if (
        pending.retired ||
        !native ||
        native.canonicalSessionId !== sessionId ||
        native.agentPath !== agentPath ||
        native.canonicalCwd !== agentPath ||
        !activity ||
        !readNativeSessionAcquisition(acquisition, activity, at, sessionId)
      )
        throw new Error('Original Relay native entry retired.');
      const fixed = setup,
        fixedLaunch = launch,
        fixedProcess = process;
      let retirement: Promise<void> | undefined;
      const retire = () => {
        if (retirement) return retirement;
        // Latch original session exclusion before any owner retirement. Failed
        // cancellation/capacity settlement cannot admit a replacement turn.
        pending.retired = true;
        this.#relayPreparing.set(sessionId, pending);
        fixed.nativeEntry.retired = true;
        if (fixed.runtimeEntries.get(sessionId) === fixed.nativeEntry)
          fixed.runtimeEntries.delete(sessionId);
        if (session.connectorTurn === fixed.connectorTurn) session.connectorTurn = undefined;
        retirement = Promise.resolve().then(async () => {
          let failed = false;
          let first: unknown;
          const remember = (cause: unknown) => {
            if (!failed) {
              failed = true;
              first = cause;
            }
            pending.cleanupFailed = true;
            pending.cleanupCause = cause;
          };
          const launchDrain = Promise.resolve()
            .then(() => drainOriginalRelaySdkQuery(fixedLaunch, session))
            .catch(remember);
          const principalDrain = Promise.resolve()
            .then(() => fixed.connectorTurn!.cancel())
            .catch(remember);
          await Promise.allSettled([launchDrain, principalDrain]);
          try {
            fixedProcess.requireReleased();
          } catch (cause) {
            remember(cause);
          }
          if (failed) throw first;
          if (this.#relayPreparing.get(sessionId) === pending)
            this.#relayPreparing.delete(sessionId);
        });
        return retirement;
      };
      const prepared: PreparedRelayDocumentResponder = Object.freeze({
        kind: 'prepared-relay-document-responder',
      });
      claudeRelayPrepared.set(prepared, {
        runtime: this,
        source,
        operation: fixed.nativeOperation,
        acquisition,
        retire,
        launch: fixedLaunch,
        session,
        process: fixedProcess,
        principals: tools.principals,
        send: () =>
          executeSdkQuery(
            sessionId,
            input.content,
            session,
            senderOpts,
            messageOpts,
            0,
            fixedLaunch
          ),
        commit: () =>
          claimOriginalPreparedRelayDocumentFacts(
            source,
            this,
            prepared,
            fixed.nativeOperation,
            tools.principals
          ),
      });
      originalRelayLaunchPreparations.set(fixedLaunch, prepared);
      // Keep the exact original owner throughout prepared/query/process lifetime.
      return prepared;
    } catch (cause) {
      pending.retired = true;
      let originalSetupClosed = !setup;
      if (launch && setup) {
        try {
          retireOriginalPreparedRelaySdkLaunch(launch, setup.nativeEntry.session);
        } catch (cleanupCause) {
          pending.cleanupFailed = true;
          pending.cleanupCause = cleanupCause;
          originalSetupClosed = false;
        }
      }
      if (setup) {
        setup.nativeEntry.retired = true;
        if (setup.runtimeEntries.get(sessionId) === setup.nativeEntry)
          setup.runtimeEntries.delete(sessionId);
        if (setup.nativeEntry.session.connectorTurn === setup.connectorTurn)
          setup.nativeEntry.session.connectorTurn = undefined;
        try {
          if (!setup.connectorTurn)
            throw new Error('Original Relay setup cleanup owner unavailable', { cause });
          await setup.connectorTurn.revoke('setup_failed');
          originalSetupClosed = !pending.cleanupFailed;
        } catch (cleanupCause) {
          pending.cleanupFailed = true;
          pending.cleanupCause = cleanupCause;
        }
      }
      if (process) {
        try {
          process.releaseNeverInvoked();
        } catch (cleanupCause) {
          pending.cleanupFailed = true;
          pending.cleanupCause = cleanupCause;
          originalSetupClosed = false;
        }
      }
      // Positive original revoke and exact never-invoked capacity settlement release this slot. UNKNOWN
      // stays captured and excludes future work; the setup raw cause remains first.
      if (originalSetupClosed && this.#relayPreparing.get(sessionId) === pending)
        this.#relayPreparing.delete(sessionId);
      throw cause;
    }
  }

  async #prepareRoomResponder(
    source: OriginalFrozenRoomSource,
    target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
    acquisition: NativeSessionAcquisition
  ): Promise<PreparedRoomResponder | undefined> {
    const { sessionId, agentPath } = target,
      tools = this.connectorRuntimeTools;
    if (
      !tools ||
      this.#roomPreparing.has(sessionId) ||
      this.#relayPreparing.has(sessionId) ||
      (claudeRuntimeEntries.get(this)?.get(sessionId) &&
        !claudeRuntimeEntries.get(this)!.get(sessionId)!.retired)
    )
      return undefined;
    const capacity = readOriginalPersistentRoomState(this.#persistent, sessionId);
    if (capacity === 'running' || capacity === 'warming' || capacity === 'resuming')
      return undefined;
    requireOriginalRoomPrincipalService(source, tools.principals);
    const meshAgent = this.meshCore?.getByPath(agentPath);
    if (
      homeOf(resolveAgentHome(agentPath, agentPath)) !== agentPath ||
      meshAgent?.id !== target.agentId
    )
      throw new Error('Room responder differs from its approved target.');
    const pending = { retired: false };
    this.#roomPreparing.set(sessionId, pending);
    let installed:
      | {
          nativeEntry: ClaudeNativeEntry;
          runtimeEntries: Map<string, ClaudeNativeEntry>;
          connectorTurn: ClaudeConnectorTurnContext | undefined;
        }
      | undefined;
    try {
      const store = claudeOriginalStores.get(this)!;
      const session = await store.ensureForMessage(sessionId, this.transcriptReader, this.cwd, {
        cwd: agentPath,
      });
      if (pending.retired) throw new Error('Room responder preparation retired.');

      const setup = this.#installNativeTurn(
        sessionId,
        session,
        agentPath,
        agentPath,
        meshAgent,
        acquisition,
        true
      );
      installed = setup;
      if (!setup.connectorTurn) throw new Error('Original Claude connector setup is unavailable.');
      session.connectorTurn = setup.connectorTurn;
      let retirement: Promise<void> | undefined;
      const retire = (): Promise<void> => {
        if (retirement) return retirement;
        let resolve!: () => void, reject!: (cause: unknown) => void;
        retirement = new Promise<void>((done, refused) => {
          resolve = done;
          reject = refused;
        });
        // Reserve the original retirement before abort callbacks can reenter.
        void (async () => {
          const dedicated = claudeRoomQuerySessions.get(session);
          let failed = false,
            firstCause: unknown;
          const remember = (cause: unknown) => {
            if (!failed) {
              failed = true;
              firstCause = cause;
            }
          };
          let readDrain: Promise<void> | undefined;
          try {
            readDrain = dedicated?.stopRead?.().catch(remember);
          } catch (cause) {
            remember(cause);
          }
          setup.nativeEntry.retired = true;
          if (setup.runtimeEntries.get(sessionId) === setup.nativeEntry)
            setup.runtimeEntries.delete(sessionId);
          if (session.connectorTurn === setup.connectorTurn) session.connectorTurn = undefined;
          if (dedicated && !dedicated.entered) dedicated.finished = true;
          try {
            await setup.connectorTurn!.cancel();
          } catch (cause) {
            remember(cause);
          }
          try {
            await readDrain;
          } catch (cause) {
            remember(cause);
          }
          if (failed) throw firstCause;
        })().then(resolve, reject);
        return retirement;
      };
      await resolveOriginalClaudeConnectorPrincipal(setup.connectorTurn);
      const native = readClaudeNativeOperation(setup.nativeOperation);
      if (
        pending.retired ||
        !native ||
        native.canonicalSessionId !== sessionId ||
        native.agentPath !== agentPath ||
        native.canonicalCwd !== agentPath
      )
        throw new Error('Room responder preparation retired.');
      const time = Date.now(),
        activity = captureNativeSessionActivity(acquisition, time);
      if (!activity || !readNativeSessionAcquisition(acquisition, activity, time, sessionId))
        throw new Error('Room responder lock retired during preparation.');
      const prepared: PreparedRoomResponder = Object.freeze({ kind: 'prepared-room-responder' });
      const continuation: ClaudePreparedRoomContinuation = {
        prepared,
        runtime: this,
        session,
        sessionId,
        nativeOperation: setup.nativeOperation,
        nativeEntry: setup.nativeEntry,
        runtimeEntries: setup.runtimeEntries,
        connectorTurn: setup.connectorTurn,
        acquisition,
        started: false,
        entered: false,
        finished: false,
        consumed: false,
        retire,
      };
      claudeRoomQuerySessions.set(session, continuation);
      claudeRoomPrepared.set(prepared, {
        runtime: this,
        retire,
        source,
        nativeOperation: setup.nativeOperation,
        acquisition,
        start: (committed) => {
          if (continuation.started || !readClaudePreparedRoomResponder(this, prepared))
            throw new Error('Room prepared entry cannot start twice or after retirement.');
          continuation.started = true;
          continuation.committed = committed;
          return this.#createMessage(
            sessionId,
            'Document update',
            { cwd: agentPath },
            acquisition,
            undefined,
            continuation
          );
        },
      });
      if (this.#roomPreparing.get(sessionId) === pending) this.#roomPreparing.delete(sessionId);
      return prepared;
    } catch (cause) {
      pending.retired = true;
      if (this.#roomPreparing.get(sessionId) === pending) this.#roomPreparing.delete(sessionId);
      if (installed) {
        installed.nativeEntry.retired = true;
        if (installed.runtimeEntries.get(sessionId) === installed.nativeEntry)
          installed.runtimeEntries.delete(sessionId);
        if (installed.nativeEntry.session.connectorTurn === installed.connectorTurn)
          installed.nativeEntry.session.connectorTurn = undefined;
        try {
          await installed.connectorTurn?.revoke('setup_failed');
        } catch {
          /* Preserve original setup cause. */
        }
      }
      throw cause;
    }
  }

  async *#sendOwnedMessage(
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    lifetime: {
      closed: boolean;
      entered: boolean;
      retire?: () => void;
      acquisition?: NativeSessionAcquisition;
      roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
      roomPrepared?: ClaudePreparedRoomContinuation;
    }
  ): AsyncGenerator<StreamEvent> {
    let failed = false,
      first: unknown;
    const cleanup = async (work: () => unknown | Promise<unknown>) => {
      try {
        await work();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    };
    // Join this scope to its captured cleanup before returning or reporting failure.
    const drainOriginalCleanup = async () => {
      const own = lifetime.roomPrepared;
      if (own) {
        own.finished = true;
        const committed = own.committed;
        if ((failed || lifetime.closed) && committed)
          await cleanup(() =>
            retireOriginalCommittedRoomResponder(committed, this, own.prepared, own.nativeOperation)
          );
        await cleanup(() => own.retire());
      }
      if (failed) throw first;
    };
    try {
      if (this.#relayPreparing.has(sessionId))
        throw new Error('Original Relay session owner remains unresolved');
      lifetime.entered = true;
      if (lifetime.roomPrepared) lifetime.roomPrepared.entered = true;
      const session =
        lifetime.roomPrepared?.session ??
        (await this.sessionStore.ensureForMessage(
          sessionId,
          this.transcriptReader,
          this.cwd,
          opts
        ));

      // Neither the window snapshot nor the room marker is lifted onto the session
      // any more: the `ui` verbs are capabilities, and both facts are bound
      // runtime-neutrally by the trigger (spec `canvas-agent-seat` §5). That is the
      // whole of what made Codex and OpenCode unable to answer "what is on the
      // canvas" — the answer lived on this object, which only this runtime has.

      const cwdKey = opts?.cwd || session.cwd || this.cwd;

      // The agent this turn acts as: the home the folder resolves to, and never
      // another than the turn is dispatched as (DOR-2091, DOR-2355,
      // `core/agent-identity/agent-home.ts`). The same answer the launch resolves
      // its token from, so the connections below and the token cannot name two
      // different agents.
      const agentPath = homeOf(resolveAgentHome(cwdKey, turnAgentOf(opts)));
      const meshAgent = agentPath ? this.meshCore?.getByPath(agentPath) : undefined;

      if (lifetime.closed) {
        if (lifetime.roomPrepared) {
          lifetime.roomPrepared.finished = true;
          lifetime.roomPrepared.stopRead = undefined;
        }
        return;
      }
      const { nativeEntry, runtimeEntries, connectorTurn } =
        lifetime.roomPrepared ??
        this.#installNativeTurn(
          sessionId,
          session,
          cwdKey,
          agentPath,
          meshAgent,
          lifetime.acquisition,
          false,
          lifetime.roomOrigin
        );
      lifetime.retire = () => {
        nativeEntry.retired = true;
      };
      let connectorRevokeReason: RevokeConnectorTurnReason = 'setup_failed';
      let observedEvent = false;
      let sawRuntimeError = false;
      try {
        session.connectorTurn = connectorTurn;
        // Unconditionally, `false` included: a warm session a person later talks
        // to must hold for their answer again (spec `agent-permissions` D6).
        session.unattendedApprovals = opts?.unattendedApprovals === true;
        // Per turn too, for the same reason: an automatic carry-over's first turn
        // has nobody to ask, and the person who opens it next does.
        session.unattendedTurn = opts?.unattended === true;
        const accessContext =
          connectorTurn &&
          this.connectorRuntimeTools &&
          meshAgent &&
          !content.trimStart().startsWith('/')
            ? await this.accountsAccess.select(
                this.connectorRuntimeTools,
                meshAgent.id,
                session.sdkSessionId || sessionId,
                // The connection tools and the service lookup share the in-session server.
                { serviceCatalog: true }
              )
            : undefined;
        if (accessContext)
          opts = {
            ...opts,
            additionalContext: [...(opts?.additionalContext ?? []), accessContext.entry],
          };
        if (lifetime.closed || !isCurrentClaudeNativeSession(this.sessionStore, session)) return;
        const senderOpts = this.#buildSenderOpts(sessionId, session, cwdKey, turnAgentOf(opts));

        const persistentArgs = {
          sessionId,
          content,
          session,
          opts: senderOpts,
          ...(opts !== undefined ? { messageOpts: opts } : {}),
        };
        if (lifetime.roomPrepared) {
          originalClaudePersistentRequests.set(persistentArgs, {
            persistent: this.#persistent,
            continuation: lifetime.roomPrepared,
          });
        }
        const persistent = this.#persistent.shouldDispatch(sessionId);
        if (lifetime.roomPrepared) {
          lifetime.roomPrepared.stopRead = persistent
            ? () => this.#persistent.stopOriginalRoomRequest(persistentArgs)
            : lifetime.roomPrepared.stopRead;
        }
        if (!persistent) opts?.dispatchHold?.proceed();
        const stream = persistent
          ? this.#persistent.dispatch(persistentArgs)
          : executeSdkQuery(sessionId, content, session, senderOpts, opts);

        for await (const raw of stream) {
          observedEvent = true;
          // A credits session whose token was refused partway through is a
          // credits problem, not the person's Claude sign-in: it surfaces as the
          // credits card, and no "sign in to Claude again" notice is raised
          // (ADR 261001-000811).
          const event = onCreditsSession(session) ? asCreditsStopped(raw) : raw;
          if (event.type === 'error') sawRuntimeError = true;
          yield event;
        }
        if (observedEvent && !sawRuntimeError)
          accessContext?.commit(session.sdkSessionId || sessionId);
        connectorRevokeReason = sawRuntimeError ? 'runtime_failed' : 'turn_terminal';
      } catch (error) {
        connectorRevokeReason = observedEvent ? 'runtime_failed' : 'setup_failed';
        const message = error instanceof Error ? error.message : String(error);
        if (onCreditsSession(session) && detectAuthError({ message })) {
          yield creditsStoppedEvent(message);
          return;
        }
        failed = true;
        first = error;
      } finally {
        if (lifetime.roomPrepared) {
          lifetime.roomPrepared.finished = true;
          lifetime.roomPrepared.stopRead = undefined;
        }
        nativeEntry.retired = true;
        if (runtimeEntries.get(sessionId) === nativeEntry) runtimeEntries.delete(sessionId);
        if (connectorTurn) {
          if (session.connectorTurn === connectorTurn) session.connectorTurn = undefined;
          if (!lifetime.roomPrepared)
            await cleanup(() =>
              connectorTurn.revoke(
                connectorTurn.cancelled ? 'turn_cancelled' : connectorRevokeReason
              )
            );
        }
      }
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    } finally {
      await drainOriginalCleanup();
    }
  }

  /**
   * Fulfill the runtime-fulfilled `compact` intent (ADR-0273) by sending the
   * `/compact` prompt through the SAME SDK send path a normal turn uses,
   * appending any trailing instructions the user typed (e.g.
   * `/compact focus on the API changes`) so they reach the CLI verbatim —
   * exactly what typing the command pre-DOR-109 did. This reuses DOR-107's
   * bare-passthrough: the command-skip guard (`getKnownCommands`, wired in
   * {@link sendMessage}) suppresses the neutral additional-context prepend on
   * the command turn, so `/compact` reaches Claude's CLI as a first-class slash
   * command and the turn's StreamEvents (including the `compact_boundary`) flow
   * back for the durable projector to drive — exactly like a turn. No new
   * Claude-SDK surface; it wraps the shipped `/compact` mechanism.
   * `CLAUDE_CODE_CAPABILITIES.commandIntents` gates the route before this is
   * ever called.
   *
   * DEFENSIVE NOTE: the bare passthrough is correct today because this path
   * never supplies `additionalContext` — with an empty context bag the sender
   * has nothing to prepend, so `/compact` reaches the CLI bare even on a COLD
   * `getKnownCommands` cache (which returns null before the first query for a
   * cwd). If this method ever starts passing `additionalContext`, the
   * warm-cache membership of `/compact` in `getKnownCommands` becomes
   * load-bearing for the prepend-suppression — a cold cache would then let
   * context leak onto the command turn. Revisit the guard before adding
   * context here.
   */
  async *executeCommandIntent(
    sessionId: string,
    _intent: RuntimeCommandIntentId,
    opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent> {
    const instructions = opts?.instructions?.trim();
    const prompt = instructions ? `/compact ${instructions}` : '/compact';
    yield* this.sendMessage(sessionId, prompt, opts);
  }

  /**
   * Refresh the cached marketplace plugins array (marketplace-05,
   * ADR-0239) AND propagate the new command list so the chat command palette
   * catches up after an install/uninstall (UX-12). Should be called once at
   * server startup and whenever the install/uninstall/update pipeline mutates
   * the set of installed packages.
   *
   * Two layers of propagation, because the Claude Agent SDK's
   * `supportedCommands()` is captured ONCE at session init and never reflects
   * mid-session changes — a cold re-fetch returns the stale init-time list:
   *
   * 1. **Next query** — swap `activatedPlugins` so any session that starts (or
   *    resumes into) its next `sendMessage` launches with the new plugin set
   *    and reports the new commands at init.
   * 2. **Live sessions (instant)** — round-trip the SDK's `reload_plugins`
   *    control request on every session that still holds a reloadable query.
   *    The SDK reloads plugins from disk and returns the authoritative refreshed
   *    command list, which we write into the per-cwd cache so `GET /api/commands`
   *    reflects the change with no restart and no extra turn.
   *
   * After (2) it broadcasts a `commands_changed` event on the unified
   * `/api/events` stream so connected clients re-fetch the command registry
   * immediately. Sessions with no live query (never sent a message) cannot be
   * hot-reloaded — their commands appear on the next message instead. The
   * broadcast fires unconditionally so a freshly-loaded palette (cold cache)
   * still re-fetches and the install's effect is visible.
   *
   * A reload can add a plugin but never take one away, so a warm process that
   * loaded a plugin the new set drops is relaunched before its next turn
   * instead (`sessions/launch-fingerprint.ts`, DOR-2306); for the same reason a
   * reload after the set SHRANK is never held for what it costs the prompt
   * cache.
   *
   * Fails closed: a scan that cannot say which global packages a person
   * approved leaves every global plugin out. Reload failures are per session
   * and never block the others.
   */
  async refreshActivatedPlugins(changedProjectPath?: string): Promise<void> {
    const before = this.activatedPlugins.map((plugin) => plugin.path);
    // Built into locals and assigned ONCE, after every await: two refreshes can
    // overlap (boot, plus a change delivered right after it), and one that read
    // or appended to the shared list between another's awaits loaded a root
    // twice, or mistook an extension's own root for a same-named plugin.
    let packages: Array<{ type: 'local'; path: string }>;
    try {
      const { resolveDorkHome } = await import('../../../lib/dork-home.js');
      const { listConsentedPluginNames } =
        await import('../../marketplace/consent/global-plugin-consent.js');
      const { buildClaudeAgentSdkPluginsArray } = await import('./messaging/plugin-activation.js');
      const { logger } = await import('../../../lib/logger.js');
      const dorkHome = resolveDorkHome();
      // Only packages a person approved (or that run nothing on their own):
      // a global package's hooks and servers start in every session (DOR-2306).
      const enabledNames = await listConsentedPluginNames(dorkHome);
      packages =
        enabledNames.length === 0
          ? []
          : await buildClaudeAgentSdkPluginsArray({
              dorkHome,
              enabledPluginNames: enabledNames,
              logger,
            });
    } catch {
      // Fail closed (DOR-2306): a refresh that cannot say which global packages
      // a person approved loads none of them, rather than keeping a list that
      // may hold one nobody approves any more.
      packages = [];
    }
    // Running global extensions' skills (DOR-2685), each from its generated
    // plugin root. Already consented: the extension's approval to run is the
    // consent, and the root holds skills only. Asked separately, so a ledger
    // that cannot be read loads no extension skills and leaves the packages
    // above as they are.
    let skillRoots: Array<{ type: 'local'; path: string }> = [];
    try {
      const { resolveDorkHome } = await import('../../../lib/dork-home.js');
      const { extensionSkillPluginRoots } =
        await import('../../extensions/agent-skills/running-skills-ledger.js');
      const loaded = new Set(packages.map((plugin) => path.basename(plugin.path)));
      const roots = await extensionSkillPluginRoots(resolveDorkHome(), loaded);
      skillRoots = roots.map((root) => ({ type: 'local' as const, path: root }));
    } catch {
      // Best-effort: no extension skills this time; the next refresh asks again.
    }
    this.activatedPlugins = [...packages, ...skillRoots];

    // Hot-reload every live session so its cached command list reflects the
    // new plugin set instantly, then tell clients to re-fetch. Isolated from
    // the plugin-array swap above so a reload failure never reverts it.
    const kept = new Set(this.activatedPlugins.map((plugin) => plugin.path));
    await this.reloadCommandsForLiveSessions({
      mayHold: before.every((pluginPath) => kept.has(pluginPath)),
    });

    // A PROJECT-scoped install/uninstall changes which commands that project's
    // sessions report, but only sessions launched after the change see the new
    // plugin set — so drop the cwd's cached command list (and any warm-probe
    // cooldown) and let the broadcast below trigger a re-warm with the merged
    // per-cwd plugins. Runs AFTER the live-session reload, which would
    // otherwise repopulate the cache from a session still holding the old set.
    if (changedProjectPath) this.forgetProjectCommands(changedProjectPath);

    this.broadcastCommandsChanged();
  }

  /**
   * Tell the command palette a project's commands changed, without touching
   * any session's plugins: drop that cwd's cached command list (and any
   * warm-probe cooldown) so the next fetch re-warms it, then broadcast
   * `commands_changed`.
   *
   * For a change that reaches a project as projected files (a project dev
   * link's edit, DOR-2696). A project package is not an SDK plugin, so live
   * sessions have nothing to reload; only the cached list is stale, and it
   * would otherwise stay stale until a restart.
   *
   * @param projectPath - The project whose commands changed.
   */
  refreshProjectCommands(projectPath: string): void {
    this.forgetProjectCommands(projectPath);
    this.broadcastCommandsChanged();
  }

  /** Drop a cwd's cached command list and its warm-probe cooldown. */
  private forgetProjectCommands(projectPath: string): void {
    this.cache.clearSdkCommands(projectPath);
    this.warmFailedAt.delete(projectPath);
  }

  /**
   * Round-trip `reload_plugins` on every session that still holds a reloadable
   * SDK query, refreshing each session cwd's cached command list in place.
   *
   * Per-session failures are swallowed (logged at debug) so one dead
   * subprocess never blocks the others. Sessions that never ran a query expose
   * no query and are skipped — their commands populate on the next message.
   *
   * **This is the install fan-out, and it asks before it spends** (spec
   * `plugin-reload-cache-cost`). Nobody asked for this reload — somebody
   * installed a plugin, and one click reaches every open session at once — so
   * each session's reload goes through the cost check rather than paying a
   * cache rebuild on all of them at the same moment. A reload the person
   * triggered by hand does not come through here; see {@link reloadPlugins}.
   *
   * @param options.mayHold - False when the new set dropped a plugin: nothing
   *   waits on the cache then (the process itself is relaunched before its
   *   next turn, since a reload cannot unload a plugin).
   */
  private async reloadCommandsForLiveSessions({ mayHold }: { mayHold: boolean }): Promise<void> {
    const reloadable = this.sessionStore.getReloadableSessions();
    if (reloadable.length === 0) return;
    await Promise.all(
      reloadable.map(async ({ sessionId, session }) => {
        const queryObj = session.activeQuery ?? session.lastQuery;
        if (!queryObj) return;
        const contextTokens = conversationTokens(session);
        if (!mayHold) {
          // A plugin was withdrawn: never wait on the cache for it.
          try {
            await this.cache.reloadPlugins(queryObj, session.cwd, this.cwd);
          } catch (err) {
            logger.debug('[refreshActivatedPlugins] session hot-reload failed', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }
        try {
          const asked = await this.cache.reloadPlugins(queryObj, session.cwd, this.cwd, {
            holdOnCacheImpact: true,
            sessionId,
            ...(contextTokens !== undefined ? { contextTokens } : {}),
          });
          if (!asked.held) {
            logger.debug('[refreshActivatedPlugins] hot-reloaded session commands', {
              sessionId,
              commands: asked.commandCount,
              plugins: asked.pluginCount,
            });
            return;
          }
          const impact = asked.cacheImpact ?? readCacheImpact(undefined);
          if (pluginReloadIsWorthHolding(contextTokens)) {
            this.pluginReloads.hold({ sessionId, impact, contextTokens });
            logger.debug('[refreshActivatedPlugins] holding a session reload', {
              sessionId,
              contextTokens,
            });
            return;
          }
          // Small enough that waiting would cost more in staleness than it
          // saves. Pay it now and say nothing.
          await this.cache.reloadPlugins(queryObj, session.cwd, this.cwd);
          this.recordPaidPluginReload({
            sessionId,
            deferred: false,
            heldMs: 0,
            release: undefined,
            contextTokens,
            impact,
          });
        } catch (err) {
          // Never strand a reload (spec §risks). The ask is a SECOND control
          // round trip on a channel with a documented habit of going unanswered,
          // and a reload nobody applied is worse than a reload nobody costed —
          // so an unanswered ask falls back to exactly what this path did before
          // the check existed: one plain reload, best-effort.
          logger.debug('[refreshActivatedPlugins] cost check failed, reloading anyway', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          try {
            await this.cache.reloadPlugins(queryObj, session.cwd, this.cwd);
          } catch (fallbackErr) {
            logger.debug('[refreshActivatedPlugins] session hot-reload failed', {
              sessionId,
              error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
            });
          }
        }
      })
    );
  }

  /**
   * Ask again whether a held reload has become free, letting the runtime apply
   * it if it has.
   *
   * The SAME asking call that held it. DorkOS cannot work out when a prompt
   * cache goes cold — the lifetime is an hour on a Claude subscription and five
   * minutes on an API key, and DorkOS chooses neither
   * (`messaging/plugin-reload-policy.ts`) — so the runtime is asked rather than
   * second-guessed, and `held: false` means it has already applied the reload
   * for nothing.
   *
   * @param sessionId - The session to ask about
   * @returns True when the runtime applied the reload
   * @throws PluginReloadSessionGoneError When the session or its query is gone,
   *   which the scheduler reads as "no longer worth applying". A control request
   *   that goes unanswered throws something else, and keeps the wait alive.
   */
  private async recheckHeldPluginReload(sessionId: string): Promise<boolean> {
    const { session, queryObj } = this.reloadableSession(sessionId);
    const contextTokens = conversationTokens(session);
    const asked = await this.cache.reloadPlugins(queryObj, session.cwd, this.cwd, {
      holdOnCacheImpact: true,
      sessionId,
      ...(contextTokens !== undefined ? { contextTokens } : {}),
    });
    return !asked.held;
  }

  /**
   * Apply a held reload unconditionally, paying for the cache rebuild.
   *
   * The plain reload with no options, for the ceiling: the wait has gone on
   * long enough that running a plugin set the disk no longer matches costs more
   * than the rebuild does.
   *
   * @param sessionId - The session whose reload is being paid for
   * @throws PluginReloadSessionGoneError When the session or its query is gone
   */
  private async applyHeldPluginReload(sessionId: string): Promise<void> {
    const { session, queryObj } = this.reloadableSession(sessionId);
    await this.cache.reloadPlugins(queryObj, session.cwd, this.cwd);
  }

  /**
   * The session and the query a held reload has to be spoken to through.
   *
   * @param sessionId - The session to resolve
   * @returns The session record and its live or last query
   * @throws PluginReloadSessionGoneError When either is gone — the reload is
   *   moot, because the next launch reads the plugin set off disk
   */
  private reloadableSession(sessionId: string): { session: AgentSession; queryObj: Query } {
    const session = this.sessionStore.findSession(sessionId);
    const queryObj = session?.activeQuery ?? session?.lastQuery;
    if (!session || !queryObj) {
      // Its own error type, because the scheduler drops a wait on THIS and
      // keeps one on a control request that merely went unanswered.
      throw new PluginReloadSessionGoneError(sessionId);
    }
    return { session, queryObj };
  }

  /**
   * Write one reload that changed a live session's tool list to the activity
   * feed.
   *
   * Only reloads that cost something get an entry: a reload the CLI waved
   * through disturbed no cached conversation and is nobody's business. The
   * estimate the session is never shown — how big the conversation was, and what
   * the reload disturbed — lives here and in the debug log, which is where
   * somebody auditing a day's spend would go looking.
   *
   * @param entry - What was paid, and whether it waited first
   */
  private recordPaidPluginReload(entry: PaidPluginReload): void {
    const port = this.pluginReloadActivity;
    if (!port) return;
    port(entry);
  }

  /**
   * Broadcast a `commands_changed` event on the unified `/api/events` stream so
   * connected clients invalidate their command-registry query and re-fetch.
   * Best-effort: a broadcast failure must never break the install path.
   */
  private broadcastCommandsChanged(): void {
    try {
      eventFanOut.broadcast('commands_changed', { changedAt: new Date().toISOString() });
    } catch (err) {
      // warn, not debug: a failed broadcast means OTHER connected windows never
      // learn to re-fetch, so their command palette stays stale until a manual
      // reload (the initiating window still has its mutation-side invalidation).
      logger.warn('[refreshActivatedPlugins] commands_changed broadcast failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Which Claude account this session runs and bills on — the same answer
   * `resolveLaunch` computes for a turn, for callers outside one.
   *
   * The ladder in full: the account disk has already bound to the session, else
   * the launch ladder (agent manifest pin → configured default → inherited
   * root). Running the launch half matters most for a session whose FIRST turn
   * failed: it has no transcript, so nothing has bound it yet, and an agent
   * pinned to a second account would otherwise resolve to the active one —
   * which is the wrong-account bug one rung down from DOR-1652.
   *
   * Not on the `AgentRuntime` port: accounts are a Claude-Code-only concept, and
   * widening the port for one runtime would oblige every other to answer a
   * question it has no notion of.
   *
   * @param sessionId - DorkOS or SDK session id.
   * @param projectDir - The session's working directory. Keys the transcript
   *   probe; the account pin is read from the home it resolves to, never from a
   *   `.dork/` the folder carries (spec `agent-home-desk` I1).
   * @returns An absolute Claude config directory, or `null` when no account may
   *   work in the folder's project.
   */
  async accountRootForSession(sessionId: string, projectDir: string): Promise<string | null> {
    const settled = await this.sessionStore.settledAccountRoot(
      sessionId,
      this.transcriptReader,
      projectDir
    );
    if (settled) return settled;
    const home = homeOf(resolveAgentHome(projectDir));
    const manifest = home ? await readHomeManifest(home).catch(() => null) : null;
    // Keeps to the accounts that may work in this folder's project; a launch
    // that would be refused predicts no account at all (spec
    // `flow-multiproject` §8.4).
    const launch = resolveLaunchAccountRoot({
      agentAccountId: manifest?.account,
      agentId: manifest?.id,
      project: await projectOfFolder(projectDir),
    });
    return launch.ok ? launch.root : null;
  }

  /**
   * Whether a send to this session may launch, as far as accounts go: the
   * account disk has already bound it to (always allowed; the rule applies
   * when an account is picked, never mid-conversation), else the launch
   * ladder for `hintId` in `projectDir`'s project (spec `flow-multiproject`
   * §8.4). Asked before a session starts, so a refused launch starts nothing.
   *
   * Not on the `AgentRuntime` port, for the reason `accountRootForSession`
   * gives.
   *
   * @param sessionId - DorkOS or SDK session id.
   * @param projectDir - The folder the session runs in.
   * @param hintId - The account a person picked for this session, if any.
   * @returns The account the launch would use, or the refusal.
   */
  async checkLaunchAccount(
    sessionId: string,
    projectDir: string,
    hintId?: string
  ): Promise<LaunchAccountResolution> {
    const settled = await this.sessionStore
      .settledAccountRoot(sessionId, this.transcriptReader, projectDir)
      .catch(() => undefined);
    if (settled) return { ok: true, root: settled, accountId: accountIdForRoot(settled) };
    return checkClaudeLaunchAccount({ cwd: projectDir, hintId });
  }

  /**
   * Whether this session has already settled on an account (it launched, and
   * disk says which account holds it). A session that has not, such as one
   * whose first turn was refused because DorkOS credits were unreachable, may
   * still take the person's pick of account on its next send.
   *
   * @param sessionId - DorkOS or SDK session id.
   * @param projectDir - The folder the session runs in.
   */
  async hasSettledAccount(sessionId: string, projectDir: string): Promise<boolean> {
    const settled = await this.sessionStore
      .settledAccountRoot(sessionId, this.transcriptReader, projectDir)
      .catch(() => undefined);
    return settled !== undefined;
  }

  /** @inheritdoc */
  async renameSession(sessionId: string, title: string, projectDir: string): Promise<void> {
    // `renameSession` runs IN-PROCESS and its options expose no config dir, so
    // the env lock is the only way to point it at the session's OWN account —
    // without it a rename writes into whichever account is active, where the
    // session does not exist, and the new title silently goes nowhere (spec D8).
    const accountRoot = await this.sessionStore.accountRootFor(
      sessionId,
      this.transcriptReader,
      projectDir
    );
    await withClaudeConfigDir(accountRoot, () =>
      sdkRenameSession(sessionId, title, { dir: projectDir })
    );
    // The SDK persists the title; drop the reader's cache so the next read
    // re-extracts it via getSessionInfo (no in-memory title overlay).
    this.transcriptReader.invalidate(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Interactive flows (delegated to SessionStore)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  approveTool(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    options?: ToolDecisionOptions
  ): boolean {
    const resolved = this.sessionStore.approveTool(sessionId, toolCallId, approved, options);
    if (resolved) {
      // `reasonGiven` is asserted HERE, one line from the call that actually
      // handed the reason to the model, so the transcript's "agent was told
      // why" can never outrun what was delivered.
      this.notifyInteractionResolved(sessionId, toolCallId, approved ? 'approved' : 'denied', {
        reasonGiven: !approved && (options?.denyReason?.trim() ?? '') !== '',
        ...(options?.answeredBy ? { answeredBy: options.answeredBy } : {}),
      });
    }
    return resolved;
  }

  /** @inheritdoc */
  submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>,
    options?: InteractionAnswerOptions
  ): boolean {
    const resolved = this.sessionStore.submitAnswers(sessionId, toolCallId, answers);
    if (resolved) {
      this.notifyInteractionResolved(sessionId, toolCallId, 'answered', {
        ...(options?.answeredBy ? { answeredBy: options.answeredBy } : {}),
      });
    }
    return resolved;
  }

  /** @inheritdoc */
  submitElicitation(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
    options?: InteractionAnswerOptions
  ): boolean {
    const resolved = this.sessionStore.submitElicitation(sessionId, interactionId, action, content);
    if (resolved) {
      this.notifyInteractionResolved(
        sessionId,
        interactionId,
        action === 'accept' ? 'answered' : 'denied',
        { ...(options?.answeredBy ? { answeredBy: options.answeredBy } : {}) }
      );
    }
    return resolved;
  }

  /**
   * Emit `interaction_resolved` through the projector so every live `/events`
   * subscriber (this window, other windows, a later replay) drops the pending
   * card — without this the resolution was only observable via the next
   * snapshot, leaving ghost Approve/Deny cards and a `blocked` projection.
   * Peeks under the client-facing id first, then the canonical alias (a
   * pre-rekey projector may still be keyed by the request UUID's canonical id).
   *
   * `opts.answeredBy` rides along untouched. This adapter never resolves a name
   * of its own: whoever called in is the only thing that knows who answered, so
   * an answer that arrived with nobody named stays unnamed all the way to the
   * receipt.
   */
  private notifyInteractionResolved(
    sessionId: string,
    interactionId: string,
    resolution: 'approved' | 'denied' | 'answered',
    opts?: { reasonGiven?: boolean; answeredBy?: string }
  ): void {
    this.resolveLiveProjector(sessionId)?.resolveInteraction(interactionId, resolution, opts);
  }

  /**
   * Resolve the LIVE projector for a session id through the id alias, in either
   * direction: the registry is single-keyed (ADR-0267) and `rekeyProjector`
   * moves a brand-new session's entry from the request UUID to the canonical id
   * mid-first-turn, so a caller may legitimately hold EITHER id while the other
   * one owns the registry entry (acceptance run 20260610-173202, F2: the
   * sidebar navigates by canonical id while the first turn streams under the
   * request UUID — and a pre-remap client URL holds the request UUID after the
   * rekey lands). Returns `undefined` when neither key has a projector.
   */
  private resolveLiveProjector(sessionId: string): SessionStateProjector | undefined {
    return (
      peekProjector(sessionId) ?? peekProjector(this.getInternalSessionId(sessionId) ?? sessionId)
    );
  }

  /** @inheritdoc */
  async stopTask(sessionId: string, taskId: string): Promise<InterruptReceipt> {
    return this.sessionStore.stopTask(sessionId, taskId);
  }

  /** @inheritdoc */
  async interruptQuery(sessionId: string): Promise<InterruptReceipt> {
    const pending = this.#roomPreparing.get(sessionId);
    if (pending) pending.retired = true;
    const nativeEntries = claudeRuntimeEntries.get(this);
    if (nativeEntries)
      for (const [key, entry] of nativeEntries) {
        const canonical = Object.getOwnPropertyDescriptor(entry.session, 'sdkSessionId');
        if (
          key === sessionId ||
          (canonical && 'value' in canonical && canonical.value === sessionId)
        )
          entry.retired = true;
      }
    const connectorCancellation = this.sessionStore.findSession(sessionId)?.connectorTurn?.cancel();
    const receipt = await this.sessionStore.interruptQuery(sessionId);
    await connectorCancellation;
    // A turn DorkOS is only HOLDING open, waiting for an answer the CLI may
    // still send (DOR-2064), has nothing left for an idle CLI to wind down: an
    // acknowledged interrupt produces no `result`, so the hold would run to its
    // 30 s cap and the Stop would look ignored. Settle it on the `result` it holds.
    if (receipt.outcome === 'acked') this.#persistent.settleHeldTurn(sessionId);
    // Only `not-running` falls through. A stop that reached a live query and
    // then failed is a fact about THAT query, and re-aiming it at the booting
    // one would report the second attempt's ending for the first attempt's turn.
    if (receipt.outcome !== 'not-running') return receipt;
    // Nothing on the ordinary path — but a persistent session's FIRST turn may
    // still be booting, so the pump holds a live query the `running` edge has
    // not yet armed `session.activeQuery` with (DOR-1191). Reach that turn
    // through the same interrupt→close escalation the running path uses.
    const bootingQuery = this.#persistent.bootingQuery(sessionId);
    if (bootingQuery !== undefined) {
      return this.sessionStore.interruptGivenQuery(sessionId, bootingQuery);
    }
    // Or a turn the AGENT started, which never armed `session.activeQuery`
    // either: nobody dispatched it, so the pump's `running` edge never fired
    // (spec `warm-process-lifecycle` D6, the Stop rule). Without this, Stop on a
    // turn the person can plainly see answers "nothing is running".
    const runtimeQuery = this.#persistent.runtimeTurnQuery(sessionId);
    if (runtimeQuery === undefined) return receipt;
    return this.sessionStore.interruptGivenQuery(sessionId, runtimeQuery);
  }

  /** @inheritdoc */
  async deliverIntoTurn(
    sessionId: string,
    content: string,
    opts: DeliverIntoTurnOpts
  ): Promise<RuntimeDeliveryResult> {
    if (opts.mode === 'stage') {
      // A stage may have to WARM a cold session — the message has to reach a
      // transcript, and a cold one has none live — so it needs the session
      // record and the launch ports, exactly as a turn does. They are resolved
      // here, from the session's own persisted settings (a stage carries no
      // per-send cwd or model of its own), and handed to the pump. Warming is
      // gated on the opt-in inside {@link PersistentDispatch.stage}, so a session
      // that has not opted in is refused before any process is booted — reaching
      // that refusal means the server ignored {@link canStageSession}.
      const session = await this.sessionStore.ensureForMessage(
        sessionId,
        this.transcriptReader,
        this.cwd
      );
      const cwdKey = session.cwd || this.cwd;
      const senderOpts = this.#buildSenderOpts(sessionId, session, cwdKey);
      return this.#persistent.stage(sessionId, content, opts, session, senderOpts);
    }
    // A steer rides the persistent pump's held input stream. On the resume path
    // there is no held stream that outlives a turn to reach, so a steer there is
    // simply "no open turn" — which `PersistentDispatch.steer` returns for a
    // session it holds no live process for, without special-casing the path.
    return this.#persistent.steer(sessionId, content, opts);
  }

  /**
   * @inheritdoc
   *
   * Steering here rides the persistent pump's held input stream, so the honest
   * answer is the same question `dispatch` asks before every message: will this
   * session's next turn run on a held process? A session already holding one is
   * steerable whatever the setting says now (turning the opt-in OFF does not
   * take a warm session back), and a session holding none is steerable only if
   * the opt-in would give it one. On the resume path — how a default install
   * ships — the answer is `false`, and `deliverIntoTurn` reports `no-open-turn`
   * for a turn that is plainly running (DOR-1268).
   *
   * Deliberately NOT {@link getSessionWarmth}: warmth is about the process this
   * instant (`warm` vs `running`), and a steer offered only while a turn is
   * already open would flicker with the turn rather than describe the session.
   */
  canSteerSession(sessionId: string): boolean {
    return this.#persistent.shouldDispatch(sessionId);
  }

  /**
   * @inheritdoc
   *
   * The same question as {@link canSteerSession}, and for this runtime the same
   * answer — because both rides are the same ride. A native stage appends to the
   * pump's held input stream (`shouldQuery: false`), so a session that will not
   * run its next turn on a held process has no transcript to append to.
   *
   * They stay two methods because they are two claims about two mechanisms, and a
   * runtime can honestly hold one without the other: test-mode declares both while
   * holding no process at all, and a backend with a transcript API but no mid-turn
   * injection would be stageable and not steerable. That claude-code answers them
   * identically is a fact about claude-code, not about the contract.
   *
   * The `false` here is not a refusal. It routes the words to the server's
   * fold-into-next fallback, which is why the composer keeps offering Add context
   * on both paths — and why answering honestly costs the person nothing, while
   * answering `true` cost them a subprocess they never asked for (DOR-1307).
   */
  canStageSession(sessionId: string): boolean {
    return this.#persistent.shouldDispatch(sessionId);
  }

  /**
   * @inheritdoc
   *
   * Only the pump path can strand a turn: on the resume path a turn IS its
   * stream, so a session with nothing held answers `false` without touching
   * anything. Asked with the same id `sendMessage` is asked with, because that
   * is the id the pump's wiring is filed under.
   */
  settleOpenTurn(sessionId: string): Promise<boolean> {
    return Promise.resolve(this.#persistent.settleOpenTurn(sessionId));
  }

  /**
   * @inheritdoc
   *
   * Only the pump path produces these: a turn on the resume path IS the stream
   * the caller asked for, so a session with no held process can never speak
   * between turns. The dispatcher holds the warm process's own bookkeeping, so
   * the subscription rides it rather than being kept here.
   */
  onRuntimeTurn(
    listener: (sessionId: string, events: AsyncIterable<StreamEvent>) => void
  ): () => void {
    return this.#persistent.onRuntimeTurn(listener);
  }

  /** @inheritdoc */
  isSegmentPending(sessionId: string): boolean {
    return this.#persistent.isSegmentPending(sessionId);
  }

  /** @inheritdoc */
  onDispatchGateChange(listener: (sessionId: string) => void): () => void {
    return this.#persistent.onDispatchGateChange(listener);
  }

  /** @inheritdoc */
  switchWhenReady(sessionId: string): boolean {
    return this.#persistent.switchWhenReady(sessionId);
  }

  /** @inheritdoc */
  onDispatchedTurn(listener: (sessionId: string) => void): () => void {
    return this.#persistent.onDispatchedTurn(listener);
  }

  /** @inheritdoc */
  holdsBackgroundWork(sessionId: string): boolean {
    // The warm path only. A resumed turn's process ends with its turn, and the
    // CLI ends its own background work with it, so nothing can follow.
    return this.#persistent.holdsBackgroundWork(sessionId);
  }

  /** @inheritdoc */
  isHelperWorking(sessionId: string): boolean {
    if (this.#persistent.isHelperWorking(sessionId)) return true;
    // The resume path: the running turn's own tracker. Its ceiling is measured
    // from the turn's start, the one moment this path records; the pump's is
    // measured from its busy spell.
    const session = this.sessionStore.findSession(sessionId);
    if (session?.liveHelperCount === undefined) return false;
    return (
      session.liveHelperCount() > 0 &&
      // Awake time, so a laptop asleep mid-turn does not end the wait on waking (DOR-2717).
      performance.now() - (session.turnStartedAwake ?? performance.now()) <
        SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS
    );
  }

  /** @inheritdoc */
  getSessionWarmth(sessionId: string): SessionWarmth {
    return this.pumps.warmth(sessionId);
  }

  /**
   * Stop every session running on DorkOS credits: interrupt a turn in flight
   * and give back a warm process. Called when this computer is unlinked, so no
   * process keeps a credits token after the link it was minted under is gone
   * (ADR 261001-000811). The sessions themselves stay; their next turn is
   * refused until credits can be had again.
   */
  async stopCreditsSessions(): Promise<void> {
    const ids = this.sessionStore.sessionIdsWhere((session) => {
      const root = session.launchedAccountRoot ?? session.accountRoot;
      return root !== undefined && isCreditsClaudeRoot(root);
    });
    for (const id of ids) {
      await this.interruptQuery(id).catch(() => undefined);
      // Evicted, not reaped: a polite reap declines a process still holding
      // background work, and a revoked token must not stay live for hours
      // behind a running shell (DOR-2065).
      this.#persistent.forget(id);
      await this.pumps.evict(id).catch(() => undefined);
    }
  }

  /** @inheritdoc */
  async reapSession(sessionId: string): Promise<void> {
    const nativeEntries = claudeRuntimeEntries.get(this);
    if (nativeEntries)
      for (const [key, entry] of nativeEntries) {
        const canonical = Object.getOwnPropertyDescriptor(entry.session, 'sdkSessionId');
        if (
          key === sessionId ||
          (canonical && 'value' in canonical && canonical.value === sessionId)
        )
          entry.retired = true;
      }
    // A reaped pump is SPENT — the registry drops it, and `SessionPump` refuses
    // everything asked of it afterwards. Forgetting the wiring in the same beat
    // is what makes the next message build a fresh one instead of dispatching
    // into a pump that can only throw.
    if (await this.pumps.reap(sessionId)) this.#persistent.forget(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Session queries (delegated to TranscriptReader)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async listSessions(projectDir: string): Promise<Session[]> {
    return this.transcriptReader.listSessions(projectDir);
  }

  /**
   * @inheritdoc
   *
   * One store per Claude account: an account DorkOS cannot read costs that
   * account's sessions and nothing else, so the accounts that read still list
   * (spec `claude-code-accounts` AC6).
   */
  async listSessionsWithWarnings(
    projectDir: string
  ): Promise<{ sessions: Session[]; warnings: SessionListWarning[] }> {
    return this.transcriptReader.listSessionsAcrossAccounts(projectDir);
  }

  /** @inheritdoc */
  async getSession(projectDir: string, sessionId: string): Promise<Session | null> {
    return this.transcriptReader.getSession(projectDir, sessionId);
  }

  /**
   * Whether this session bills per token rather than against its account's
   * subscription (spec `claude-account-fleet` §6 U): what its last launch here
   * did, else whether it has had a subscription reading of its own, else what
   * its next launch would do, read off the environment a launch would get (a
   * stored key, credits, or one inherited from the server's own environment),
   * and per token when that cannot be told. A per-token session's `usage` stays
   * its own cost.
   *
   * Not on the `AgentRuntime` port, for the reason `accountRootForSession`
   * is not: accounts are a Claude-Code-only concept.
   *
   * @param sessionId - DorkOS or SDK session id.
   */
  async sessionBillsPerToken(sessionId: string): Promise<boolean> {
    const session = this.sessionStore.findSession(sessionId);
    if (session?.launchedPerToken !== undefined) return session.launchedPerToken;
    if (session?.lastSubscriptionUsage?.kind === 'subscription') return false;
    const root = session?.accountRoot;
    return predictLaunchBillsPerToken(
      readPerTokenSignals(root !== undefined && isCreditsClaudeRoot(root))
    );
  }

  /**
   * @inheritdoc
   *
   * The transcript tail's last assistant usage: the same bounded 64 KB read
   * the session list's `contextTokens` comes from (`readTailStatus`), cached
   * under the file's mtime. The transcript records no context window and the
   * SDK's model list carries none either (`runtime-cache.ts`), so the window is
   * `0`, which every reader shows as an unknown percentage until a turn reports
   * the real one.
   */
  async readContextUsage(
    sessionId: string,
    cwd: string | undefined
  ): Promise<{ contextTokens: number; contextMaxTokens: number } | null> {
    try {
      const projectDir = cwd ?? this.sessionStore.findSession(sessionId)?.cwd ?? this.cwd;
      const historyId = this.getInternalSessionId(sessionId) ?? sessionId;
      const session = await this.transcriptReader.getSession(projectDir, historyId);
      if (!session?.contextTokens) return null;
      return { contextTokens: session.contextTokens, contextMaxTokens: 0 };
    } catch {
      return null;
    }
  }

  /**
   * @inheritdoc
   *
   * The transcript is SDK JSONL, which records that a tool ran or did not and
   * nothing about a person having been asked first — so the permission
   * decisions DorkOS recorded for this session are overlaid back on
   * ({@link overlayApprovalReceipts}), and so are the tool calls it refused
   * before anyone could be asked ({@link overlayPermissionDenials}). This is the
   * seam BOTH history consumers
   * pass through — `GET /:id/messages` and `getSessionSnapshot`'s loader — so
   * reopening a conversation shows the same receipts a live one does. The
   * transcript reader stays a JSONL parser and learns nothing about DorkOS
   * interactions.
   */
  async getMessageHistory(projectDir: string, sessionId: string): Promise<HistoryMessage[]> {
    const images: TranscriptImageRef[] = [];
    const messages = await this.transcriptReader.readTranscript(projectDir, sessionId, images);
    // The same seam, for the same reason: the reader stays a JSONL parser, and
    // what DorkOS did with the bytes a tool returned is overlaid back here.
    // Re-materializing is idempotent — the attachment id is derived from the
    // tool call, so reopening a transcript finds the first read's file instead
    // of writing a second copy (`media-capture.ts`).
    //
    // **Idempotent only because both paths key storage on the CANONICAL id.**
    // `sessionId` here is already canonical: both callers translate first
    // (`getSessionSnapshot`'s `historyId`, and `GET /:id/messages`'s
    // `internalSessionId`), because the transcript on disk is named by it. The
    // live path had to be taught to match — it stores under
    // `session.sdkSessionId`, not the id its turn was asked with, which on a new
    // session's first turn is a different string. Keyed on the request id, this
    // call looked in a directory the live turn never wrote to and produced a
    // second copy at a second URL (DOR-1664 review).
    //
    // claude-code is the only runtime that can hit this, and both halves of the
    // reason are here: it is the only one that RENAMES a session mid-turn
    // (`getInternalSessionId` returns undefined for codex and opencode), and the
    // only one that rebuilds history by re-parsing a transcript rather than
    // replaying recorded `image_attachment` events, which carry their URL
    // (`services/session/event-log-history.ts`).
    await attachTranscriptImages(this.attachments, sessionId, messages, images);
    // And the third pass, for the refusals nobody was asked about (DOR-795): a
    // BACKGROUNDED subagent's denied tool call is written into the child's
    // transcript, not this one, so without this the conversation comes back
    // showing an agent that stopped making progress for no stated reason.
    // And the fourth, for turns that ran on another model than the session
    // names because DorkOS credits do not cover it (DOR-2636): the transcript
    // names the model that ran and never the one it replaced.
    // And the fifth, for summaries the agent asked for itself (DOR-2732): the
    // transcript records that the conversation was summarized, never who asked.
    return overlayAgentCompactions(
      sessionId,
      overlayModelSubstitutions(
        sessionId,
        overlayPermissionDenials(sessionId, overlayApprovalReceipts(sessionId, messages))
      )
    );
  }

  /**
   * @inheritdoc
   *
   * Completed `messages` come from the JSONL transcript via `getMessageHistory`
   * (injected as the projector's `loadHistory` loader — "own the boundary, not
   * the bytes", ADR-0263); the live in-progress turn, status, pending
   * interactions, and `cursor` come from the per-session projector's in-memory
   * projection.
   *
   * Both halves resolve through the id alias (acceptance run 20260610-173202,
   * F1/F2): the transcript on disk is named by the CANONICAL id, so a
   * client-facing request UUID must be translated for the history loader (the
   * same translation `GET /:id/messages` does) — without it the snapshot
   * hydrates with empty history mid-first-turn. The projector lookup goes
   * through {@link resolveLiveProjector} so whichever id currently owns the
   * registry entry serves the live turn.
   */
  async getSessionSnapshot(ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot> {
    const projectDir = ctx.cwd ?? this.cwd;
    const historyId = this.getInternalSessionId(sessionId) ?? sessionId;
    const projector =
      this.resolveLiveProjector(sessionId) ?? getOrCreateProjector(sessionId, projectDir);
    return projector.buildSnapshot(() => this.getMessageHistory(projectDir, historyId));
  }

  /**
   * @inheritdoc
   *
   * Delegates to the per-session projector's resumable stream: if `sinceCursor`
   * is supplied it replays buffered events with a greater seq before going
   * live. The projector is fed normalized {@link SessionEvent}s by the
   * `session-event-normalizer` — for DorkOS-triggered turns via `feedProjector`
   * (wired in task #6, the message-POST decouple) and, in a later task, for
   * externally-appended JSONL via the file-watch path. This method itself is
   * source-agnostic: it only reads the projector.
   */
  subscribeSession(
    ctx: SessionOpts,
    sessionId: string,
    sinceCursor?: number,
    signal?: AbortSignal
  ): AsyncIterable<SessionEvent> {
    return this.streamProjector(ctx, sessionId).subscribe(sinceCursor, signal);
  }

  /**
   * @inheritdoc
   *
   * Answered off {@link resolveLiveProjector} — the SAME resolution
   * {@link subscribeSession} binds through, and the reason this is a runtime
   * method at all. This adapter reaches a session's projector through the SDK id
   * alias as well as the registry, so a generation read off the bare session id
   * would report "unowned" for a session an alias-resolved projector is actively
   * streaming, and the mismatch check downstream would then wave every stale
   * cursor through (DOR-1704).
   *
   * Peek-only, unlike {@link streamProjector}: the caller asks this BEFORE it
   * commits to a resume, and a question must not mint the counter it is asking
   * about. A session with no projector reads as unowned, and the fresh projector
   * the subsequent subscribe mints refuses every cursor above 0 on its own.
   */
  streamGeneration(_ctx: SessionOpts, sessionId: string): string {
    return streamGenerationOf(this.resolveLiveProjector(sessionId));
  }

  /**
   * The projector this adapter's durable stream binds a session to.
   *
   * Alias-aware like getSessionSnapshot: a subscription opened under the
   * pre-remap request UUID after the rekey (or under the canonical id before
   * it) must park on the LIVE projector, not mint a fresh empty one.
   *
   * @param ctx - Session context; supplies the cwd a freshly minted projector takes.
   * @param sessionId - Target session ID, canonical or retired.
   */
  private streamProjector(ctx: SessionOpts, sessionId: string): SessionStateProjector {
    return (
      this.resolveLiveProjector(sessionId) ?? getOrCreateProjector(sessionId, ctx.cwd ?? this.cwd)
    );
  }

  /**
   * @inheritdoc
   *
   * Wraps {@link watchSessionList}: emits one `session_upserted` per session
   * already on disk — fleet-wide, across every project slug directory under every
   * Claude ACCOUNT's `projects/` — then upserts/removals as transcripts change in
   * any of them, including sessions created or appended by the Claude Code CLI
   * outside DorkOS (ADR-0263). Each session carries its true `cwd` from the
   * JSONL head, so multi-project clients route events to the right list
   * (SRV-I4), and the account it belongs to. `ctx` is unused: the contract is
   * "ALL sessions the adapter can observe", not a per-cwd scope. Debounced, and
   * emitted only on a real transition — a reconcile sweep re-reads the projects
   * directories on a timer, but it is a source of rescans, not of events, and
   * exists because chokidar drops what happens while it is attaching (DOR-577).
   */
  subscribeSessionList(_ctx: SessionOpts): AsyncIterable<SessionListEvent> {
    return watchSessionList(this.transcriptReader);
  }

  /** @inheritdoc */
  async getSessionTasks(projectDir: string, sessionId: string): Promise<TaskItem[]> {
    return this.transcriptReader.readTasks(projectDir, sessionId);
  }

  /** @inheritdoc */
  async getSessionETag(projectDir: string, sessionId: string): Promise<string | null> {
    return this.transcriptReader.getTranscriptETag(projectDir, sessionId);
  }

  /** @inheritdoc */
  getSessionCwd(sessionId: string): string | undefined {
    return this.sessionStore.findSession(sessionId)?.cwd;
  }

  /**
   * @inheritdoc
   *
   * The account this session's turns run and bill on, as the absolute Claude
   * config directory (`~/.claude`, `~/.claude2`, …) — the directory that IS a
   * Claude Code account, because it carries that account's own sign-in
   * (`claude-config-dir.ts`).
   *
   * The last LAUNCH's account first, then the transcript's. They agree whenever
   * both exist — a launch resolves `session.accountRoot ?? ladder` — and the
   * launch is the more precise answer on the one turn where they differ: a
   * brand-new session has no transcript yet, so disk knows nothing while the
   * ladder has already decided which credential the turn is using. Asking the
   * transcript alone would leave the first turn of every new session
   * unattributed, which is exactly the turn a dead credential fails on.
   *
   * `undefined` means no launch in this process and no transcript on disk. Never
   * a guess: resolving the ladder here instead would answer with the account a
   * launch WOULD pick, which is wrong for any session started from a per-send
   * hint or an agent manifest, and wrong in both directions at once.
   *
   * **`path.resolve` is load-bearing, not tidiness.** The contract is that two
   * sessions on one account answer the same string, and the roots reaching this
   * method are spelled by whoever typed them: `resolveLaunchAccountRoot` returns
   * a registry row's `path` verbatim (`claude-config-dir.ts`), the
   * `defaultAccount` rung returns that field verbatim, and the config schema
   * constrains neither to be absolute or slash-free. So one session launched
   * from a hint naming `/x/.claude2/` and another from the default naming
   * `/x/.claude2` are the SAME account with two spellings — and the watch
   * compares with `===`. Left raw, a sign-in fixed on one spelling could never
   * resolve an episode raised under the other, and the notice would stand for
   * the life of the install. Every sibling comparison in this subsystem
   * normalizes the same way (`samePath` in `launch-fingerprint.ts`,
   * `claudeConfigDirEnv` in `claude-config-dir.ts`); this is not the place to be
   * the exception.
   */
  getSessionAccount(sessionId: string): string | undefined {
    const session = this.sessionStore.findSession(sessionId);
    const root = session?.launchedAccountRoot ?? session?.accountRoot;
    return root === undefined ? undefined : path.resolve(root);
  }

  /** @inheritdoc */
  async getLastMessageIds(sessionId: string): Promise<{ user: string; assistant: string } | null> {
    try {
      const session = this.sessionStore.findSession(sessionId);
      const projectDir = session?.cwd ?? this.cwd;
      const messages = await this.transcriptReader.readTranscript(projectDir, sessionId);
      if (!messages.length) return null;

      let lastUser: string | null = null;
      let lastAssistant: string | null = null;

      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!lastAssistant && m.role === 'assistant') lastAssistant = m.id;
        if (!lastUser && m.role === 'user') lastUser = m.id;
        if (lastUser && lastAssistant) break;
      }

      if (!lastUser || !lastAssistant) return null;
      return { user: lastUser, assistant: lastAssistant };
    } catch (err) {
      logger.warn('[getLastMessageIds] failed to read transcript', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** @inheritdoc */
  async readFromOffset(
    projectDir: string,
    sessionId: string,
    offset: number
  ): Promise<{ content: string; newOffset: number }> {
    return this.transcriptReader.readFromOffset(projectDir, sessionId, offset);
  }

  // ---------------------------------------------------------------------------
  // Session locking (delegated to SessionLockManager)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean {
    return this.lockManager.acquireLock(sessionId, clientId, res, token);
  }

  /** @inheritdoc */
  acquireRuntimeLock(sessionKey: string, res: SseResponse, token?: symbol): boolean {
    return this.lockManager.acquireRuntimeLock(sessionKey, res, token);
  }

  /** @inheritdoc */
  releaseLock(sessionId: string, clientId: string, token?: symbol): void {
    this.lockManager.releaseLock(sessionId, clientId, token);
  }

  /** @inheritdoc */
  isLocked(sessionId: string, clientId?: string): boolean {
    return this.lockManager.isLocked(sessionId, clientId);
  }

  /** @inheritdoc */
  getLockInfo(sessionId: string): { clientId: string; acquiredAt: number } | null {
    return this.lockManager.getLockInfo(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Models & subagents (delegated to RuntimeCache)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async getSupportedModels(): Promise<ModelOption[]> {
    return this.cache.getSupportedModels();
  }

  /** @inheritdoc */
  async getSupportedSubagents(): Promise<SubagentInfo[]> {
    return this.cache.getSupportedSubagents();
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async getCommands(forceRefresh?: boolean, cwd?: string): Promise<CommandRegistry> {
    const root = cwd || this.cwd;
    const registry = this.getOrCreateRegistry(root);
    // Plugin commands (e.g. `/flow:*`) live in the SDK, not on the filesystem,
    // so the cold-cache fallback (`command-registry` scans `.claude/commands/`
    // only) can't surface them. When this cwd has no SDK command list yet, warm
    // it in the background so the palette shows those commands before the
    // session's first message. Whether any plugins actually apply (global OR
    // project-scoped under `<cwd>/.dork/plugins/`) is decided inside
    // `warmCommands` — it exits before booting a probe when none do.
    // Fire-and-forget: the probe broadcasts `commands_changed` on completion,
    // which re-fetches the palette.
    if (!this.cache.hasSdkCommands(root)) {
      void this.warmCommands(root);
    }
    return this.cache.getCommands(registry, root, forceRefresh);
  }

  /**
   * Warm a cwd's SDK command cache without running a turn. Boots an idle
   * streaming-input probe ({@link createIdlePrompt}), reads the authoritative
   * command list the SDK reports at initialize (built-ins plus activated plugin
   * commands), writes it into the per-cwd cache, and broadcasts
   * `commands_changed` so a connected palette re-fetches. No user message is
   * sent, so no turn runs and no tokens are spent.
   *
   * Best-effort: no-ops when the cache is already warm, a probe is in flight,
   * or no plugins (global or project-scoped) apply to this cwd; times out
   * defensively; swallows failures (the post-first-message path still
   * populates the cache); and always closes the subprocess.
   *
   * @param cwd - Project directory whose command cache to warm.
   */
  private async warmCommands(cwd: string): Promise<void> {
    if (this.cache.hasSdkCommands(cwd) || this.warmingCwds.has(cwd)) return;
    const failedAt = this.warmFailedAt.get(cwd);
    if (
      failedAt !== undefined &&
      Date.now() - failedAt < ClaudeCodeRuntime.WARM_FAILURE_COOLDOWN_MS
    ) {
      return;
    }
    this.warmingCwds.add(cwd);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Both hoisted so the `finally` can close whatever was actually created:
    // the plugins check below can exit before either exists, and `query()` can
    // throw with `probe` still undefined. Closing stdin via `idle.close()`
    // alone does NOT tear down the CLI child — `Query.close()` does (see
    // RuntimeCache.warmup, which closes the query even though its input
    // generator completes immediately).
    let idle: ReturnType<typeof createIdlePrompt> | undefined;
    let probe: ReturnType<typeof query> | undefined;
    try {
      // Only GLOBAL plugins are SDK-injected now; a project-scoped plugin's
      // commands reach this cwd as `.claude/commands/<pkg>/` wrappers the FS
      // registry already covers, so no probe is needed for them. When no global
      // plugin applies, skip the probe entirely; built-ins arrive with the
      // first real message.
      const plugins = this.activatedPlugins;
      if (plugins.length === 0) return;
      idle = createIdlePrompt();
      probe = query({
        prompt: idle.prompt,
        options: {
          cwd,
          plugins,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['local', 'project', 'user'],
          ...(this.spawnBinaryPath ? { pathToClaudeCodeExecutable: this.spawnBinaryPath } : {}),
          env: runtimeEnvironment('claude-code', 'warmup', {
            // The probe gets the same explicit account pin a turn does, for two
            // reasons. `settingSources` includes `'user'`, which resolves under
            // the config dir — an inherited root would warm this cwd's palette
            // from ANOTHER account's user settings, and could boot against an
            // account that is not signed in. And an explicit entry keeps the
            // probe out of reach of the process-global mutation the D8 env lock
            // holds during a rename or fork. There is no session here, so the
            // ACTIVE account is the only account this can mean.
            ...claudeConfigDirEnv(resolveActiveClaudeRoot()),
          }),
        },
      });
      const commands = await Promise.race([
        probe.supportedCommands(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('warmCommands: supportedCommands timed out')),
            ClaudeCodeRuntime.WARM_TIMEOUT_MS
          );
        }),
      ]);
      // Provisional: the probe omits `mcpServers` (real sessions inject them),
      // so this list can miss MCP-contributed commands. Marking it provisional
      // lets the first real message re-fetch the authoritative, MCP-inclusive
      // set — the palette still populates immediately in the meantime.
      this.cache.replaceSdkCommands(
        cwd,
        commands.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
          aliases: c.aliases,
        })),
        { provisional: true }
      );
      this.broadcastCommandsChanged();
      this.warmFailedAt.delete(cwd);
      logger.debug('[warmCommands] warmed command cache', { cwd, count: commands.length });
    } catch (err) {
      // Record the failure so the cooldown guard suppresses a re-probe storm if
      // the SDK is persistently broken (bad auth, missing binary, boot crash).
      this.recordWarmFailure(cwd);
      logger.debug('[warmCommands] probe failed; cache stays cold until first message', {
        cwd,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (timer) clearTimeout(timer);
      // Close the query (kills the CLI child) AND the held prompt (closes
      // stdin). Either can be undefined: the no-applicable-plugins exit creates
      // neither, and a `query()` throw leaves `probe` unset — hence the guards.
      probe?.close();
      idle?.close();
      this.warmingCwds.delete(cwd);
    }
  }

  /**
   * Record a warm-probe failure for `cwd` and prune stale entries.
   *
   * Entries older than {@link WARM_FAILURE_COOLDOWN_MS} are past their cooldown,
   * so they no longer suppress a re-probe and only leak memory — prune them on
   * write so {@link warmFailedAt} stays bounded by the number of cwds that
   * failed within the last cooldown window, not every cwd that ever failed.
   *
   * @param cwd - Project directory whose warm probe just failed.
   */
  private recordWarmFailure(cwd: string): void {
    const now = Date.now();
    for (const [key, at] of this.warmFailedAt) {
      if (now - at >= ClaudeCodeRuntime.WARM_FAILURE_COOLDOWN_MS) {
        this.warmFailedAt.delete(key);
      }
    }
    this.warmFailedAt.set(cwd, now);
  }

  /** Get or create a CommandRegistryService for the given root, with LRU eviction. */
  private getOrCreateRegistry(root: string): CommandRegistryService {
    let registry = this.commandRegistries.get(root);
    if (!registry) {
      if (this.commandRegistries.size >= ClaudeCodeRuntime.MAX_COMMAND_REGISTRIES) {
        const oldest = this.commandRegistries.keys().next().value!;
        this.commandRegistries.delete(oldest);
      }
      registry = new CommandRegistryService(root);
      this.commandRegistries.set(root, registry);
    }
    return registry;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  checkSessionHealth(): void {
    // Drop the projector of every evicted session (I1 fix — the registry Map
    // otherwise grows per session id forever). The store returns each evicted
    // session's request UUID AND its canonical sdkSessionId: rekeyProjector
    // moves a brand-new session's projector to the canonical id mid-first-turn,
    // so disposing by the map key alone would miss every rekeyed projector and
    // leak it (plus its EventLog). A session evicted MID-TURN is first marked
    // `interrupted` so any client still on its `/events` stream sees the turn
    // close (lifecycle `interrupted`) rather than a frozen "Thinking…" before
    // the projector is disposed (ADR-0262/0264 restart/eviction degradation).
    // markInterrupted is a no-op for an idle projector.
    // A session whose warm process is still doing background work is skipped
    // for now: eviction is unconditional, so it would end a helper agent or an
    // undelivered notification that the idle reaper already refuses to touch
    // (spec `warm-process-lifecycle` D1). The pump answers, because the pump is
    // what holds the level frame; a session with no warm process holds nothing
    // and evicts exactly as it did before.
    const evictedIds = this.sessionStore.checkSessionHealth(
      this.lockManager,
      (sessionId) => this.pumps.peek(sessionId)?.isHoldingWork() === true
    );
    for (const sessionId of evictedIds) {
      // No subprocess may outlive the session record it belongs to. Eviction
      // ALWAYS implies a reap; the idle timer's reap never implies an eviction
      // (spec §4.3). Not awaited, because this sweep is synchronous by contract
      // and a close that takes its grace window must not hold it up — and never
      // bare `void`, because a wedged teardown rejecting would take the server
      // down with it. A no-op for a session that never opted in: nothing warms a
      // pump unless `runtimes.claudeCode.persistentSession` is on — not a turn,
      // and not a staged message either, which is what DOR-1307 restored.
      //
      // The wiring is forgotten alongside the process, so a session that comes
      // back builds a fresh pump rather than dispatching into a spent one. Done
      // FIRST and synchronously: the teardown below is awaited by nobody, and a
      // message arriving in that window must not find a bundle whose pump is
      // already on its way out.
      this.#persistent.forget(sessionId);
      // A reload waiting for this session's cache to go cold has nothing left to
      // apply: the process is going, and the next launch reads the plugin set
      // off disk. Dropped rather than paid — nothing was spent, so nothing is
      // recorded (spec `plugin-reload-cache-cost`).
      this.pluginReloads.cancel(sessionId);
      this.pumps.evict(sessionId).catch((err: unknown) => {
        logger.warn('[ClaudeCodeRuntime] evicted session failed to give back its process', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // Drop the session's captured diff baselines (DOR-212) — they are in-memory
      // and per-session, so an evicted session must not leak them. Idempotent for
      // an id that captured none.
      editBaselineStore.clearSession(sessionId);
      const projector = peekProjector(sessionId);
      if (!projector) continue;
      projector.markInterrupted();
      disposeProjector(sessionId);
    }
  }

  /** @inheritdoc */
  getInternalSessionId(sessionId: string): string | undefined {
    return this.sessionStore.getInternalSessionId(sessionId);
  }

  /**
   * Backward-compatible alias for `getInternalSessionId`.
   *
   * @deprecated Use `getInternalSessionId()` instead.
   */
  getSdkSessionId(sessionId: string): string | undefined {
    return this.sessionStore.getSdkSessionId(sessionId);
  }

  // ---------------------------------------------------------------------------
  // MCP status (delegated to RuntimeCache)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  getMcpStatus(cwd: string): McpServerEntry[] | null {
    return this.cache.getMcpStatus(cwd);
  }

  /** @inheritdoc */
  getMcpServerConfig(cwd: string, serverName: string): McpAppServerConnection | null {
    return this.cache.getMcpServerConfig(cwd, serverName);
  }

  /**
   * Always `true` (spec `tool-only-room-replies` §D2).
   *
   * The `dorkos` server runs INSIDE a claude-code session rather than over a
   * wire, so there is no configuration to be wrong: all four room verbs sit in
   * `ALWAYS_LOADED_TOOLS` (`mcp-tools/tool-exposure.ts`) and reach the registry
   * in-process. Nothing an operator can switch off takes them away.
   *
   * @returns `true`.
   */
  async carriesRoomTools(): Promise<boolean> {
    return true;
  }

  /**
   * Forward the servers this turn's status snapshot reports as not having come up
   * (DOR-981) — a trigger to LOOK, never a verdict.
   *
   * Which statuses those are belongs to the mesh ({@link mcpAuthEvidenceFrom}),
   * along with the reasons the report cannot be trusted on its own. This runtime
   * reports what it saw and forgets. Silent when everything connected, so the
   * port is only woken by news.
   */
  private reportMcpAuthFailures(sessionId: string, cwd: string, servers: McpServerEntry[]): void {
    const port = this.mcpAuthEvidence;
    if (!port) return;
    const serverNames = mcpAuthEvidenceFrom(servers);
    if (serverNames.length === 0) return;
    port({ sessionId, cwd, serverNames });
  }

  /**
   * @inheritdoc
   *
   * **Never held, whatever it costs** (spec `plugin-reload-cache-cost`). This is
   * the reload somebody asked for — `POST /api/sessions/:id/reload-plugins`, a
   * person who wants the new plugin in this session now — and a request answered
   * with "in a few minutes" is not an answer. The cost check exists to keep
   * reloads NOBODY asked for from spending quietly; it has no business
   * overruling one somebody did.
   *
   * It also ends any wait already running on this session: the plugins are live
   * either way, so the held reload has been paid, and the activity feed records
   * it as such.
   */
  async reloadPlugins(sessionId: string): Promise<ReloadPluginsResult | null> {
    const session = this.sessionStore.findSession(sessionId);
    const queryObj = session?.activeQuery ?? session?.lastQuery;
    if (!queryObj) {
      logger.warn('[reloadPlugins] no query available', { sessionId });
      return null;
    }
    try {
      const contextTokens = conversationTokens(session!);
      const result = await this.cache.reloadPlugins(queryObj, session!.cwd, this.cwd);
      // Settled AFTER the apply landed: a reload that threw leaves the wait
      // armed, so a failed hand trigger never strands the held reload.
      const settled = this.pluginReloads.settle(sessionId, 'hand-triggered');
      // An expensive reload is recorded whether or not a wait was running
      // (decision 8: held OR above threshold). Nothing was holding when the
      // person reloads a busy session the fan-out never reached — and that is
      // exactly the reload worth a line in the feed. Below the threshold this
      // stays silent, like every other cheap reload.
      if (!settled && pluginReloadIsWorthHolding(contextTokens)) {
        this.recordPaidPluginReload({
          sessionId,
          deferred: false,
          heldMs: 0,
          release: 'hand-triggered',
          contextTokens,
          // Nothing asked what this reload would disturb — it was applied
          // outright — so there is nothing honest to put here.
          impact: readCacheImpact(undefined),
        });
      }
      logger.info('[reloadPlugins] plugins reloaded', {
        sessionId,
        commands: result.commandCount,
        plugins: result.pluginCount,
        errorCount: result.errorCount,
      });
      return {
        commandCount: result.commandCount,
        pluginCount: result.pluginCount,
        errorCount: result.errorCount,
      };
    } catch (err) {
      logger.error('[reloadPlugins] reload failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // A timeout is NOT the `null` case (DOR-1301). `null` means "no query to
      // ask", which the route answers with "send a message first" — a sentence
      // that is simply false about a session whose query existed and did not
      // answer in time. Rethrown so the route can say the true thing.
      if (err instanceof ControlRequestTimeoutError) throw err;
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Tool server
  // ---------------------------------------------------------------------------

  /** Return the MCP tool server config (stub session — used for introspection only). */
  getToolServerConfig(): Record<string, unknown> {
    if (!this.mcpServerFactory) return {};
    const stubSession = {
      eventQueue: [],
      pendingInteractions: new Map(),
      permissionMode: 'default',
      lastActivity: Date.now(),
      hasStarted: false,
    } as unknown as AgentSession;
    // Empty session id: introspection only, so the DevTools read tools register
    // as their session-less variants (no live preview buffer to bind to).
    return this.mcpServerFactory(stubSession, '');
  }
}
