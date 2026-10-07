/** Real acquired provider streams, with supported TestMode receipt DATA only. */
import assert from 'node:assert/strict';
import { runtimeRegistry, readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import { interactionGate } from '../../../runtimes/test-mode/interaction-gate.js';
import {
  scenarioStore,
  declareInterruptOutcome,
  declaredInterruptOutcome,
} from '../../../runtimes/test-mode/scenario-store.js';
import { readTestModeOriginalActiveStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import type { OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

type Mode = 'runner-confirmed-stop' | 'runner-unconfirmed-stop';
export function makeOriginalRunnerStopReceiptControl() {
  let target: Awaited<ReturnType<OriginalNativeLaunchFixture['bootNativeAgent']>> | undefined;
  let observation: OriginalRoomRunnerObservation | undefined;
  let observedEntry: string | undefined;
  let retiring = false;
  return {
    observeRun(entryId: string, current: OriginalRoomRunnerObservation) {
      observedEntry = entryId;
      observation = current;
    },
    releaseProvider() {
      retiring = true;
      declareInterruptOutcome(undefined);
      if (target) interactionGate.step(target.sessionId);
    },
    async run(owning: OriginalNativeLaunchFixture, mode: Mode) {
      target = await owning.bootNativeAgent();
      const actual = target;
      const selected = runtimeRegistry.get('claude-code');
      const originalRuntime = readOriginalRegisteredRuntime(selected);
      assert.ok(originalRuntime);
      const originalScenario = scenarioStore.getScenario;
      const originalInterrupt = selected.interruptQuery;
      const previousOutcome = declaredInterruptOutcome();
      const delivered: string[] = [];
      let held = false;
      let providerEntered: boolean;
      let idle: Promise<void> | undefined;
      let failed = false;
      let first: unknown;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      scenarioStore.getScenario = function (sessionId) {
        const original = Reflect.apply(originalScenario, this, [sessionId]);
        if (sessionId !== actual.sessionId) return original;
        return async function* (_content, context) {
          assert.ok(readTestModeOriginalActiveStream(selected, actual.sessionId));
          assert.equal(context.sessionId, actual.sessionId);
          providerEntered = true;
          if (held && !retiring) await context.awaitStep();
          yield { type: 'text_delta', data: { text: 'green' } };
          yield { type: 'done', data: { sessionId: actual.sessionId } };
        };
      };
      selected.interruptQuery = function (...args) {
        delivered.push(args[0]);
        return Reflect.apply(originalInterrupt, this, args);
      };
      const settle = async (expectedLifecycle: 'idle' | 'interrupted' = 'idle') => {
        let settled = false;
        for (let i = 0; i < 1000 && !settled; i++) {
          assert.equal(
            readOriginalRegisteredRuntime(runtimeRegistry.get('claude-code')),
            originalRuntime
          );
          settled =
            !isTurnInFlight(actual.sessionId, selected) &&
            peekProjector(actual.sessionId)?.getStatus().lifecycle === expectedLifecycle;
          if (!settled) await new Promise((resolve) => setTimeout(resolve, 1));
        }
        assert.equal(settled, true);
      };
      const post = (text: string) =>
        owning.subsystem.service.post(owning.roomId, {
          authorId: owning.operator.id,
          text,
          mentions: [actual.authorId],
        });
      try {
        const outcomes =
          mode === 'runner-confirmed-stop'
            ? (['acked'] as const)
            : (['unconfirmed', 'failed'] as const);
        for (const outcome of outcomes) {
          const before = delivered.length;
          const beforeCursor = peekProjector(actual.sessionId)?.getCursor() ?? 0;
          providerEntered = false;
          held = true;
          declareInterruptOutcome(outcome);
          const entry = post('@native original stop receipt ' + outcome);
          idle = owning.subsystem.service.triggersIdle();
          void idle.catch(remember);
          for (let i = 0; i < 1000 && !providerEntered; i++)
            await new Promise((resolve) => setTimeout(resolve, 1));
          assert.equal(providerEntered, true);
          assert.ok(readTestModeOriginalActiveStream(selected, actual.sessionId));
          assert.equal(observedEntry, entry.id);
          assert.ok(observation);
          const receipt = await owning.runner.interrupt({
            sessionId: actual.sessionId,
            agentPath: actual.agentPath,
          });
          assert.equal(receipt.outcome, outcome);
          assert.deepEqual(delivered.slice(before), [actual.sessionId]);
          if (outcome !== 'acked') {
            // Refusal leaves the genuine producer held; the first provider event
            // must not re-aim a receipt saying the turn was already running.
            assert.ok(readTestModeOriginalActiveStream(selected, actual.sessionId));
            assert.equal(interactionGate.step(actual.sessionId), true);
          }
          await idle;
          // Confirmed cancellation delivers only the original stop-terminal DATA,
          // which the projector closes as interrupted, not a runtime failure.
          await settle(outcome === 'acked' ? 'interrupted' : 'idle');
          if (outcome === 'acked') {
            const projector = peekProjector(actual.sessionId);
            assert.ok(projector);
            const events = projector.replayFrom(beforeCursor);
            const ends = events.filter((event) => event.type === 'turn_end');
            assert.equal(ends.length, 1);
            assert.equal(ends[0]!.terminalReason, 'aborted_streaming');
            assert.equal(events.filter((event) => event.type === 'error').length, 0);
            assert.equal(projector.getStatus().lastError, null);
          }
          const completion = await observation.completion;
          if (completion.kind !== 'returned') throw completion.cause;
          assert.equal(completion.kind, 'returned');
          if (outcome !== 'acked') {
            assert.equal(completion.result.text, 'green');
            assert.equal(completion.result.unanswered, undefined);
          }
          assert.deepEqual(delivered.slice(before), [actual.sessionId]);
          declareInterruptOutcome(undefined);
        }
        if (mode === 'runner-confirmed-stop') {
          // An actual successor turn produces after a confirmed stop; there
          // must be no remembered halt inherited by this new acquired stream.
          const before = delivered.length;
          held = false;
          providerEntered = false;
          const entry = post('@native original successor after confirmed stop');
          idle = owning.subsystem.service.triggersIdle();
          void idle.catch(remember);
          await idle;
          await settle();
          assert.equal(providerEntered, true);
          assert.equal(observedEntry, entry.id);
          assert.ok(observation);
          const completion = await observation.completion;
          if (completion.kind !== 'returned') throw completion.cause;
          assert.equal(completion.kind, 'returned');
          assert.equal(completion.result.text, 'green');
          assert.equal(completion.result.unanswered, undefined);
          assert.equal(delivered.length, before);
        }
      } catch (cause) {
        remember(cause);
      } finally {
        retiring = true;
        try {
          declareInterruptOutcome(undefined);
        } catch (cause) {
          remember(cause);
        }
        try {
          interactionGate.step(actual.sessionId);
        } catch (cause) {
          remember(cause);
        }
        let interrupted: Promise<unknown> | undefined;
        try {
          const attempt: Promise<unknown> = Reflect.apply(originalInterrupt, selected, [
            actual.sessionId,
          ]);
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
          scenarioStore.getScenario = originalScenario;
        } catch (cause) {
          remember(cause);
        }
        try {
          selected.interruptQuery = originalInterrupt;
        } catch (cause) {
          remember(cause);
        }
        try {
          declareInterruptOutcome(previousOutcome);
        } catch (cause) {
          remember(cause);
        }
      }
      if (failed) throw first;
    },
  };
}
