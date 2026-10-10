/** Genuine owned replies paired with explicit ordinary-only foreign sequence schedules. */
import assert from 'node:assert/strict';
import type { RoomEvent } from '@dorkos/shared/room-schemas';
import { runtimeRegistry, readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { readTestModeOriginalActiveStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import type { OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';
import { runOriginalNativeRunnerForeignLockControl } from './room-original-native-runner-foreign-lock-control.js';

type Mode =
  | 'runner-unstarted-cancel-data'
  | 'runner-started-failed-data'
  | 'runner-delayed-start-data'
  | 'runner-own-tail-data'
  | 'runner-foreign-words-data'
  | 'runner-own-activity-data'
  | 'runner-foreign-approval-data';
export function makeOriginalNativeReplyIdentityControl() {
  const observations = new Map<string, OriginalRoomRunnerObservation>();
  let latest: OriginalRoomRunnerObservation | undefined;
  let release: (() => void) | undefined;
  let retiring = false;
  return {
    observeRun(entryId: string, observation: OriginalRoomRunnerObservation) {
      observations.set(entryId, observation);
      latest = observation;
    },
    releaseProvider() {
      retiring = true;
      release?.();
    },
    async run(owning: OriginalNativeLaunchFixture, mode: Mode) {
      if (mode === 'runner-unstarted-cancel-data') {
        // Accepted-and-dropped timing is ordinary DATA above. Native counterpart
        // proves honest pre-launch busy/no producer; it is not labelled accepted.
        await runOriginalNativeRunnerForeignLockControl(owning, () => latest);
        return;
      }
      const target = await owning.bootNativeAgent();
      const selected = runtimeRegistry.get('claude-code');
      const raw = readOriginalRegisteredRuntime(selected);
      assert.ok(raw);
      const originalScenario = scenarioStore.getScenario;
      const originalInterrupt = selected.interruptQuery;
      let failed = false;
      let first: unknown;
      const remember = (cause: unknown): void => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      let starts = 0;
      let firstEntry: string | undefined;
      let secondEntry: string | undefined;
      let idle: Promise<void> | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const frames: RoomEvent[] = [];
      const abortFrames = new AbortController();
      const subscription = owning.subsystem.broadcaster.subscribe(
        owning.roomId,
        abortFrames.signal
      );
      const frameDrain = (async () => {
        for await (const frame of subscription) frames.push(frame);
      })();
      void frameDrain.catch(remember);
      const ownActivity = () =>
        frames.filter(
          (event) =>
            event.type === 'signal' &&
            event.authorId === target.authorId &&
            event.activity?.target === 'standup.md'
        );
      scenarioStore.getScenario = function (sessionId) {
        const original = Reflect.apply(originalScenario, this, [sessionId]);
        if (sessionId !== target.sessionId) return original;
        return async function* (_content, context) {
          try {
            assert.equal(readOriginalRegisteredRuntime(runtimeRegistry.get('claude-code')), raw);
            assert.ok(readTestModeOriginalActiveStream(selected, target.sessionId));
            assert.equal(context.sessionId, target.sessionId);
            const entryId = owning.readPreparedContext(target.sessionId)?.triggerEntryId;
            assert.ok(entryId && observations.has(entryId));
            const index = ++starts;
            if (mode === 'runner-own-tail-data' && index === 1) {
              yield { type: 'text_delta', data: { text: 'the build is ' } };
              if (!retiring) await held;
              yield { type: 'text_delta', data: { text: 'green and here is why' } };
            } else if (mode === 'runner-started-failed-data') {
              yield { type: 'text_delta', data: { text: 'Half an answer.' } };
              yield {
                type: 'session_status',
                data: { sessionId: target.sessionId, terminalReason: 'error' },
              };
              yield {
                type: 'error',
                data: {
                  message: 'Original started turn failed',
                  code: 'original_started_failure',
                  category: 'execution_error',
                },
              };
            } else {
              if (mode === 'runner-own-activity-data') {
                yield {
                  type: 'tool_call_start',
                  data: {
                    toolCallId: 'original-own-read',
                    toolName: 'Read',
                    input: '{"file_path":"/repo/standup.md"}',
                    status: 'running',
                  },
                };
                if (!retiring) await held;
              }
              await Promise.resolve();
              yield {
                type: 'text_delta',
                data: {
                  text:
                    mode === 'runner-delayed-start-data'
                      ? 'Paris.'
                      : mode === 'runner-own-tail-data'
                        ? 'the tests pass'
                        : 'green',
                },
              };
            }
            yield { type: 'done', data: { sessionId: target.sessionId } };
          } catch (cause) {
            remember(cause);
            throw cause;
          }
        };
      };
      const post = (text: string) =>
        owning.subsystem.service.post(owning.roomId, {
          authorId: owning.operator.id,
          text,
          mentions: [target.authorId],
        });
      try {
        firstEntry = post('is the build green?').id;
        idle = owning.subsystem.service.triggersIdle();
        void idle.catch(remember);
        for (let i = 0; i < 1000 && starts === 0 && !failed; i++)
          await new Promise((resolve) => setTimeout(resolve, 1));
        if (failed) throw first;
        assert.equal(starts, 1);
        if (mode === 'runner-own-tail-data') secondEntry = post('and the tests?').id;
        if (mode === 'runner-own-activity-data') {
          for (let i = 0; i < 1000 && ownActivity().length === 0 && !failed; i++)
            await new Promise((resolve) => setTimeout(resolve, 1));
          if (failed) throw first;
          assert.ok(ownActivity().length > 0);
          assert.ok(
            !frames.some(
              (event) =>
                event.type === 'signal' &&
                event.authorId === target.authorId &&
                event.activity?.target === 'secrets.md'
            )
          );
        }
        release?.();
        await idle;
        const own = observations.get(firstEntry);
        assert.ok(own);
        const completion = await own.completion;
        if (completion.kind !== 'returned') throw completion.cause;
        assert.equal(completion.kind, 'returned');
        assert.equal(
          completion.result.text,
          mode === 'runner-started-failed-data'
            ? 'Half an answer.'
            : mode === 'runner-own-tail-data'
              ? 'the build is green and here is why'
              : mode === 'runner-delayed-start-data'
                ? 'Paris.'
                : 'green'
        );
        assert.equal(
          completion.result.unanswered,
          mode === 'runner-started-failed-data' ? 'failed' : undefined
        );
        if (mode === 'runner-own-tail-data') {
          assert.ok(secondEntry);
          const second = observations.get(secondEntry);
          assert.ok(second);
          const result = await second.completion;
          if (result.kind !== 'returned') throw result.cause;
          assert.equal(result.kind, 'returned');
          assert.equal(result.result.text, 'the tests pass');
          assert.equal(starts, 2);
        }
        if (mode === 'runner-foreign-approval-data') {
          const notices = owning.subsystem.store.listEntries(owning.roomId, { limit: 1000 });
          assert.ok(
            !notices.some(
              (entry) =>
                entry.body.subjectAuthorId === target.authorId &&
                entry.body.notice === 'awaiting_approval'
            )
          );
        }
        // The live broadcaster drains independently of Trigger completion.
        // Require its real terminal frame within the original settlement bound.
        const ownTerminalClear = () =>
          frames.some(
            (event) =>
              event.type === 'signal' &&
              event.signal === 'progress' &&
              event.authorId === target.authorId &&
              event.entryId === firstEntry &&
              event.state === 'done' &&
              event.activity === undefined
          );
        let settled = false;
        for (let i = 0; i < 1000 && !settled; i++) {
          assert.equal(readOriginalRegisteredRuntime(runtimeRegistry.get('claude-code')), raw);
          settled =
            !isTurnInFlight(target.sessionId, selected) &&
            peekProjector(target.sessionId)?.getStatus().lifecycle ===
              (mode === 'runner-started-failed-data' ? 'error' : 'idle') &&
            (mode !== 'runner-own-activity-data' || ownTerminalClear());
          if (!settled) await new Promise((resolve) => setTimeout(resolve, 1));
        }
        assert.equal(settled, true);
        if (mode === 'runner-own-activity-data') {
          assert.ok(ownTerminalClear());
        }
      } catch (cause) {
        remember(cause);
      } finally {
        retiring = true;
        try {
          release?.();
        } catch (cause) {
          remember(cause);
        }
        let interrupted: Promise<unknown> | undefined;
        try {
          const attempt: Promise<unknown> = Reflect.apply(originalInterrupt, selected, [
            target.sessionId,
          ]);
          interrupted = attempt;
          void attempt.catch(remember);
        } catch (cause) {
          remember(cause);
        }
        try {
          abortFrames.abort();
        } catch (cause) {
          remember(cause);
        }
        if (idle) {
          try {
            await idle;
          } catch (cause) {
            remember(cause);
          }
        }
        if (interrupted) {
          try {
            await interrupted;
          } catch (cause) {
            remember(cause);
          }
        }
        try {
          await frameDrain;
        } catch (cause) {
          remember(cause);
        }
        try {
          scenarioStore.getScenario = originalScenario;
        } catch (cause) {
          remember(cause);
        }
      }
      if (failed) throw first;
    },
  };
}
