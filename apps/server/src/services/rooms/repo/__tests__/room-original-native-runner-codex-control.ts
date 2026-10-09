/** Genuine Codex constructor, scripted supported transport DATA, actual Room request. */
import assert from 'node:assert/strict';
import { agents, and, eq, roomSessions, sessionMetadata, type Db } from '@dorkos/db';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import { writeManifest } from '@dorkos/shared/manifest';
import { runtimeRegistry, readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { CodexRuntime } from '../../../runtimes/codex/codex-runtime.js';
import { CodexThreadMap } from '../../../runtimes/codex/thread-map.js';
import type { CodexTransport } from '../../../runtimes/codex/transport/codex-transport.js';
import { TestModeRuntime } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import { uiTurnFacts } from '../../../session/browser-seat/ui-turn-facts.js';
import type { OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

type Mode =
  | 'runner-bound-codex'
  | 'runner-first-codex'
  | 'runner-owner-before-provider'
  | 'runner-placeholder-codex'
  | 'runner-bound-halt'
  | 'runner-released-halt'
  | 'runner-new-then-reused';
type FixtureOptions = NonNullable<
  Parameters<
    (typeof import('./room-original-native-launch-fixture.js'))['createOriginalNativeLaunchFixture']
  >[0]
>;
type Construction = Parameters<NonNullable<FixtureOptions['createNativeRuntime']>>[0];

export function makeOriginalRunnerCodexControl() {
  let owning: OriginalNativeLaunchFixture | undefined;
  let target: Readonly<{ agentPath: string; sessionId: string; authorId: string }> | undefined;
  let db: Db | undefined;
  let entryId: string | undefined;
  let actualSessionId: string | undefined;
  let observedEntryId: string | undefined;
  let observation: OriginalRoomRunnerObservation | undefined;
  let starts = 0;
  let boundWhenStarted = false;
  let mode: Mode | undefined;
  let runtime: CodexRuntime | undefined;
  const transport: CodexTransport = {
    kind: 'exec',
    capabilities: {},
    async *runTurn(input) {
      assert.ok(owning);
      assert.ok(target);
      assert.ok(db);
      assert.ok(runtime);
      assert.ok(actualSessionId);
      assert.equal(input.sessionId, actualSessionId);
      if (
        mode === 'runner-first-codex' ||
        mode === 'runner-owner-before-provider' ||
        mode === 'runner-new-then-reused'
      )
        assert.notEqual(input.sessionId, target.sessionId);
      assert.equal(input.cwd, target.agentPath);
      assert.equal(input.signal.aborted, false);
      assert.equal(uiTurnFacts.read(input.sessionId).roomTurn?.roomId, owning.roomId);
      assert.equal(observedEntryId, entryId);
      assert.ok(observation);
      const current = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, input.sessionId))
        .get();
      boundWhenStarted = current?.runtime === 'codex' && current.agentPath === target.agentPath;
      assert.equal(boundWhenStarted, true);
      starts++;
      yield {
        type: 'session_status',
        data: { sessionId: input.sessionId, model: 'scripted-transport' },
      };
      yield {
        type: 'text_delta',
        data: { text: mode === 'runner-owner-before-provider' ? 'On it.' : 'green' },
      };
      yield { type: 'done', data: { sessionId: input.sessionId } };
    },
    async interrupt() {
      return { outcome: 'closed', runtime: 'codex' };
    },
    async shutdown() {},
  };
  return {
    observeRun(id: string, current: OriginalRoomRunnerObservation) {
      observedEntryId = id;
      observation = current;
    },
    createRuntime(construction: Construction) {
      db = construction.db;
      runtime = new CodexRuntime({
        threadMap: new CodexThreadMap(construction.db),
        defaultCwd: construction.targets[0]!.agentPath,
        transport,
        resolveBinary: async () => process.execPath,
        modelCatalog: { getSupportedModels: async () => [] },
      });
      runtime.setMeshCore(construction.mesh);
      runtime.setConnectorRuntimeTools({
        principals: construction.principals,
        listenerUrl: 'http://127.0.0.1:1/mcp/connections',
        agentToolsUrl: 'http://127.0.0.1:1/mcp/agent-tools',
        isConnectorCapabilityId: () => false,
      });
      // A real alternative constructor exists so a wrong fallback cannot pass.
      runtimeRegistry.register(new TestModeRuntime('claude-code', construction.principals));
      return runtime;
    },
    async releaseProvider() {
      await runtime?.shutdown();
    },
    async run(actual: OriginalNativeLaunchFixture, selected: Mode) {
      owning = actual;
      mode = selected;
      target = await actual.bootNativeAgent();
      const selectedRuntime = runtime;
      assert.ok(selectedRuntime);
      runtimeRegistry.setDefault('claude-code');
      const agent = actual.db
        .select()
        .from(agents)
        .where(eq(agents.projectPath, target.agentPath))
        .get();
      assert.ok(agent);
      await writeManifest(
        target.agentPath,
        AgentManifestSchema.parse({
          id: agent.id,
          name: 'native-agent',
          runtime:
            selected === 'runner-bound-codex' || selected === 'runner-bound-halt'
              ? 'claude-code'
              : 'codex',
          registeredAt: agent.registeredAt,
          registeredBy: 'original-runner-control',
        })
      );
      if (selected !== 'runner-bound-codex' && selected !== 'runner-bound-halt') {
        actual.db
          .delete(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, target.sessionId))
          .run();
        assert.equal(
          actual.db
            .select()
            .from(sessionMetadata)
            .where(eq(sessionMetadata.sessionId, target.sessionId))
            .get(),
          undefined
        );
      }
      if (
        selected === 'runner-first-codex' ||
        selected === 'runner-owner-before-provider' ||
        selected === 'runner-new-then-reused'
      ) {
        actual.db
          .delete(roomSessions)
          .where(
            and(eq(roomSessions.roomId, actual.roomId), eq(roomSessions.authorId, target.authorId))
          )
          .run();
        assert.equal(actual.subsystem.store.getRoomSession(actual.roomId, target.authorId), null);
      } else {
        actualSessionId = target.sessionId;
        assert.equal(
          actual.subsystem.store.getRoomSession(actual.roomId, target.authorId),
          target.sessionId
        );
      }
      if (selected === 'runner-bound-halt') {
        const originalGet = runtimeRegistry.get;
        const originalInterrupt = selectedRuntime.interruptQuery;
        const asked: string[] = [];
        const delivered: string[] = [];
        runtimeRegistry.get = function (...args) {
          asked.push(args[0]);
          return Reflect.apply(originalGet, this, args);
        };
        selectedRuntime.interruptQuery = function (...args) {
          delivered.push(args[0]);
          return Reflect.apply(originalInterrupt, this, args);
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
          await actual.runner.interrupt({
            sessionId: target.sessionId,
            agentPath: target.agentPath,
          });
          assert.deepEqual(asked, ['codex']);
          assert.deepEqual(delivered, [target.sessionId]);
          assert.equal(starts, 0);
        } catch (cause) {
          remember(cause);
        } finally {
          try {
            runtimeRegistry.get = originalGet;
          } catch (cause) {
            remember(cause);
          }
          try {
            selectedRuntime.interruptQuery = originalInterrupt;
          } catch (cause) {
            remember(cause);
          }
        }
        if (failed) throw first;
        return;
      }
      const originalPersist = runtimeRegistry.persistSessionRuntime;
      const persisted: Parameters<typeof originalPersist>[] = [];
      runtimeRegistry.persistSessionRuntime = async function (...args) {
        persisted.push(args);
        const result = await Reflect.apply(originalPersist, this, args);
        // Observe DATA only after the original registry performed its actual write.
        if (args[1] === 'codex' && args[3] === target?.agentPath) actualSessionId = args[0];
        return result;
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
        const entry = actual.subsystem.service.post(actual.roomId, {
          authorId: actual.operator.id,
          text: 'is the build green?',
          mentions: [target.authorId],
        });
        entryId = entry.id;
        await actual.subsystem.service.triggersIdle();
        assert.equal(starts, 1);
        assert.ok(observation);
        const completion = await observation.completion;
        if (completion.kind !== 'returned') throw completion.cause;
        assert.equal(completion.kind, 'returned');
        assert.ok(actualSessionId);
        assert.equal(completion.result.sessionId, actualSessionId);
        assert.equal(
          completion.result.text,
          selected === 'runner-owner-before-provider' ? 'On it.' : 'green'
        );
        assert.equal(boundWhenStarted, true);
        assert.ok(persisted.length > 0);
        assert.deepEqual(persisted[persisted.length - 1], [
          actualSessionId,
          'codex',
          { kind: 'room', externalAuthor: false },
          target.agentPath,
        ]);
        assert.equal(
          actual.db
            .select()
            .from(sessionMetadata)
            .where(eq(sessionMetadata.sessionId, actualSessionId))
            .get()?.runtime,
          'codex'
        );
        assert.equal(
          actual.subsystem.store.getRoomSession(actual.roomId, target.authorId),
          actualSessionId
        );
        if (selected === 'runner-new-then-reused') {
          const firstSessionId = actualSessionId;
          assert.match(firstSessionId, /^[0-9a-f-]{36}$/);
          assert.notEqual(firstSessionId, target.sessionId);
          // This Codex transport completed; no TestMode interaction barrier exists.
          const selected = runtimeRegistry.get('codex');
          assert.equal(readOriginalRegisteredRuntime(selected), selectedRuntime);
          let settled = false;
          for (let i = 0; i < 1000 && !settled; i++) {
            assert.equal(
              readOriginalRegisteredRuntime(runtimeRegistry.get('codex')),
              selectedRuntime
            );
            settled =
              !isTurnInFlight(firstSessionId, selected) &&
              peekProjector(firstSessionId)?.getStatus().lifecycle === 'idle';
            if (!settled) await new Promise((resolve) => setTimeout(resolve, 1));
          }
          assert.equal(settled, true);
          const secondEntry = actual.subsystem.service.post(actual.roomId, {
            authorId: actual.operator.id,
            text: 'is the build green?',
            mentions: [target.authorId],
          });
          assert.notEqual(secondEntry.id, entry.id);
          entryId = secondEntry.id;
          await actual.subsystem.service.triggersIdle();
          assert.equal(starts, 2);
          assert.equal(observedEntryId, secondEntry.id);
          assert.ok(observation);
          const secondCompletion = await observation.completion;
          if (secondCompletion.kind !== 'returned') throw secondCompletion.cause;
          assert.equal(secondCompletion.kind, 'returned');
          assert.equal(secondCompletion.result.sessionId, firstSessionId);
          assert.equal(secondCompletion.result.text, 'green');
          assert.equal(
            actual.subsystem.store.getRoomSession(actual.roomId, target.authorId),
            firstSessionId
          );
          assert.deepEqual(persisted.at(-1), [
            firstSessionId,
            'codex',
            { kind: 'room', externalAuthor: false },
            target.agentPath,
          ]);
        }
        if (selected === 'runner-released-halt') {
          // Original completed turn is retired. Model the real conversation
          // ownership removal/change with stored DATA and its current manifest.
          actual.db
            .delete(sessionMetadata)
            .where(eq(sessionMetadata.sessionId, actualSessionId))
            .run();
          await writeManifest(
            target.agentPath,
            AgentManifestSchema.parse({
              id: agent.id,
              name: 'native-agent',
              runtime: 'claude-code',
              registeredAt: agent.registeredAt,
              registeredBy: 'original-runner-control',
            })
          );
          const claude = runtimeRegistry.get('claude-code');
          const originalGet = runtimeRegistry.get;
          const originalClaudeInterrupt = claude.interruptQuery;
          const originalCodexInterrupt = selectedRuntime.interruptQuery;
          const deliveredTo: string[] = [];
          runtimeRegistry.get = function (...args) {
            return Reflect.apply(originalGet, this, args);
          };
          claude.interruptQuery = function (...args) {
            deliveredTo.push('claude-code');
            return Reflect.apply(originalClaudeInterrupt, this, args);
          };
          selectedRuntime.interruptQuery = function (...args) {
            deliveredTo.push('codex');
            return Reflect.apply(originalCodexInterrupt, this, args);
          };
          try {
            await actual.runner.interrupt({
              sessionId: actualSessionId,
              agentPath: target.agentPath,
            });
            assert.deepEqual(deliveredTo, ['claude-code']);
          } catch (cause) {
            remember(cause);
          } finally {
            try {
              runtimeRegistry.get = originalGet;
            } catch (cause) {
              remember(cause);
            }
            try {
              claude.interruptQuery = originalClaudeInterrupt;
            } catch (cause) {
              remember(cause);
            }
            try {
              selectedRuntime.interruptQuery = originalCodexInterrupt;
            } catch (cause) {
              remember(cause);
            }
          }
        }
      } catch (cause) {
        remember(cause);
      } finally {
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
