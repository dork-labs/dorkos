import { readOriginalTestModeScenarioView } from '../test-mode-runtime.js';
import { randomUUID } from 'node:crypto';
import { sendOriginalRoomResponderScriptStep } from '../../../canvas/doc-channel/downstream/native-room-emitter.js';
import { rekeyOriginalRuntimeSessionSettings } from '../../../core/runtime-registry.js';
import { requireCurrentOriginalNativeTurn } from '../../../connectors/principal/runtime-principal-service.js';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
} from '../../../session/session-lock.js';
import { consumeOriginalCommittedRoomResponder } from '../../../canvas/doc-channel/operations/room-responder-operation.js';
import type {
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../../canvas/doc-channel/current/current-operation-types.js';
import { renderDocEvents } from '../../../canvas/doc-channel/prompt.js';
import type { MessageOpts, CommandIntentOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { heldProcesses } from '../held-process.js';
import { ScenarioAborted, interactionGate } from '../interaction-gate.js';
import {
  scenarioStore,
  originalRoomPartialAckReplyScenario,
  originalNativeCanonicalRekeyScenario,
} from '../scenario-store.js';
import type { TestModeScenarioSessionView } from './test-mode-scenario-session-types.js';
import type { TestModeInstalled } from '../native/test-mode-native-types.js';

/** Allocate a separate private family; actual registration remains root lexical. */
export function createIsolatedTestModeScenario() {
  const views = new WeakMap<object, TestModeScenarioSessionView>();
  const get = WeakMap.prototype.get,
    set = WeakMap.prototype.set,
    apply = Reflect.apply;
  function read(owner: object): TestModeScenarioSessionView {
    const view = apply(get, views, [owner]);
    if (!view) throw new Error('Original TestMode Scenario owner required.');
    return view;
  }
  return {
    register(owner: object, view: TestModeScenarioSessionView): void {
      apply(set, views, [owner, view]);
    },
    read,
  };
}

/** Run the original scripted turn only after actual-root scenario custody selection. */
export async function* sendScenario(
  owner: object,
  sessionId: string,
  content: string,
  opts?: MessageOpts,
  native?: {
    own: TestModeInstalled;
    room?: { prepared: PreparedRoomResponder; committed: OriginalCommittedRoomResponder };
  }
): AsyncGenerator<StreamEvent> {
  const view = readOriginalTestModeScenarioView(owner);
  let ctx: ReturnType<typeof interactionGate.open> | undefined;
  let heldTurn: ReturnType<typeof heldProcesses.beginTurn> = undefined;
  let failed = false,
    first: unknown;
  view.openTurns.set(sessionId, (view.openTurns.get(sessionId) ?? 0) + 1);
  try {
    // Read the original persisted settings without replacing native turn custody.
    const stored = await view.settingsPort?.getSessionSettings(sessionId);
    if (native) {
      requireCurrentOriginalNativeTurn(view.nativePrincipals!, native.own.operation);
      if (!view.custody.readTestModeNativeOperation(native.own.operation))
        throw new Error('TestMode original scenario entry retired during settings acquisition.');
    }
    view.registry.recordMessage(sessionId, content, {
      ...(stored?.permissionMode !== undefined ? { permissionMode: stored.permissionMode } : {}),
      ...(stored?.model !== undefined ? { model: stored.model } : {}),
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    if (!native) view.revealCanonicalSessionId(sessionId);
    const scenario = scenarioStore.getScenario(sessionId);
    const opened = interactionGate.open(sessionId);
    ctx = opened;
    if (native)
      native.own.entry.closeScenario = () => interactionGate.close(sessionId, opened.token);
    const scenarioContext = {
      ...opened,
      docEventsPrompt: opts?.additionalContext
        ?.filter((entry) => entry.kind === 'doc_events')
        .map((entry) => renderDocEvents(entry.data))
        .join('\n\n'),
    };
    heldTurn = heldProcesses.beginTurn(sessionId);
    if (native) {
      requireCurrentOriginalNativeTurn(view.nativePrincipals!, native.own.operation);
      if (!view.custody.readTestModeNativeOperation(native.own.operation))
        throw new Error('TestMode original scenario entry retired before effect.');
      if (native.room)
        consumeOriginalCommittedRoomResponder(
          native.room.committed,
          view.runtime,
          native.room.prepared,
          native.own.operation
        );
    }
    // Count the actual original local provider entry, after the private once-start consume.
    if (native) {
      native.own.entry.scenarioStarts++;
      view.originalScenarioStarts++;
    }
    if (scenario === originalNativeCanonicalRekeyScenario) {
      if (!native || native.room || !view.nativePrincipals)
        throw new Error('Canonical recovery requires an original native interactive turn');
      native.own.entry.canonicalScenarioStarted = true;
      yield { type: 'session_status', data: { sessionId, model: 'test-mode' } } as StreamEvent;
      yield {
        type: 'text_delta',
        data: { text: 'NATIVE_CANONICAL_REKEY_WAITING' },
      } as StreamEvent;
      await scenarioContext.awaitStep();
      requireCurrentOriginalNativeTurn(view.nativePrincipals, native.own.operation);
      const canonicalId = randomUUID();
      await rekeyOriginalRuntimeSessionSettings(
        view.runtime,
        view.nativePrincipals,
        sessionId,
        canonicalId
      );
      const time = Date.now(),
        activity = captureNativeSessionActivity(native.own.entry.acquisition, time);
      if (
        !view.custody.readTestModeNativeOperation(native.own.operation) ||
        !activity ||
        !readNativeSessionAcquisition(native.own.entry.acquisition, activity, time, sessionId)
      )
        throw new Error('Original canonical source retired during settings move');
      native.own.entry.canonicalSessionId = canonicalId;
      view.registry.rekey(sessionId, canonicalId);
      yield {
        type: 'session_status',
        data: { sessionId: canonicalId, model: 'test-mode' },
      } as StreamEvent;
      yield { type: 'text_delta', data: { text: 'NATIVE_CANONICAL_REKEY_HELD' } } as StreamEvent;
      await scenarioContext.awaitStep();
      yield { type: 'done', data: { sessionId: canonicalId } } as StreamEvent;
    } else if (scenario === originalRoomPartialAckReplyScenario) {
      if (!native?.room || !view.nativeRoomEmitter)
        throw new Error(
          'Original Room partial reply scenario requires the installed native emitter.'
        );
      yield { type: 'session_status', data: { sessionId, model: 'test-mode' } } as StreamEvent;
      await sendOriginalRoomResponderScriptStep(
        view.nativeRoomEmitter,
        native.room.committed,
        view.runtime,
        native.room.prepared,
        native.own.operation,
        'ack-first'
      );
      // A real operator step keeps the source turn/FIRST alive while the first receipt is inspected.
      yield {
        type: 'text_delta',
        data: { text: 'First native document input acknowledged.' },
      } as StreamEvent;
      await scenarioContext.awaitStep();
      requireCurrentOriginalNativeTurn(view.nativePrincipals!, native.own.operation);
      await sendOriginalRoomResponderScriptStep(
        view.nativeRoomEmitter,
        native.room.committed,
        view.runtime,
        native.room.prepared,
        native.own.operation,
        'reply-second'
      );
      yield { type: 'done', data: { sessionId } } as StreamEvent;
    } else {
      yield* scenario(content, scenarioContext, opts);
    }
  } catch (cause) {
    if (cause instanceof ScenarioAborted) {
      yield {
        type: 'session_status',
        data: { sessionId: 'test-mode', terminalReason: 'aborted_streaming' },
      } as StreamEvent;
      yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
    } else {
      failed = true;
      first = cause;
    }
  } finally {
    try {
      if (ctx) interactionGate.close(sessionId, ctx.token);
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    try {
      if (heldTurn !== undefined) heldProcesses.endTurn(sessionId, heldTurn);
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    const open = (view.openTurns.get(sessionId) ?? 1) - 1;
    if (open > 0) view.openTurns.set(sessionId, open);
    else view.openTurns.delete(sessionId);
  }
  if (failed) throw first;
}
/** Yield the original synthetic command turn while retaining its open-turn cleanup. */
export async function* executeCommandIntent(
  owner: object,
  sessionId: string,
  _intent: RuntimeCommandIntentId,
  _opts?: CommandIntentOpts
): AsyncGenerator<StreamEvent> {
  const view = readOriginalTestModeScenarioView(owner);
  view.openTurns.set(sessionId, (view.openTurns.get(sessionId) ?? 0) + 1);
  try {
    yield* view.syntheticCompaction();
    yield { type: 'done', data: { sessionId } };
  } finally {
    const open = (view.openTurns.get(sessionId) ?? 1) - 1;
    if (open > 0) view.openTurns.set(sessionId, open);
    else view.openTurns.delete(sessionId);
  }
}
/** Yield the original full-fidelity compaction event sequence from the genuine scenario view. */
export async function* syntheticCompaction(owner: object): AsyncGenerator<StreamEvent> {
  const view = readOriginalTestModeScenarioView(owner);
  // Full-fidelity, in the Claude adapter's own shape: the progress pair its
  // system-event mapper builds from `status:'compacting'` and
  // `compact_result:'success'`, around a boundary carrying the same four
  // camelCased fields it forwards from `compact_metadata`. A bare
  // `{trigger:'manual'}` satisfied the conformance suite but left every
  // reading the boundary row exists to report empty, so nothing downstream
  // was ever driven with real numbers.
  yield {
    type: 'operation_progress',
    data: {
      operation: 'compaction',
      state: 'started',
      determinate: false,
      message: 'Compacting context…',
    },
  };
  yield {
    type: 'compact_boundary',
    data: { trigger: 'manual', preTokens: 51_226, postTokens: 4_151, durationMs: 63_275 },
  };
  yield {
    type: 'operation_progress',
    data: { operation: 'compaction', state: 'done', determinate: false },
  };
}
