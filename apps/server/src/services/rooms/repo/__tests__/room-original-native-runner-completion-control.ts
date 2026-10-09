/** Read-only original Runner completion from a genuinely acquired native stream. */
import assert from 'node:assert/strict';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  createSessionRoomTurnRunner,
  readOriginalRoomRunnerObservation,
  readOriginalSessionRoomRunner,
  type OriginalRoomRunnerObservation,
} from '../../room-turn-runner.js';
import { getSessionEventStore } from '../../../session/session-state-projector.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { readTestModeOriginalActiveStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { uiTurnFacts } from '../../../session/browser-seat/ui-turn-facts.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

export async function runOriginalNativeRunnerCompletionControl(
  owning: OriginalNativeLaunchFixture,
  mode:
    | 'runner-completion'
    | 'runner-stream-text'
    | 'runner-empty-text'
    | 'runner-content'
    | 'runner-paragraphs'
    | 'runner-token-counts'
    | 'runner-failed'
    | 'runner-quiet'
    | 'runner-no-files'
    | 'runner-framing'
    | 'runner-durable-error'
    | 'runner-durable-log'
    | 'runner-desk-guard'
    | 'runner-optional-posting'
    | 'runner-false-posting'
    | 'runner-posting-home'
    | 'runner-turn-boundary' = 'runner-completion'
): Promise<void> {
  const target =
    mode === 'runner-framing'
      ? (await owning.bootNativePair())[0]!
      : await owning.bootNativeAgent();
  if (mode === 'runner-framing') {
    const human = owning.subsystem.authors.setHandle(owning.operator.id, 'dorian');
    assert.equal(human.kind, 'human');
    assert.equal(human.handle, 'dorian');
  }
  const selectedRuntime = runtimeRegistry.get('claude-code');
  const originalQuestion = selectedRuntime.carriesRoomTools;
  const postingQuestions: unknown[][] = [];
  const foreign = createSessionRoomTurnRunner();
  const originalRead = scenarioStore.getScenario;
  const originalRun = owning.runner.run;
  const originalInterrupt = owning.runner.interrupt;
  const observation: { current?: OriginalRoomRunnerObservation } = {};
  let entryId: string | undefined;
  let starts = 0;
  const parts =
    mode === 'runner-optional-posting' ||
    mode === 'runner-false-posting' ||
    mode === 'runner-desk-guard'
      ? ['green']
      : mode === 'runner-no-files'
        ? []
        : mode === 'runner-empty-text' || mode === 'runner-quiet'
          ? ['   ']
          : ['Green', ' — ', 'nothing failed.'];
  const supplied: string[] = [];
  scenarioStore.getScenario = function (sessionId) {
    const originalScenario = Reflect.apply(originalRead, this, [sessionId]);
    if (sessionId !== target.sessionId) return originalScenario;
    return async function* (content, context, opts) {
      const runtime = runtimeRegistry.get('claude-code');
      const prepared = owning.readPreparedContext(target.sessionId);
      assert.equal(context.sessionId, target.sessionId);
      assert.ok(readTestModeOriginalActiveStream(runtime, target.sessionId));
      assert.equal(prepared?.room.id, owning.roomId);
      assert.equal(prepared?.triggerEntryId, entryId);
      if (mode === 'runner-framing') {
        assert.ok(prepared);
        assert.equal(prepared.room.name, '#backend');
        assert.equal(prepared.members.find((member) => member.handle === 'dorian')?.isPerson, true);
        assert.equal(prepared.members.find((member) => member.handle === 'ana')?.isPerson, false);
      }
      assert.equal(uiTurnFacts.read(target.sessionId).roomTurn?.roomId, owning.roomId);
      assert.equal(typeof opts?.roomTurn?.turnId, 'string');
      if (mode === 'runner-desk-guard') {
        assert.equal(opts?.cwd, target.agentPath);
        assert.equal(opts?.forAgent, target.agentPath);
      }
      if (mode === 'runner-no-files') {
        assert.ok(opts);
        assert.equal(Object.hasOwn(opts, 'additionalDirectories'), false);
        assert.ok(opts.roomTurn);
        assert.equal(Object.hasOwn(opts.roomTurn, 'worktree'), false);
      }
      assert.ok(entryId);
      assert.equal(readOriginalRoomRunnerObservation(foreign, entryId), undefined);
      assert.equal(
        readOriginalRoomRunnerObservation(owning.runner, 'not-the-original-entry'),
        undefined
      );
      observation.current = readOriginalRoomRunnerObservation(owning.runner, entryId);
      assert.ok(observation.current);
      assert.equal(readOriginalRoomRunnerObservation(owning.runner, entryId), observation.current);
      assert.ok(readOriginalSessionRoomRunner(owning.runner));
      assert.equal(owning.runner.run, originalRun);
      assert.equal(owning.runner.interrupt, originalInterrupt);
      supplied.push(content);
      starts++;
      yield {
        type: 'session_status',
        data: { sessionId: target.sessionId, model: 'test-mode' },
      } as StreamEvent;
      if (mode === 'runner-turn-boundary') {
        yield { type: 'text_delta', data: { text: 'first' } };
        yield { type: 'done', data: { sessionId: target.sessionId } };
        // Later bytes on the same genuine stream are not the completed turn's answer.
        yield { type: 'text_delta', data: { text: 'second' } };
      } else if (mode === 'runner-paragraphs') {
        yield { type: 'text_delta', data: { text: 'Let me read the release notes first.' } };
        yield {
          type: 'tool_call_start',
          data: { toolCallId: 'call-1', toolName: 'Read', status: 'running' },
        };
        yield {
          type: 'tool_result',
          data: {
            toolCallId: 'call-1',
            toolName: 'Read',
            status: 'complete',
            result: 'v2.1 shipped',
          },
        };
        yield { type: 'text_delta', data: { text: 'Congrats on shipping v2.1!' } };
      } else if (mode === 'runner-token-counts') {
        yield { type: 'text_delta', data: { text: 'The build is ' } };
        yield { type: 'session_status', data: { sessionId: target.sessionId, outputTokens: 12 } };
        yield { type: 'text_delta', data: { text: 'green.' } };
      } else if (mode === 'runner-failed' || mode === 'runner-durable-error') {
        yield {
          type: 'session_status',
          data: { sessionId: target.sessionId, terminalReason: 'error' },
        };
        yield {
          type: 'error',
          data: {
            message: 'Scripted original provider failure',
            code: 'original_reply_failure',
            category: 'execution_error',
          },
        };
      } else {
        for (const text of parts) yield { type: 'text_delta', data: { text } } as StreamEvent;
      }
      yield { type: 'done', data: { sessionId: target.sessionId } } as StreamEvent;
    };
  };
  let failed = false;
  let first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    if (mode === 'runner-posting-home') {
      assert.equal(typeof originalQuestion, 'function');
      if (!originalQuestion) throw new Error('Original posting question absent');
      selectedRuntime.carriesRoomTools = new Proxy(originalQuestion, {
        apply(original, receiver, args) {
          postingQuestions.push(args);
          return Reflect.apply(original, receiver, args);
        },
      });
    }
    const entry = owning.subsystem.service.post(owning.roomId, {
      authorId: owning.operator.id,
      text: 'is the build green?',
      mentions: [target.authorId],
    });
    entryId = entry.id;
    await owning.subsystem.service.triggersIdle();
    assert.equal(starts, 1);
    if (mode === 'runner-posting-home') {
      assert.deepEqual(postingQuestions, [
        [
          {
            cwd: target.agentPath,
            sessionId: target.sessionId,
            agentPath: target.agentPath,
          },
        ],
      ]);
    }
    const captured = observation.current;
    assert.ok(captured);
    const outcome = await captured.completion;
    if (outcome.kind !== 'returned') throw outcome.cause;
    assert.equal(outcome.kind, 'returned');
    assert.equal(
      outcome.result.text,
      mode === 'runner-empty-text' ||
        mode === 'runner-quiet' ||
        mode === 'runner-failed' ||
        mode === 'runner-durable-error' ||
        mode === 'runner-no-files'
        ? null
        : mode === 'runner-turn-boundary'
          ? 'first'
          : mode === 'runner-paragraphs'
            ? 'Let me read the release notes first.\n\nCongrats on shipping v2.1!'
            : mode === 'runner-token-counts'
              ? 'The build is green.'
              : mode === 'runner-optional-posting' ||
                  mode === 'runner-false-posting' ||
                  mode === 'runner-desk-guard'
                ? 'green'
                : 'Green — nothing failed.'
    );
    // Actual acquired provider input, not reconstructed public request DATA.
    assert.equal(supplied.length, 1);
    assert.equal(supplied[0], 'is the build green?');
    assert.equal(outcome.result.sessionId, target.sessionId);
    assert.equal(
      outcome.result.unanswered,
      mode === 'runner-failed' || mode === 'runner-durable-error' ? 'failed' : undefined
    );
    if (mode === 'runner-durable-error' || mode === 'runner-durable-log') {
      const store = getSessionEventStore();
      assert.ok(store);
      const recorded = store.readAll(outcome.result.sessionId);
      if (mode === 'runner-durable-error') {
        const last = recorded.at(-1);
        assert.equal(last?.type, 'turn_end');
        assert.ok(last && last.type === 'turn_end');
        assert.equal(last.terminalReason, 'error');
      } else {
        assert.equal(
          recorded.some((event) => event.type === 'text_delta'),
          true
        );
      }
    }
    assert.equal(readOriginalRoomRunnerObservation(owning.runner, entryId), undefined);
    assert.ok(readOriginalSessionRoomRunner(owning.runner));
    assert.equal(owning.runner.run, originalRun);
    assert.equal(owning.runner.interrupt, originalInterrupt);
  } catch (cause) {
    remember(cause);
  } finally {
    try {
      if (mode === 'runner-posting-home') selectedRuntime.carriesRoomTools = originalQuestion;
    } catch (cause) {
      remember(cause);
    }
    try {
      scenarioStore.getScenario = originalRead;
    } catch (cause) {
      remember(cause);
    }
  }
  if (failed) throw first;
}
