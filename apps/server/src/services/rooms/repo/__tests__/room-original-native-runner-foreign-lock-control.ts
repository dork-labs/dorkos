/** Real foreign runtime lock, genuine original Room Trigger, no producer starts. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { readTestModeOriginalActiveStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import type { OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

export async function runOriginalNativeRunnerForeignLockControl(
  owning: OriginalNativeLaunchFixture,
  readObserved: () => OriginalRoomRunnerObservation | undefined
): Promise<void> {
  const target = await owning.bootNativeAgent();
  const runtime = runtimeRegistry.get('claude-code');
  const holder = new EventEmitter();
  const holderId = 'original-runner-foreign-operator';
  const token = Symbol('original-runner-foreign-operator');
  let acquired = false;
  let failed = false;
  let first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    assert.equal(isTurnInFlight(target.sessionId, runtime), false);
    assert.equal(readTestModeOriginalActiveStream(runtime, target.sessionId), undefined);
    acquired = runtime.acquireLock(target.sessionId, holderId, holder, token);
    assert.equal(acquired, true);
    assert.equal(runtime.isLocked(target.sessionId), true);
    assert.equal(isTurnInFlight(target.sessionId, runtime), true);
    assert.equal(readTestModeOriginalActiveStream(runtime, target.sessionId), undefined);
    owning.subsystem.service.post(owning.roomId, {
      authorId: owning.operator.id,
      text: 'is the build green?',
      mentions: [target.authorId],
    });
    await owning.subsystem.service.triggersIdle();
    const observation = readObserved();
    assert.ok(observation);
    assert.ok(observation.computedDefaults);
    assert.equal(Object.isFrozen(observation.computedDefaults), true);
    assert.equal(observation.computedDefaults.whenBusy, 'refuse-foreign');
    assert.equal(Object.hasOwn(observation.computedDefaults, 'request'), false);
    assert.equal(Object.hasOwn(observation.computedDefaults, 'opts'), false);
    const result = await observation.completion;
    if (result.kind !== 'returned') throw result.cause;
    assert.equal(result.kind, 'returned');
    assert.equal(result.result.text, null);
    assert.equal(result.result.unanswered, 'busy');
    assert.equal(runtime.isLocked(target.sessionId), true);
    assert.equal(runtime.getLockInfo(target.sessionId)?.clientId, holderId);
    assert.equal(readTestModeOriginalActiveStream(runtime, target.sessionId), undefined);
  } catch (cause) {
    remember(cause);
  } finally {
    if (acquired) {
      try {
        runtime.releaseLock(target.sessionId, holderId, token);
      } catch (cause) {
        remember(cause);
      }
    }
  }
  if (failed) throw first;
}
