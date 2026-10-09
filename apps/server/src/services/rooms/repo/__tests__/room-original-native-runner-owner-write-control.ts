/** Required native admission versus best-effort final attribution, on real turns. */
import assert from 'node:assert/strict';
import { runtimeRegistry, readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { readTestModeOriginalActiveStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import type { OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

export function makeOriginalRunnerOwnerWriteControl() {
  let observation: OriginalRoomRunnerObservation | undefined;
  let observedEntry: string | undefined;
  const readObserved = (): OriginalRoomRunnerObservation | undefined => observation;
  return {
    observeRun(entryId: string, current: OriginalRoomRunnerObservation) {
      observedEntry = entryId;
      observation = current;
    },
    async run(owning: OriginalNativeLaunchFixture) {
      const originalPersist = runtimeRegistry.persistSessionRuntime;
      const originalScenario = scenarioStore.getScenario;
      let failed = false;
      let first: unknown;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      let idle: Promise<void> | undefined;
      try {
        const targets = await owning.bootNativePair();
        assert.equal(targets.length, 2);
        for (const [index, stage] of (['required', 'late'] as const).entries()) {
          const target = targets[index];
          assert.ok(target);
          const selected = runtimeRegistry.get('claude-code');
          const originalRuntime = readOriginalRegisteredRuntime(selected);
          assert.ok(originalRuntime);
          const cause = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
          const attempts: Array<Parameters<typeof originalPersist>> = [];
          let providerStarts = 0;
          let spoken = false;
          let injected = false;
          observation = undefined;
          observedEntry = undefined;
          scenarioStore.getScenario = function (sessionId) {
            const previous = Reflect.apply(originalScenario, this, [sessionId]);
            if (sessionId !== target.sessionId) return previous;
            return async function* (_content, context) {
              assert.ok(readTestModeOriginalActiveStream(selected, target.sessionId));
              assert.equal(context.sessionId, target.sessionId);
              providerStarts++;
              spoken = true;
              yield { type: 'text_delta', data: { text: 'Green — nothing failed.' } };
              yield { type: 'done', data: { sessionId: target.sessionId } };
            };
          };
          runtimeRegistry.persistSessionRuntime = async function (...args) {
            if (args[0] === target.sessionId) {
              attempts.push(args);
              if (
                (stage === 'required' && attempts.length === 1) ||
                (stage === 'late' && attempts.length === 2)
              ) {
                injected = true;
                throw cause;
              }
            }
            return Reflect.apply(originalPersist, this, args);
          };
          const entry = owning.subsystem.service.post(owning.roomId, {
            authorId: owning.operator.id,
            text: 'is the build green?',
            mentions: [target.authorId],
          });
          idle = owning.subsystem.service.triggersIdle();
          void idle.catch(remember);
          await idle;
          assert.equal(observedEntry, entry.id);
          const observed = readObserved();
          assert.ok(observed);
          const completion = await observed.completion;
          assert.equal(injected, true);
          if (stage === 'required') {
            assert.equal(attempts.length, 1);
            assert.equal(providerStarts, 0);
            assert.equal(spoken, false);
            assert.equal(readTestModeOriginalActiveStream(selected, target.sessionId), undefined);
            assert.equal(completion.kind, 'threw');
            if (completion.kind !== 'threw')
              throw new Error('Required owner failure did not fail closed');
            assert.equal(completion.cause, cause);
            assert.equal(
              peekProjector(target.sessionId)
                ?.replayFrom(0)
                .some((event) => event.type === 'text_delta'),
              false
            );
          } else {
            assert.equal(attempts.length, 2);
            assert.equal(providerStarts, 1);
            assert.equal(spoken, true);
            if (completion.kind !== 'returned') throw completion.cause;
            assert.equal(completion.kind, 'returned');
            assert.equal(completion.result.text, 'Green — nothing failed.');
            assert.equal(completion.result.unanswered, undefined);
            for (const args of attempts) {
              assert.equal(args[0], target.sessionId);
              assert.equal(args[1], 'claude-code');
              assert.deepEqual(args[2], { kind: 'room', externalAuthor: false });
              assert.equal(args[3], target.agentPath);
            }
          }
          let settled = false;
          for (let i = 0; i < 1000 && !settled; i++) {
            assert.equal(
              readOriginalRegisteredRuntime(runtimeRegistry.get('claude-code')),
              originalRuntime
            );
            settled =
              !isTurnInFlight(target.sessionId, selected) &&
              (stage === 'required' ||
                peekProjector(target.sessionId)?.getStatus().lifecycle === 'idle');
            if (!settled) await new Promise((resolve) => setTimeout(resolve, 1));
          }
          assert.equal(settled, true);
          runtimeRegistry.persistSessionRuntime = originalPersist;
          scenarioStore.getScenario = originalScenario;
        }
      } catch (cause) {
        remember(cause);
      } finally {
        // Stop every actual native/file/checkbox/due owner before joining a
        // pending trigger; the shared owner still positively closes Db/root.
        let stopped: Promise<unknown> | undefined;
        try {
          const attempt = owning.stopNative();
          stopped = attempt;
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
        if (stopped) {
          try {
            await stopped;
          } catch (cause) {
            remember(cause);
          }
        }
        try {
          runtimeRegistry.persistSessionRuntime = originalPersist;
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
