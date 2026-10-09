/** Real required-owner writes followed by genuine pre-launch roster revocation. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { and, eq, roomMembers, roomSessions, sessionMetadata } from '@dorkos/db';
import { runtimeRegistry, readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { readTestModeOriginalActiveStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import type { OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

export function makeOriginalNativeNoBindingControl() {
  let observation: OriginalRoomRunnerObservation | undefined;
  const readObserved = (): OriginalRoomRunnerObservation | undefined => observation;
  let observedEntry: string | undefined;
  let beforeLaunch: ((data: Readonly<{ sessionId: string; roomId: string }>) => void) | undefined;
  return {
    observeRun(entryId: string, current: OriginalRoomRunnerObservation) {
      observedEntry = entryId;
      observation = current;
    },
    observeOriginalLaunch(data: Readonly<{ sessionId: string; roomId: string }>) {
      beforeLaunch?.(data);
    },
    async run(owning: OriginalNativeLaunchFixture) {
      const originalPersist = runtimeRegistry.persistSessionRuntime;
      const originalForget = runtimeRegistry.forgetUnstartedSession;
      let failed = false;
      let first: unknown;
      const remember = (cause: unknown): void => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      let idle: Promise<void> | undefined;
      const restoreRoster: Array<() => void> = [];
      const writes: Array<Parameters<typeof originalPersist>> = [];
      const forgotten: string[] = [];
      try {
        runtimeRegistry.persistSessionRuntime = async function (...args) {
          const result = await Reflect.apply(originalPersist, this, args);
          writes.push(args);
          return result;
        };
        runtimeRegistry.forgetUnstartedSession = async function (...args) {
          forgotten.push(args[0]);
          return Reflect.apply(originalForget, this, args);
        };
        const targets = await owning.bootNativePair();
        assert.equal(targets.length, 2);
        const selected = runtimeRegistry.get('claude-code');
        const raw = readOriginalRegisteredRuntime(selected);
        assert.ok(raw);
        const refusedTarget = targets[0];
        assert.ok(refusedTarget);
        const refusedBefore = owning.db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, refusedTarget.sessionId))
          .get();
        assert.ok(refusedBefore);
        const holderId = 'original-no-binding-foreign-operator';
        const holder = new EventEmitter();
        const token = Symbol(holderId);
        let acquired = false;
        writes.length = 0;
        forgotten.length = 0;
        observation = undefined;
        observedEntry = undefined;
        try {
          acquired = selected.acquireLock(refusedTarget.sessionId, holderId, holder, token);
          assert.equal(acquired, true);
          const entry = owning.subsystem.service.post(owning.roomId, {
            authorId: owning.operator.id,
            text: 'is the build green?',
            mentions: [refusedTarget.authorId],
          });
          idle = owning.subsystem.service.triggersIdle();
          void idle.catch(remember);
          await idle;
          assert.equal(observedEntry, entry.id);
          const current = readObserved();
          assert.ok(current);
          const result = await current.completion;
          if (result.kind !== 'returned') throw result.cause;
          assert.equal(result.kind, 'returned');
          assert.equal(result.result.text, null);
          assert.equal(result.result.unanswered, 'busy');
          assert.deepEqual(writes, []);
          assert.deepEqual(forgotten, []);
          assert.equal(
            readTestModeOriginalActiveStream(selected, refusedTarget.sessionId),
            undefined
          );
          assert.equal(selected.getLockInfo(refusedTarget.sessionId)?.clientId, holderId);
          assert.deepEqual(
            owning.db
              .select()
              .from(sessionMetadata)
              .where(eq(sessionMetadata.sessionId, refusedTarget.sessionId))
              .get(),
            refusedBefore
          );
        } catch (cause) {
          remember(cause);
        } finally {
          if (acquired) {
            try {
              selected.releaseLock(refusedTarget.sessionId, holderId, token);
            } catch (cause) {
              remember(cause);
            }
          }
        }
        if (failed) throw first;
        for (const [index, mode] of (['fresh', 'bound'] as const).entries()) {
          const target = targets[index];
          assert.ok(target);
          const member = owning.db
            .select()
            .from(roomMembers)
            .where(
              and(eq(roomMembers.roomId, owning.roomId), eq(roomMembers.authorId, target.authorId))
            )
            .get();
          assert.ok(member);
          if (mode === 'fresh') {
            owning.db
              .delete(roomSessions)
              .where(
                and(
                  eq(roomSessions.roomId, owning.roomId),
                  eq(roomSessions.authorId, target.authorId)
                )
              )
              .run();
            owning.db
              .delete(sessionMetadata)
              .where(eq(sessionMetadata.sessionId, target.sessionId))
              .run();
            assert.equal(
              owning.subsystem.store.getRoomSession(owning.roomId, target.authorId),
              null
            );
          } else {
            assert.equal(
              owning.subsystem.store.getRoomSession(owning.roomId, target.authorId),
              target.sessionId
            );
          }
          const existing = owning.db
            .select()
            .from(sessionMetadata)
            .where(eq(sessionMetadata.sessionId, target.sessionId))
            .get();
          if (mode === 'bound') assert.ok(existing);
          writes.length = 0;
          forgotten.length = 0;
          observation = undefined;
          observedEntry = undefined;
          let launchId: string | undefined;
          let requiredOwnerRow: typeof existing;
          const readRequiredOwnerRow = (): typeof existing => requiredOwnerRow;
          let revoked = false;
          const restore = () => {
            const current = owning.db
              .select()
              .from(roomMembers)
              .where(
                and(
                  eq(roomMembers.roomId, owning.roomId),
                  eq(roomMembers.authorId, target.authorId)
                )
              )
              .get();
            if (!current) owning.db.insert(roomMembers).values(member).run();
          };
          restoreRoster.push(restore);
          beforeLaunch = (data) => {
            try {
              assert.equal(data.roomId, owning.roomId);
              assert.equal(writes.length, 1);
              assert.equal(writes[0][0], data.sessionId);
              assert.equal(writes[0][3], target.agentPath);
              const actual = owning.db
                .select()
                .from(sessionMetadata)
                .where(eq(sessionMetadata.sessionId, data.sessionId))
                .get();
              assert.ok(actual);
              assert.equal(actual.runtime, 'claude-code');
              assert.equal(actual.agentPath, target.agentPath);
              launchId = data.sessionId;
              requiredOwnerRow = actual;
              assert.equal(
                owning.subsystem.store.getRoomSession(owning.roomId, target.authorId),
                data.sessionId
              );
              owning.db
                .delete(roomMembers)
                .where(
                  and(
                    eq(roomMembers.roomId, owning.roomId),
                    eq(roomMembers.authorId, target.authorId)
                  )
                )
                .run();
              revoked = true;
            } catch (cause) {
              remember(cause);
            }
          };
          const entry = owning.subsystem.service.post(owning.roomId, {
            authorId: owning.operator.id,
            text: 'is the build green?',
            mentions: [target.authorId],
          });
          idle = owning.subsystem.service.triggersIdle();
          void idle.catch(remember);
          await idle;
          if (failed) throw first;
          assert.equal(observedEntry, entry.id);
          const current = readObserved();
          assert.ok(current);
          const completion = await current.completion;
          assert.equal(revoked, true);
          assert.ok(launchId);
          assert.equal(completion.kind, 'threw');
          if (completion.kind !== 'threw')
            throw new Error('Revoked native launch did not fail closed');
          assert.ok(completion.cause instanceof Error);
          assert.equal(
            completion.cause.message,
            'Room launch original request/member/session/source changed or retired.'
          );
          assert.equal(readTestModeOriginalActiveStream(selected, launchId), undefined);
          assert.equal(isTurnInFlight(launchId, selected), false);
          assert.equal(readOriginalRegisteredRuntime(runtimeRegistry.get('claude-code')), raw);
          if (mode === 'fresh') {
            assert.notEqual(launchId, target.sessionId);
            // The real Trigger binds this fresh placeholder before claiming it.
            // It is a conversation id, not the Runner's unbound minted-id case.
            assert.deepEqual(forgotten, []);
            assert.equal(
              owning.subsystem.store.getRoomSession(owning.roomId, target.authorId),
              launchId
            );
            const retainedOwnerRow = readRequiredOwnerRow();
            assert.ok(retainedOwnerRow);
            assert.deepEqual(
              owning.db
                .select()
                .from(sessionMetadata)
                .where(eq(sessionMetadata.sessionId, launchId))
                .get(),
              retainedOwnerRow
            );
          } else {
            assert.equal(launchId, target.sessionId);
            assert.deepEqual(forgotten, []);
            assert.deepEqual(
              owning.db
                .select()
                .from(sessionMetadata)
                .where(eq(sessionMetadata.sessionId, target.sessionId))
                .get(),
              existing
            );
          }
          beforeLaunch = undefined;
          restore();
          restoreRoster.pop();
        }
      } catch (cause) {
        remember(cause);
      } finally {
        beforeLaunch = undefined;
        for (const restore of restoreRoster) {
          try {
            restore();
          } catch (cause) {
            remember(cause);
          }
        }
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
          runtimeRegistry.forgetUnstartedSession = originalForget;
        } catch (cause) {
          remember(cause);
        }
      }
      if (failed) throw first;
    },
  };
}
