/** Genuine constructor/Trigger execution defaults; observations are immutable DATA. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { agents, eq, sessionMetadata } from '@dorkos/db';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import { writeManifest } from '@dorkos/shared/manifest';
import { configManager } from '../../../core/config-manager.js';
import { SessionEventStore } from '../../../session/session-event-store.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { createTurnExecutionSettingsResolver } from '../../../relay/turn-execution-settings.js';
import { permissionSeedForOrigin, type TurnOrigin } from '../../../session/origin/turn-origin.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { initPermissionGate, resetPermissionGate } from '../../../core/capabilities/index.js';
import { CodexRuntime } from '../../../runtimes/codex/codex-runtime.js';
import { CodexThreadMap } from '../../../runtimes/codex/thread-map.js';
import { ClaudeCodeRuntime } from '../../../runtimes/claude-code/claude-code-runtime.js';
import { LocalSessionAttachmentStore } from '../../../session/attachments/local-session-attachment-store.js';
import type { OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import { createOriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';
import { observeOriginalClaudeSession } from '../../../runtimes/claude-code/__tests__/room-original-claude-sdk-data.js';

export interface OriginalDefaultsScenario {
  readonly history?: 'boundaries' | 'no-text';
  readonly providerFragments?: readonly string[];
  readonly runtime?: 'claude-code' | 'codex';
  readonly runtimes?: UserConfig['runtimes'];
  readonly manifest?: {
    runtime: 'claude-code' | 'codex';
    model?: string;
    effort?: 'low' | 'medium' | 'high';
    permissions?: { filesAndCommands: 'ask' | 'act' | 'autonomy' };
  };
  readonly existing?: { model?: string; permissionMode?: string };
  readonly external?: boolean;
  readonly compareRelay?: boolean;
  readonly permission?: 'discard' | 'keep';
  readonly expectedSettings: Readonly<Record<string, string>>;
  readonly expectedMode?: string;
}
/** Install the fixed SDK DATA hook before dynamically importing this helper. */
export async function prepareOriginalClaudeDefaultsControl(scenario: OriginalDefaultsScenario) {
  let observation: OriginalRoomRunnerObservation | undefined;
  let observedEntry: string | undefined;
  const persisted: { id: string; runtime: string; origin: TurnOrigin; agentPath?: string }[] = [];
  const originalPersist = runtimeRegistry.persistSessionRuntime;
  let owning: Awaited<ReturnType<typeof createOriginalNativeLaunchFixture>> | undefined;
  let target: Awaited<ReturnType<NonNullable<typeof owning>['bootNativeAgent']>> | undefined;
  let closing: Promise<void> | undefined;
  let failed = false;
  let first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const close = () =>
    (closing ??= Promise.resolve().then(async () => {
      try {
        runtimeRegistry.persistSessionRuntime = originalPersist;
      } catch (cause) {
        remember(cause);
      }
      try {
        resetPermissionGate();
      } catch (cause) {
        remember(cause);
      }
      try {
        await owning?.close();
      } catch (cause) {
        remember(cause);
      }
      if (failed) throw first;
    }));
  try {
    owning = await createOriginalNativeLaunchFixture({
      seed: false,
      nativeRuntimeType: scenario.runtime ?? 'claude-code',
      observeRun(entryId, current) {
        observedEntry = entryId;
        observation = current;
      },
      createNativeRuntime({ dir, db, principals, mesh, targets }) {
        if (scenario.runtime === 'codex') {
          const runtime = new CodexRuntime({
            threadMap: new CodexThreadMap(db),
            defaultCwd: targets[0]!.agentPath,
            transport: {
              kind: 'exec',
              capabilities: {},
              async *runTurn(input) {
                assert.equal(input.cwd, targets[0]!.agentPath);
                assert.equal(input.signal.aborted, false);
                yield {
                  type: 'session_status',
                  data: { sessionId: input.sessionId, model: 'gpt-5.3-codex' },
                };
                yield { type: 'text_delta', data: { text: 'green' } };
                yield { type: 'done', data: { sessionId: input.sessionId } };
              },
              async interrupt() {
                return { outcome: 'closed', runtime: 'codex' };
              },
              async shutdown() {},
            },
            resolveBinary: async () => process.execPath,
            modelCatalog: { getSupportedModels: async () => [] },
          });
          runtime.setMeshCore(mesh);
          runtime.setConnectorRuntimeTools({
            principals,
            listenerUrl: 'http://127.0.0.1:1/mcp/connections',
            agentToolsUrl: 'http://127.0.0.1:1/mcp/agent-tools',
            isConnectorCapabilityId: () => false,
          });
          return runtime;
        }
        const runtime = new ClaudeCodeRuntime(
          dir,
          targets[0]!.agentPath,
          new LocalSessionAttachmentStore(path.join(dir, 'attachments'))
        );
        runtime.setMeshCore(mesh);
        runtime.setConnectorRuntimeTools({
          principals,
          listenerUrl: 'http://127.0.0.1:1/mcp/connections',
          agentToolsUrl: 'http://127.0.0.1:1/mcp/agent-tools',
          isConnectorCapabilityId: () => false,
        });
        return runtime;
      },
    });
    const account = path.join(owning.dir, 'original-claude-account');
    await mkdir(path.join(account, 'projects'), { recursive: true });
    const runtimes = scenario.runtimes ?? USER_CONFIG_DEFAULTS.runtimes;
    configManager.set('runtimes', {
      ...runtimes,
      claudeCode: { ...runtimes.claudeCode, defaultAccount: account, persistentSession: false },
    });
    target = await owning.bootNativeAgent();
    const currentTarget = target;
    const agent = owning.db
      .select()
      .from(agents)
      .where(eq(agents.projectPath, currentTarget.agentPath))
      .get();
    assert.ok(agent);
    if (scenario.manifest)
      await writeManifest(
        currentTarget.agentPath,
        AgentManifestSchema.parse({
          id: agent.id,
          name: 'native-agent',
          registeredAt: agent.registeredAt,
          registeredBy: 'original-defaults-control',
          ...scenario.manifest,
        })
      );
    if (scenario.existing) {
      owning.db
        .update(sessionMetadata)
        .set(scenario.existing)
        .where(eq(sessionMetadata.sessionId, currentTarget.sessionId))
        .run();
    } else {
      owning.db
        .delete(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, currentTarget.sessionId))
        .run();
      assert.equal(
        owning.db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, currentTarget.sessionId))
          .get(),
        undefined
      );
    }
    if (scenario.permission)
      initPermissionGate({
        readAgentPermissions: async () =>
          scenario.permission === 'keep' ? { filesAndCommands: 'autonomy' } : undefined,
      });
    runtimeRegistry.persistSessionRuntime = async function (...args) {
      const result = await Reflect.apply(originalPersist, this, args);
      const row = owning!.db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, args[0]))
        .get();
      assert.ok(row);
      assert.equal(row.runtime, args[1]);
      assert.equal(row.agentPath, currentTarget.agentPath);
      persisted.push({ id: args[0], runtime: args[1], origin: args[2], agentPath: args[3] });
      if (args[1] === 'claude-code')
        observeOriginalClaudeSession(args[0], scenario.providerFragments);
      return result;
    };
  } catch (cause) {
    remember(cause);
    try {
      await close();
    } catch {
      /* Original setup cause stays first. */
    }
    throw first;
  }
  return {
    close,
    async run() {
      assert.ok(owning && target);
      try {
        let authorId = owning.operator.id;
        if (scenario.external) {
          const external = owning.subsystem.authors.resolveExternal({
            platformType: 'telegram',
            instanceId: 'original-defaults-fixture',
            platformUserId: 'outside-person',
            displayName: 'Outside Person',
          });
          owning.subsystem.service.addMember(owning.roomId, owning.operator.id, {
            authorId: external.id,
          });
          authorId = external.id;
        }
        const existingBefore = scenario.existing
          ? owning.db
              .select()
              .from(sessionMetadata)
              .where(eq(sessionMetadata.sessionId, target.sessionId))
              .get()
          : undefined;
        const entry = owning.subsystem.service.post(owning.roomId, {
          authorId,
          text: 'is the build green?',
          mentions: [target.authorId],
        });
        await owning.subsystem.service.triggersIdle();
        assert.equal(observedEntry, entry.id);
        assert.ok(observation);
        const completion = await observation.completion;
        if (completion.kind !== 'returned') throw completion.cause;
        assert.equal(completion.kind, 'returned');
        assert.equal(completion.result.text, scenario.providerFragments?.join('') ?? 'green');
        assert.ok(completion.result.sessionId);
        const selected = runtimeRegistry.get(scenario.runtime ?? 'claude-code');
        for (
          let i = 0;
          i < 1000 &&
          (isTurnInFlight(completion.result.sessionId, selected) ||
            peekProjector(completion.result.sessionId)?.getStatus().lifecycle !== 'idle');
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 1));
        assert.equal(isTurnInFlight(completion.result.sessionId, selected), false);
        assert.equal(peekProjector(completion.result.sessionId)?.getStatus().lifecycle, 'idle');
        if (scenario.history) {
          const recorded = new SessionEventStore(owning.db).readAll(completion.result.sessionId);
          // Read the actual same-Db rows written by the original native projector.
          // Provider text above must have completed; an empty fake turn cannot pass.
          assert.deepEqual(
            recorded.map((event) => event.type),
            ['turn_start', 'turn_end']
          );
          if (scenario.history === 'no-text')
            assert.equal(
              recorded.some((event) => event.type === 'text_delta'),
              false
            );
        }
        assert.ok(observation.computedDefaults);
        assert.deepEqual(observation.computedDefaults.settings, scenario.expectedSettings);
        if (scenario.expectedMode === undefined)
          assert.equal(
            Object.hasOwn(observation.computedDefaults, 'newSessionPermissionMode'),
            false
          );
        else
          assert.equal(
            observation.computedDefaults.newSessionPermissionMode,
            scenario.expectedMode
          );
        if (scenario.compareRelay) {
          const viaRelay = await createTurnExecutionSettingsResolver()({
            runtimeType: 'claude-code',
            sessionId: 'original-unowned-relay-settings-projection',
            agentDirectory: target.agentPath,
          });
          assert.deepEqual(viaRelay, observation.computedDefaults.settings);
          assert.deepEqual(viaRelay, scenario.expectedSettings);
        }
        if (scenario.existing) {
          const after = owning.db
            .select()
            .from(sessionMetadata)
            .where(eq(sessionMetadata.sessionId, target.sessionId))
            .get();
          assert.ok(after && existingBefore);
          assert.equal(after.model, existingBefore.model);
          assert.equal(after.permissionMode, existingBefore.permissionMode);
        }
        // Original prepareLaunch and canonical result bookkeeping both record ownership.
        // Observe both genuine calls; this DATA hook must not fail the second write.
        assert.equal(persisted.length, 2);
        assert.equal(persisted[0]!.id, completion.result.sessionId);
        assert.deepEqual(persisted[1], persisted[0]);
        assert.equal(persisted[0]!.runtime, scenario.runtime ?? 'claude-code');
        assert.equal(persisted[0]!.agentPath, target.agentPath);
        assert.deepEqual(persisted[0]!.origin, {
          kind: 'room',
          externalAuthor: scenario.external === true,
        });
        assert.equal(
          permissionSeedForOrigin(persisted[0]!.origin),
          scenario.external ? 'none' : 'configured-stop-on-insert'
        );
        return persisted[0]!;
      } catch (cause) {
        remember(cause);
      }
      if (failed) throw first;
      throw new Error('Original defaults control produced no result');
    },
  };
}
