/** Original captured runtime across a genuine first turn / pre-dispatch read. */
import assert from 'node:assert/strict';
import { agents, eq, sessionMetadata } from '@dorkos/db';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import { writeManifest } from '@dorkos/shared/manifest';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { CodexRuntime } from '../../../runtimes/codex/codex-runtime.js';
import { CodexThreadMap } from '../../../runtimes/codex/thread-map.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { interactionGate } from '../../../runtimes/test-mode/interaction-gate.js';
import { readTestModeOriginalActiveStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import type { OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

type Mode =
  | 'runner-first-captured-halt'
  | 'runner-preaccepted-halt'
  | 'runner-remembered-halt'
  | 'runner-boot-stop';
export function makeOriginalRunnerCapturedHaltControl(mode: Mode) {
  let releaseConventions: () => void = () => {};
  const conventions = new Promise<null>((resolve) => {
    releaseConventions = () => resolve(null);
  });
  let conventionsReached = false;
  let started = false;
  let retiring = false;
  let target: Awaited<ReturnType<OriginalNativeLaunchFixture['bootNativeAgent']>> | undefined;
  let observation: OriginalRoomRunnerObservation | undefined;
  let observedEntry: string | undefined;
  return {
    observeRun(entryId: string, current: OriginalRoomRunnerObservation) {
      observedEntry = entryId;
      observation = current;
    },
    roomConventions() {
      conventionsReached = true;
      return mode !== 'runner-first-captured-halt' ? conventions : Promise.resolve(null);
    },
    releaseProvider() {
      retiring = true;
      releaseConventions();
      if (target) interactionGate.step(target.sessionId);
    },
    async run(owning: OriginalNativeLaunchFixture) {
      target = await owning.bootNativeAgent();
      const actual = target;
      const selectedRuntime = runtimeRegistry.get('claude-code');
      // A real alternative constructor exists; it never acquires a producer.
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
          registeredBy: 'original-runner-capture-control',
        });
      await writeManifest(actual.agentPath, manifest('claude-code'));
      // Original subject is the unowned nonnull first-turn placeholder.
      owning.db
        .delete(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, actual.sessionId))
        .run();
      assert.equal(
        owning.subsystem.store.getRoomSession(owning.roomId, actual.authorId),
        actual.sessionId
      );
      const originalScenario = scenarioStore.getScenario;
      const originalInterrupt = selectedRuntime.interruptQuery;
      const originalGet = runtimeRegistry.get;
      const delivered: string[] = [];
      const deliveredIds: string[] = [];
      let queryingHalt = false;
      const haltGets: string[] = [];
      let failed = false;
      let first: unknown;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      let idle: Promise<void> | undefined;
      scenarioStore.getScenario = function (sessionId) {
        const previous = Reflect.apply(originalScenario, this, [sessionId]);
        if (sessionId !== actual.sessionId) return previous;
        return async function* (_content, context) {
          assert.ok(readTestModeOriginalActiveStream(selectedRuntime, actual.sessionId));
          assert.equal(context.sessionId, actual.sessionId);
          started = true;
          yield {
            type: 'session_status',
            data: { sessionId: actual.sessionId, model: 'test-mode' },
          };
          if (!retiring) await context.awaitStep(); // original abortable provider barrier
          yield { type: 'done', data: { sessionId: actual.sessionId } };
        };
      };
      selectedRuntime.interruptQuery = function (...args) {
        delivered.push('claude-code');
        deliveredIds.push(args[0]);
        return Reflect.apply(originalInterrupt, this, args);
      };
      runtimeRegistry.get = function (...args) {
        if (queryingHalt) haltGets.push(args[0]);
        return Reflect.apply(originalGet, this, args);
      };
      try {
        const entry = owning.subsystem.service.post(owning.roomId, {
          authorId: owning.operator.id,
          text: 'is the build green?',
          mentions: [actual.authorId],
        });
        idle = owning.subsystem.service.triggersIdle();
        void idle.catch(remember);
        for (
          let i = 0;
          i < 1000 && !(mode !== 'runner-first-captured-halt' ? conventionsReached : started);
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 1));
        assert.equal(observedEntry, entry.id);
        assert.ok(observation);
        assert.equal(mode !== 'runner-first-captured-halt' ? conventionsReached : started, true);
        if (mode !== 'runner-first-captured-halt') {
          assert.equal(started, false);
          assert.equal(
            readTestModeOriginalActiveStream(selectedRuntime, actual.sessionId),
            undefined
          );
        } else {
          assert.ok(readTestModeOriginalActiveStream(selectedRuntime, actual.sessionId));
        }
        if (mode !== 'runner-boot-stop') await writeManifest(actual.agentPath, manifest('codex'));
        queryingHalt = true;
        try {
          const receipt = await owning.runner.interrupt({
            sessionId: actual.sessionId,
            agentPath: actual.agentPath,
          });
          if (mode === 'runner-remembered-halt' || mode === 'runner-boot-stop')
            assert.equal(receipt.outcome, 'not-running');
        } finally {
          queryingHalt = false;
        }
        assert.deepEqual(delivered, ['claude-code']);
        assert.deepEqual(deliveredIds, [actual.sessionId]);
        // Native setup has additional legitimate registry reads. The halt
        // itself must use the captured object without a fresh registry lookup.
        assert.deepEqual(haltGets, []);
        releaseConventions();
        interactionGate.step(actual.sessionId);
        await idle;
        const completion = await observation.completion;
        if (completion.kind !== 'returned') throw completion.cause;
        assert.equal(completion.kind, 'returned');
        if (mode === 'runner-remembered-halt' || mode === 'runner-boot-stop') {
          assert.equal(started, true);
          assert.deepEqual(delivered, ['claude-code', 'claude-code']);
          assert.deepEqual(deliveredIds, [actual.sessionId, actual.sessionId]);
        }
      } catch (cause) {
        remember(cause);
      } finally {
        retiring = true;
        try {
          releaseConventions();
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
          const attempt: Promise<unknown> = Reflect.apply(originalInterrupt, selectedRuntime, [
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
          selectedRuntime.interruptQuery = originalInterrupt;
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
    },
  };
}
