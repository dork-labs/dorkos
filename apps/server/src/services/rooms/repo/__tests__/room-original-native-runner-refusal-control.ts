/** Genuine original Runner refusal before any provider starts. */
import assert from 'node:assert/strict';
import { eq, sessionMetadata } from '@dorkos/db';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { RoomTurnRuntimeGoneError } from '../../room-turn-port.js';
import type { OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import { readTestModeOriginalActiveStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

export async function runOriginalNativeRunnerRefusalControl(
  owning: OriginalNativeLaunchFixture,
  mode: 'runner-missing-runtime' | 'runner-no-fallback' | 'runner-missing-halt',
  readObserved: () => Readonly<{
    count: number;
    pending: boolean;
    entryId?: string;
    observation?: OriginalRoomRunnerObservation;
  }>
): Promise<void> {
  const target = await owning.bootNativeAgent();
  assert.equal(runtimeRegistry.has('claude-code'), true);
  assert.equal(runtimeRegistry.has('codex'), false);
  const actualRuntime = runtimeRegistry.get('claude-code');
  // Stored conversation DATA can name a runtime this installation did not boot.
  // No Codex runtime/principal is registered, and no native producer is minted.
  owning.db
    .update(sessionMetadata)
    .set({ runtime: 'codex' })
    .where(eq(sessionMetadata.sessionId, target.sessionId))
    .run();
  const originalInterrupt = actualRuntime.interruptQuery;
  let interrupts = 0;
  const originalPersist = runtimeRegistry.persistSessionRuntime;
  const originalGet = runtimeRegistry.get;
  let persistCalls = 0;
  let runGets = 0;
  runtimeRegistry.persistSessionRuntime = function (...args) {
    persistCalls++;
    return Reflect.apply(originalPersist, this, args);
  };
  runtimeRegistry.get = function (...args) {
    // The original Trigger may separately inspect the idle bound session.
    // Only calls made after actual constructor observation belong to this run.
    if (readObserved().pending) runGets++;
    return Reflect.apply(originalGet, this, args);
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
    if (mode === 'runner-missing-halt') {
      actualRuntime.interruptQuery = new Proxy(originalInterrupt, {
        apply(original, receiver, args) {
          interrupts++;
          return Reflect.apply(original, receiver, args);
        },
      });
      assert.deepEqual(
        await owning.runner.interrupt({
          sessionId: target.sessionId,
          agentPath: target.agentPath,
        }),
        { outcome: 'failed', reason: 'delivery-failed', runtime: 'codex' }
      );
      assert.equal(interrupts, 0);
      assert.equal(readTestModeOriginalActiveStream(actualRuntime, target.sessionId), undefined);
    } else {
      const entry = owning.subsystem.service.post(owning.roomId, {
        authorId: owning.operator.id,
        text: 'is the build green?',
        mentions: [target.authorId],
      });
      await owning.subsystem.service.triggersIdle();
      const captured = readObserved();
      assert.equal(captured.count, 1);
      assert.equal(captured.entryId, entry.id);
      assert.ok(captured.observation);
      assert.equal(Object.isFrozen(captured.observation), true);
      assert.equal(Object.hasOwn(captured.observation, 'request'), false);
      const outcome = await captured.observation.completion;
      assert.equal(outcome.kind, 'threw');
      if (outcome.kind !== 'threw') throw new Error('Original missing runtime did not refuse');
      if (mode === 'runner-missing-runtime') {
        assert.ok(outcome.cause instanceof RoomTurnRuntimeGoneError);
        assert.equal(outcome.cause.name, 'RoomTurnRuntimeGoneError');
        assert.equal(outcome.cause.runtime, 'codex');
        assert.equal(persistCalls, 0);
      } else {
        assert.ok(outcome.cause instanceof Error);
        assert.match(outcome.cause.message, /codex/);
        assert.equal(runGets, 0);
      }
      assert.equal(readTestModeOriginalActiveStream(actualRuntime, target.sessionId), undefined);
      assert.equal(
        owning.db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, target.sessionId))
          .get()?.runtime,
        'codex'
      );
    }
  } catch (cause) {
    remember(cause);
  } finally {
    try {
      actualRuntime.interruptQuery = originalInterrupt;
    } catch (cause) {
      remember(cause);
    }
    try {
      runtimeRegistry.persistSessionRuntime = originalPersist;
    } catch (cause) {
      remember(cause);
    }
    try {
      runtimeRegistry.get = originalGet;
    } catch (cause) {
      remember(cause);
    }
  }
  if (failed) throw first;
}
