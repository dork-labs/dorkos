/** Actual held native provider and constructor completion; no synthetic trigger or projector ingress. */
import assert from 'node:assert/strict';
import { runtimeRegistry, readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { readTestModeOriginalActiveStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { type OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

type WaitCase =
  | 'runner-late-answer'
  | 'runner-half-answer'
  | 'runner-clamped-ceiling'
  | 'runner-unclosed-ceiling';
export function makeOriginalRunnerNativeWaitControl() {
  let observation: OriginalRoomRunnerObservation | undefined;
  let observedEntry: string | undefined;
  let release: (() => void) | undefined;
  return {
    observeRun(entryId: string, current: OriginalRoomRunnerObservation) {
      observedEntry = entryId;
      observation = current;
    },
    releaseProvider() {
      release?.();
    },
    async run(owning: OriginalNativeLaunchFixture, mode: WaitCase) {
      const target = await owning.bootNativeAgent();
      const selected = runtimeRegistry.get('claude-code');
      const raw = readOriginalRegisteredRuntime(selected);
      assert.ok(raw);
      const originalRead = scenarioStore.getScenario;
      let entryId: string | undefined;
      let entered!: () => void;
      const entering = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let starts = 0;
      let enteredProvider = false;
      let rejectEntry!: (cause: unknown) => void;
      const entryFailure = new Promise<never>((_resolve, reject) => {
        rejectEntry = reject;
      });
      void entryFailure.catch(() => undefined);
      scenarioStore.getScenario = function (sessionId) {
        const original = Reflect.apply(originalRead, this, [sessionId]);
        if (sessionId !== target.sessionId) return original;
        return async function* (content, context) {
          try {
            assert.equal(context.sessionId, target.sessionId);
            assert.equal(readOriginalRegisteredRuntime(runtimeRegistry.get('claude-code')), raw);
            assert.ok(readTestModeOriginalActiveStream(selected, target.sessionId));
            const prepared = owning.readPreparedContext(target.sessionId);
            assert.equal(prepared?.room.id, owning.roomId);
            assert.equal(prepared?.triggerEntryId, entryId);
            assert.equal(observedEntry, entryId);
            assert.ok(observation);
            starts++;
            yield {
              type: 'session_status' as const,
              data: { sessionId: target.sessionId, model: 'test-mode' },
            };
            if (mode === 'runner-half-answer')
              yield { type: 'text_delta' as const, data: { text: 'the build is ' } };
            enteredProvider = true;
            entered();
            await held;
            yield { type: 'text_delta' as const, data: { text: 'green' } };
            yield { type: 'done' as const, data: { sessionId: target.sessionId } };
          } catch (cause) {
            remember(cause);
            rejectEntry(cause);
            throw cause;
          }
        };
      };
      let failed = false;
      let first: unknown;
      const remember = (cause: unknown): void => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      let idle: Promise<void> | undefined;
      try {
        const entry = owning.subsystem.service.post(owning.roomId, {
          authorId: owning.operator.id,
          text: 'is the build green?',
          mentions: [target.authorId],
        });
        entryId = entry.id;
        idle = owning.subsystem.service.triggersIdle();
        void idle.catch(remember);
        // Passive late completion may precede provider entry. It cannot stand
        // in for a producer failure or fabricate successful entry.
        const readiness = (async () => {
          for (let i = 0; i < 1000 && !enteredProvider; i++)
            await new Promise((resolve) => setTimeout(resolve, 1));
          assert.equal(
            enteredProvider,
            true,
            'Original acquired provider did not enter within its fixed readiness bound'
          );
        })();
        void readiness.catch(() => undefined);
        await Promise.race([entering, entryFailure, readiness]);
        assert.equal(starts, 1);
        assert.ok(observation);
        if (mode === 'runner-clamped-ceiling') {
          // Original twenty-times-the-short-ceiling control, on the actual native stream.
          await new Promise((resolve) => setTimeout(resolve, 20));
          release?.();
        }
        const outcome = await observation.completion;
        if (outcome.kind !== 'returned') throw outcome.cause;
        assert.equal(outcome.kind, 'returned');
        if (mode === 'runner-clamped-ceiling') {
          assert.equal(outcome.result.text, 'green');
          assert.equal(outcome.result.unanswered, undefined);
          assert.equal(outcome.result.late, undefined);
        } else {
          assert.equal(outcome.result.text, null);
          assert.equal(outcome.result.unanswered, undefined);
          assert.ok(outcome.result.late);
          if (mode === 'runner-unclosed-ceiling') {
            const late = await outcome.result.late;
            assert.equal(late.text, null);
            assert.equal(late.unanswered, 'failed');
            release?.();
          } else {
            let complete = false;
            void outcome.result.late.then(() => {
              complete = true;
            });
            await Promise.resolve();
            assert.equal(complete, false);
            release?.();
            const late = await outcome.result.late;
            assert.equal(late.text, mode === 'runner-half-answer' ? 'the build is green' : 'green');
            assert.equal(late.unanswered, undefined);
          }
        }
        await idle;
      } catch (cause) {
        remember(cause);
      } finally {
        release?.();
        let interrupted: Promise<unknown> | undefined;
        try {
          const attempt: Promise<unknown> = selected.interruptQuery(target.sessionId);
          interrupted = attempt;
          void attempt.catch(remember);
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
          scenarioStore.getScenario = originalRead;
        } catch (cause) {
          remember(cause);
        }
      }
      if (failed) throw first;
    },
  };
}
