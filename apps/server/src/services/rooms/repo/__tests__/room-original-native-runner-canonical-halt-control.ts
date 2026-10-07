/** Canonical halt through the actual native rekey, never a caller-supplied binding. */
import assert from 'node:assert/strict';
import { agents, eq, sessionMetadata } from '@dorkos/db';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import { writeManifest } from '@dorkos/shared/manifest';
import { runtimeRegistry, readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { CodexRuntime } from '../../../runtimes/codex/codex-runtime.js';
import { CodexThreadMap } from '../../../runtimes/codex/thread-map.js';
import { interactionGate } from '../../../runtimes/test-mode/interaction-gate.js';
import { readTestModeOriginalActiveStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import type { OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

export function makeOriginalRunnerCanonicalHaltControl() {
  let target: Awaited<ReturnType<OriginalNativeLaunchFixture['bootNativeAgent']>> | undefined;
  let observation: OriginalRoomRunnerObservation | undefined;
  let observedEntry: string | undefined;
  return {
    observeRun(entryId: string, current: OriginalRoomRunnerObservation) {
      observedEntry = entryId;
      observation = current;
    },
    releaseProvider() {
      if (target) interactionGate.step(target.sessionId);
    },
    async run(
      owning: OriginalNativeLaunchFixture,
      mode: 'runner-canonical-halt' | 'runner-canonical-owner' = 'runner-canonical-halt'
    ) {
      target = await owning.bootNativeAgent();
      const actual = target;
      const selected = runtimeRegistry.get('claude-code');
      const originalRuntime = readOriginalRegisteredRuntime(selected);
      assert.ok(originalRuntime);
      runtimeRegistry.register(
        new CodexRuntime({
          threadMap: new CodexThreadMap(owning.db),
          defaultCwd: actual.agentPath,
          transport: 'exec',
          resolveBinary: async () => process.execPath,
          modelCatalog: { getSupportedModels: async () => [] },
        })
      );
      const agent = owning.db
        .select()
        .from(agents)
        .where(eq(agents.projectPath, actual.agentPath))
        .get();
      assert.ok(agent);
      const manifest = (runtime: 'claude-code' | 'codex') =>
        AgentManifestSchema.parse({
          id: agent.id,
          name: 'native-agent',
          runtime,
          registeredAt: agent.registeredAt,
          registeredBy: 'original-runner-canonical-halt-control',
        });
      const post = (text: string) =>
        owning.subsystem.service.post(owning.roomId, {
          authorId: owning.operator.id,
          text,
          mentions: [actual.authorId],
        });
      let failed = false;
      let first: unknown;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      const originalInterrupt = selected.interruptQuery;
      const originalGet = runtimeRegistry.get;
      const originalPersist = runtimeRegistry.persistSessionRuntime;
      const writes: Array<Parameters<typeof originalPersist>> = [];
      const delivered: string[] = [];
      const deliveredIds: string[] = [];
      const haltGets: string[] = [];
      let queryingHalt = false;
      let idle: Promise<void> | undefined;
      selected.interruptQuery = function (...args) {
        delivered.push('claude-code');
        deliveredIds.push(args[0]);
        return Reflect.apply(originalInterrupt, this, args);
      };
      runtimeRegistry.get = function (...args) {
        if (queryingHalt) haltGets.push(args[0]);
        return Reflect.apply(originalGet, this, args);
      };
      if (mode === 'runner-canonical-owner') {
        runtimeRegistry.persistSessionRuntime = function (...args) {
          if (args[3] === actual.agentPath) writes.push(args);
          return Reflect.apply(originalPersist, this, args);
        };
      }
      try {
        await writeManifest(actual.agentPath, manifest('claude-code'));
        post('@native establish ordinary conversation');
        await owning.subsystem.service.triggersIdle();
        let settled = false;
        for (let i = 0; i < 1000 && !settled; i++) {
          assert.equal(
            readOriginalRegisteredRuntime(runtimeRegistry.get('claude-code')),
            originalRuntime
          );
          settled =
            !isTurnInFlight(actual.sessionId, selected) &&
            peekProjector(actual.sessionId)?.getStatus().lifecycle === 'idle';
          if (!settled) await new Promise((resolve) => setTimeout(resolve, 1));
        }
        assert.equal(settled, true);
        writes.length = 0;
        owning.holdCanonicalSession(actual.sessionId);
        const entry = post('@native establish canonical halt target');
        idle = owning.subsystem.service.triggersIdle();
        void idle.catch(remember);
        let released = false;
        for (let i = 0; i < 1000 && !released; i++) {
          released = owning.stepCanonicalSession(actual.sessionId);
          if (!released) await new Promise((resolve) => setTimeout(resolve, 1));
        }
        assert.equal(released, true);
        for (let i = 0; i < 1000 && !owning.readCanonicalSession(actual.sessionId); i++)
          await new Promise((resolve) => setTimeout(resolve, 1));
        const canonical = owning.readCanonicalSession(actual.sessionId);
        assert.ok(canonical && canonical !== actual.sessionId);
        assert.equal(
          owning.subsystem.store.getRoomSession(owning.roomId, actual.authorId),
          canonical
        );
        assert.ok(
          owning.subsystem.store.sessionLedger.retiredIdsFor(canonical).includes(actual.sessionId)
        );
        assert.ok(readTestModeOriginalActiveStream(selected, actual.sessionId));
        assert.equal(observedEntry, entry.id);
        assert.ok(observation);
        if (mode === 'runner-canonical-halt') {
          await writeManifest(actual.agentPath, manifest('codex'));
          queryingHalt = true;
          try {
            await owning.runner.interrupt({ sessionId: canonical, agentPath: actual.agentPath });
          } finally {
            queryingHalt = false;
          }
          assert.deepEqual(delivered, ['claude-code']);
          assert.deepEqual(deliveredIds, [canonical]);
          assert.deepEqual(haltGets, []);
        }
        // Halt may retire the original producer; otherwise release its real second barrier.
        if (readTestModeOriginalActiveStream(selected, actual.sessionId))
          await owning.finishCanonicalSession(actual.sessionId);
        await idle;
        const completion = await observation.completion;
        if (completion.kind !== 'returned') throw completion.cause;
        assert.equal(completion.kind, 'returned');
        if (mode === 'runner-canonical-owner') {
          assert.equal(completion.result.sessionId, canonical);
          assert.equal(
            owning.subsystem.store.getRoomSession(owning.roomId, actual.authorId),
            canonical
          );
          const row = owning.db
            .select()
            .from(sessionMetadata)
            .where(eq(sessionMetadata.sessionId, canonical))
            .get();
          assert.ok(row);
          assert.equal(row.runtime, 'claude-code');
          assert.equal(row.agentPath, actual.agentPath);
          assert.equal(writes.length, 2);
          assert.deepEqual(writes[1], [
            canonical,
            'claude-code',
            { kind: 'room', externalAuthor: false },
            actual.agentPath,
          ]);
          assert.equal(writes[1]?.[0], completion.result.sessionId);
        }
      } catch (cause) {
        remember(cause);
      } finally {
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
          selected.interruptQuery = originalInterrupt;
        } catch (cause) {
          remember(cause);
        }
        try {
          runtimeRegistry.get = originalGet;
        } catch (cause) {
          remember(cause);
        }
        try {
          runtimeRegistry.persistSessionRuntime = originalPersist;
        } catch (cause) {
          remember(cause);
        }
      }
      if (failed) throw first;
    },
  };
}
