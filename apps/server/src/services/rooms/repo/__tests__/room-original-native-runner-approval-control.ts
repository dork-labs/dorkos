/** Genuine approval streams plus durable Room notice observations; no projector injection. */
import assert from 'node:assert/strict';
import { runtimeRegistry, readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { interactionGate } from '../../../runtimes/test-mode/interaction-gate.js';
import { readTestModeOriginalActiveStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import type { OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

type Mode =
  | 'runner-approval-quick'
  | 'runner-approval-standing'
  | 'runner-approval-failed'
  | 'runner-approval-ended';
export function makeOriginalNativeApprovalControl() {
  let observation: OriginalRoomRunnerObservation | undefined;
  let observedEntry: string | undefined;
  let retiring = false;
  let release: (() => void) | undefined;
  return {
    observeRun(entryId: string, value: OriginalRoomRunnerObservation) {
      observedEntry = entryId;
      observation = value;
    },
    releaseProvider() {
      retiring = true;
      release?.();
    },
    async run(owning: OriginalNativeLaunchFixture, mode: Mode) {
      const target = await owning.bootNativeAgent();
      const selected = runtimeRegistry.get('claude-code');
      const raw = readOriginalRegisteredRuntime(selected);
      assert.ok(raw);
      const originalScenario = scenarioStore.getScenario;
      const originalInterrupt = selected.interruptQuery;
      const interactionId = 'original-owned-approval';
      let failed = false;
      let first: unknown;
      const remember = (cause: unknown): void => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      let entered = false;
      let entryId: string | undefined;
      let idle: Promise<void> | undefined;
      const notices = () =>
        owning.subsystem.store
          .listEntries(owning.roomId, { limit: 1000 })
          .filter((entry) => entry.body.subjectAuthorId === target.authorId);
      const waiting = () => notices().filter((entry) => entry.body.notice === 'awaiting_approval');
      release = () => {
        selected.approveTool(target.sessionId, interactionId, true);
      };
      scenarioStore.getScenario = function (sessionId) {
        const original = Reflect.apply(originalScenario, this, [sessionId]);
        if (sessionId !== target.sessionId) return original;
        return async function* (_content, context) {
          try {
            assert.equal(readOriginalRegisteredRuntime(runtimeRegistry.get('claude-code')), raw);
            assert.ok(readTestModeOriginalActiveStream(selected, target.sessionId));
            assert.equal(context.sessionId, target.sessionId);
            assert.equal(owning.readPreparedContext(target.sessionId)?.triggerEntryId, entryId);
            assert.equal(observedEntry, entryId);
            assert.ok(observation);
            yield {
              type: 'approval_required',
              data: {
                toolCallId: interactionId,
                toolName: 'Bash',
                input: '{}',
                startedAt: Date.now(),
                timeoutMs: 600_000,
                hasSuggestions: false,
                title: 'Original owned approval',
                displayName: 'Bash',
                description: 'Approve the original control',
              },
            };
            entered = true;
            if (mode !== 'runner-approval-ended' && !retiring)
              await context.awaitApproval(interactionId);
            if (mode === 'runner-approval-failed') {
              yield {
                type: 'session_status',
                data: { sessionId: target.sessionId, terminalReason: 'error' },
              };
              yield {
                type: 'error',
                data: {
                  message: 'Original approval turn failed',
                  code: 'original_approval_failure',
                  category: 'execution_error',
                },
              };
            } else yield { type: 'text_delta', data: { text: 'green' } };
            yield { type: 'done', data: { sessionId: target.sessionId } };
          } catch (cause) {
            remember(cause);
            throw cause;
          }
        };
      };
      try {
        const entry = owning.subsystem.service.post(owning.roomId, {
          authorId: owning.operator.id,
          text: 'is the build green?',
          mentions: [target.authorId],
        });
        entryId = entry.id;
        idle = owning.subsystem.service.triggersIdle();
        void idle.catch(remember);
        for (let i = 0; i < 1000 && !entered && !failed; i++)
          await new Promise((resolve) => setTimeout(resolve, 1));
        if (failed) throw first;
        assert.equal(entered, true);
        if (mode !== 'runner-approval-ended') {
          for (
            let i = 0;
            i < 1000 &&
            !interactionGate.pendingInteractionIds(target.sessionId).includes(interactionId);
            i++
          )
            await new Promise((resolve) => setTimeout(resolve, 1));
          assert.ok(
            interactionGate.pendingInteractionIds(target.sessionId).includes(interactionId)
          );
          if (mode === 'runner-approval-standing' || mode === 'runner-approval-failed') {
            for (let i = 0; i < 1000 && waiting().length === 0; i++)
              await new Promise((resolve) => setTimeout(resolve, 1));
            assert.equal(waiting().length, 1);
            assert.equal(waiting()[0].body.waitingKind, 'approval');
          } else assert.equal(waiting().length, 0);
          assert.equal(selected.approveTool(target.sessionId, interactionId, true), true);
        }
        await idle;
        assert.ok(observation);
        const completion = await observation.completion;
        if (completion.kind !== 'returned') throw completion.cause;
        assert.equal(completion.kind, 'returned');
        assert.equal(
          completion.result.unanswered,
          mode === 'runner-approval-failed' ? 'failed' : undefined
        );
        assert.equal(completion.result.text, mode === 'runner-approval-failed' ? null : 'green');
        const expectedWaits =
          mode === 'runner-approval-standing' || mode === 'runner-approval-failed' ? 1 : 0;
        assert.equal(waiting().length, expectedWaits);
        if (mode === 'runner-approval-failed') {
          const errors = notices().filter((entry) => entry.body.notice === 'turn_failed');
          assert.equal(errors.length, 1);
          assert.ok(waiting()[0].seq < errors[0].seq);
        }
        // A drained producer retains the real terminal projection: errors stay
        // visible, and an unanswered prompt remains blocked in session history.
        const expectedLifecycle =
          mode === 'runner-approval-failed'
            ? 'error'
            : mode === 'runner-approval-ended'
              ? 'blocked'
              : 'idle';
        let settled = false;
        for (let i = 0; i < 1000 && !settled; i++) {
          assert.equal(readOriginalRegisteredRuntime(runtimeRegistry.get('claude-code')), raw);
          settled =
            !isTurnInFlight(target.sessionId, selected) &&
            peekProjector(target.sessionId)?.getStatus().lifecycle === expectedLifecycle;
          if (!settled) await new Promise((resolve) => setTimeout(resolve, 1));
        }
        assert.equal(settled, true);
        const projector = peekProjector(target.sessionId);
        assert.ok(projector);
        assert.equal(projector.getStatus().lifecycle, expectedLifecycle);
        if (mode === 'runner-approval-failed') {
          assert.equal(projector.getStatus().lastError?.code, 'original_approval_failure');
        }
        if (mode === 'runner-approval-ended') {
          assert.deepEqual(
            projector.getPendingInteractions().map((pending) => [pending.type, pending.id]),
            [['approval', interactionId]]
          );
        }
        assert.equal(waiting().length, expectedWaits);
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
      }
      if (failed) throw first;
    },
  };
}
