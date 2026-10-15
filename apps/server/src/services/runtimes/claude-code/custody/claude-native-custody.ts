import {
  readOriginalRegisteredNativeStream,
  readOriginalRegisteredRuntime,
} from '../../../core/runtime-registry.js';
import { isAbsolvingTerminalReason } from '@dorkos/shared/run-outcome';
import { isInterruptedTerminalReason } from '@dorkos/shared/schemas';
import { readOriginalRoomDispatchLifecycle } from '../../../session/trigger-turn.js';
import type { OriginalRoomDispatchCustody } from '../../../rooms/service/room-core.js';
import {
  requireOriginalCommittedRoomResponder,
  consumeOriginalCommittedRoomResponder,
  retireOriginalCommittedRoomResponder,
} from '../../../canvas/doc-channel/operations/room-current-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../../canvas/doc-channel/current/current-operation-types.js';
import { readClaudeConnectorContext } from '../connector-turn-context.js';
import { isCurrentClaudeNativeSession } from '../sessions/session-store.js';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { MessageOpts, SseResponse } from '@dorkos/shared/agent-runtime';
import type { SessionStore } from '../sessions/session-store.js';
import { type PaidPluginReload } from '../messaging/plugin-reload-policy.js';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  type NativeSessionAcquisition,
} from '../../../session/session-lock.js';
import type { AgentSession } from '../agent-types.js';
import type { PersistentDispatch } from '../sessions/persistent-dispatch.js';
import type { ClaudeConnectorTurnContext } from '../connector-turn-context.js';
import type { ClaudeCodeRuntime } from '../claude-code-runtime.js';

/** Original constructor-recorded native turn DATA; this type cannot register custody. */
export type ClaudeNativeEntry = {
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
/** Exact retained original Room continuation DATA; this type cannot issue FIRST authority. */
export type ClaudePreparedRoomContinuation = {
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
/** Best-effort remembrance of a paid plugin reload; must never throw back into the turn. */
export type PluginReloadActivityPort = (entry: PaidPluginReload) => void;
/** Allocate unrelated native custody maps; only the runtime module retains the original actual instance. */
export function createIsolatedClaudeNativeCustody() {
  const originalClaudeLockedStreams = new WeakMap<
    object,
    { runtime: object; sessionId: string; options: Readonly<MessageOpts>; current(): boolean }
  >();
  /** Fixed constructor-created stream identity plus the original live acquisition; never a supplied stream matcher. */
  function readClaudeOriginalLockedStream(
    runtime: object,
    sessionId: string,
    stream: object
  ): boolean {
    const own = originalClaudeLockedStreams.get(stream);
    return !!own && own.runtime === runtime && own.sessionId === sessionId && own.current();
  }
  /** Exact original opened turn DATA; a supplied observer cannot replace these options. */
  function readClaudeOriginalLockedTurnOptions(runtime: object, sessionId: string, stream: object) {
    const own = originalClaudeLockedStreams.get(stream);
    return own && own.runtime === runtime && own.sessionId === sessionId && own.current()
      ? { options: own.options }
      : undefined;
  }
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
  async function retireClaudeOriginalRoomResponderStream(stream: object): Promise<void> {
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
  function readClaudeOriginalRoomResponderStream(
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
      readClaudePreparedRoomResponder(own.runtime, own.prepared)?.nativeOperation !==
        own.operation ||
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
  /**
   * Claude Code Runtime — implements the AgentRuntime interface for the Claude Agent SDK.
   *
   * Thin facade that coordinates SessionStore, TranscriptReader,
   * and CommandRegistryService.
   *
   * @module services/runtimes/claude-code/claude-code-runtime
   */

  /**
   * Where a plugin reload that cost something goes to be remembered.
   *
   * Best-effort by contract: it is handed a fact and must never throw one back —
   * a feed that cannot be written is not a reason for a reload to fail.
   */

  /**
   * Claude Code runtime implementing the universal AgentRuntime interface.
   *
   * Manages Claude Agent SDK sessions — creation, resumption, streaming, tool approval,
   * and session locking. Delegates to focused collaborators for session state (SessionStore),
   * SDK response caching (RuntimeCache), transcript reading, broadcasting, and locking.
   */

  const claudeLockMoves = new WeakMap<
    object,
    (oldKey: string, canonicalKey: string, holder: SseResponse) => boolean
  >();
  /** Closed genuine Claude canonical move; caller strings cannot change the runtime's original session identity. */
  function moveClaudeOriginalLockedAcquisition(
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
  function sendClaudeOriginalLockedMessage(
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

  const claudeRoomQuerySessions = new WeakMap<AgentSession, ClaudePreparedRoomContinuation>();
  /** Fixed sender boundary: ordinary sessions do not acquire dedicated start authority. */
  function requireOriginalClaudeRoomQueryStart(
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
  function prepareClaudeOriginalLockedRoomResponder(
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
  function retireClaudePreparedRoomResponder(
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
  function readClaudePreparedRoomResponder(runtime: object, prepared: PreparedRoomResponder) {
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
  function startClaudeCommittedRoomResponder(
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
  function readOriginalClaudeRoomPersistentRequest(
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
  function requireOriginalClaudeRoomPersistentEffect(persistent: object, args: object): void {
    const own = originalClaudePersistentRequests.get(args);
    if (!own || readOriginalClaudeRoomPersistentRequest(persistent, args) !== args)
      throw new Error('Persistent Room effect lacks original request custody.');
    requireOriginalClaudeRoomQueryStart(own.continuation.session);
  }
  /** Ordinary persistent calls cannot operate a live dedicated native session. */
  function requireOriginalClaudePersistentSession(
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
    (
      request: import('../../../rooms/room-turn-port.js').RoomTurnRequest,
      retiredId: string
    ) => boolean
  >();
  /** Fixed original constructor lookup; no runtime method override or caller checker grants an exemption. */
  function isClaudeOriginalRoomLaunchAlias(
    runtime: object,
    request: import('../../../rooms/room-turn-port.js').RoomTurnRequest,
    retiredId: string
  ): boolean {
    runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
    return claudeOriginalLaunchAliases.get(runtime)?.(request, retiredId) === true;
  }
  const claudeNativeConstructors = new WeakSet<object>();
  const claudeNativeOperations = new WeakMap<object, ClaudeNativeEntry>();
  const claudeRuntimeEntries = new WeakMap<object, Map<string, ClaudeNativeEntry>>();
  const claudeOriginalSessionOperations = new WeakMap<AgentSession, object>();
  /** Capture a refusal-only check for the exact original turn across asynchronous SDK loading. */
  function captureClaudeOriginalQueryCurrent(session: AgentSession): (() => void) | undefined {
    const operation = claudeOriginalSessionOperations.get(session);
    if (!operation) return;
    const entry = claudeNativeOperations.get(operation);
    const context = entry?.context;
    const requireCurrent = () => {
      const slot = entry && Object.getOwnPropertyDescriptor(entry.instance, 'sessionStore');
      const contextSlot = Object.getOwnPropertyDescriptor(session, 'connectorTurn');
      const signal = context ? readClaudeConnectorContext(context) : undefined;
      if (
        !entry ||
        entry.session !== session ||
        claudeOriginalSessionOperations.get(session) !== operation ||
        entry.retired ||
        !claudeNativeConstructors.has(entry.instance) ||
        !slot ||
        !('value' in slot) ||
        slot.value !== entry.store ||
        !isCurrentClaudeNativeSession(entry.store, session) ||
        entry.context !== context ||
        !contextSlot ||
        !('value' in contextSlot) ||
        contextSlot.value !== context ||
        (context !== undefined && (!signal || signal.aborted))
      )
        throw new Error('Original Claude query turn retired or changed during SDK acquisition.');
    };
    requireCurrent();
    return requireCurrent;
  }
  /** Fixed constructor-owned session and turn lifetime; a reinserted evicted object stays retired. */
  function readClaudeNativeOperation(token: object) {
    const entry = claudeNativeOperations.get(token);
    if (
      entry?.roomOrigin &&
      readOriginalRoomDispatchLifecycle(entry.roomOrigin.holder, entry.instance) !==
        entry.roomOrigin.custody
    ) {
      entry.retired = true;
      return undefined;
    }
    const slot = entry
      ? Object.getOwnPropertyDescriptor(entry.instance, 'sessionStore')
      : undefined;
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
  return Object.freeze({
    originalClaudeLockedStreams,
    originalClaudeRoomStreams,
    claudeLockMoves,
    claudeLockedRunners,
    claudeRoomPreparers,
    claudeRoomQuerySessions,
    claudeRoomPrepared,
    claudeOriginalStores,
    originalClaudePersistentRequests,
    claudeOriginalLaunchAliases,
    claudeNativeConstructors,
    claudeNativeOperations,
    claudeRuntimeEntries,
    claudeOriginalSessionOperations,
    readClaudeOriginalLockedStream,
    readClaudeOriginalLockedTurnOptions,
    retireClaudeOriginalRoomResponderStream,
    readClaudeOriginalRoomResponderStream,
    moveClaudeOriginalLockedAcquisition,
    sendClaudeOriginalLockedMessage,
    requireOriginalClaudeRoomQueryStart,
    prepareClaudeOriginalLockedRoomResponder,
    retireClaudePreparedRoomResponder,
    readClaudePreparedRoomResponder,
    startClaudeCommittedRoomResponder,
    readOriginalClaudeRoomPersistentRequest,
    requireOriginalClaudeRoomPersistentEffect,
    requireOriginalClaudePersistentSession,
    isClaudeOriginalRoomLaunchAlias,
    captureClaudeOriginalQueryCurrent,
    readClaudeNativeOperation,
  });
}
