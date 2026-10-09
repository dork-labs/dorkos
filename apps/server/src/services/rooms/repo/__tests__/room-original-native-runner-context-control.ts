/** Constructor-acquired Room context and original attachment projection controls. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { and, eq, roomSessions, sessionMetadata } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import { CodexRuntime } from '../../../runtimes/codex/codex-runtime.js';
import { CodexThreadMap } from '../../../runtimes/codex/thread-map.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { readTestModeOriginalActiveStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { readOriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import { LocalRoomAttachmentStore } from '../../attachments/local-room-attachment-store.js';
import { setRoomAttachmentStores } from '../../attachments/attachment-stores.js';
import { projectedAttachmentPath } from '../../attachments/attachment-paths.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

type FixtureOptions = NonNullable<
  Parameters<
    (typeof import('./room-original-native-launch-fixture.js'))['createOriginalNativeLaunchFixture']
  >[0]
>;
interface ProjectionOrderWitness {
  agentPath?: string;
  entryId?: string;
  present?: boolean;
  calls: number;
}
const ORIGINAL_ATTACHMENT_ID = 'original-context-attachment';

type Construction = Parameters<NonNullable<FixtureOptions['createNativeRuntime']>>[0];

export type OriginalRunnerContextMode =
  | 'runner-home-grants-attachments'
  | 'runner-projection-before-provider'
  | 'runner-measured-launch-context'
  | 'runner-accepted-no-files-context';

export async function runOriginalNativeRunnerContextControl(
  owning: OriginalNativeLaunchFixture,
  mode: OriginalRunnerContextMode,
  git: (args: string[], cwd?: string) => Promise<string>,
  dispatchWitness?: ProjectionOrderWitness
): Promise<void> {
  const target = await owning.bootNativeAgent();
  if (dispatchWitness) dispatchWitness.agentPath = target.agentPath;
  const runtime = runtimeRegistry.get('claude-code');
  const originalScenario = scenarioStore.getScenario;
  const copy = path.join(
    owning.repos.worktreesPath(owning.roomId),
    RoomWorktreeManager.slugFor('Native Agent', target.agentPath)
  );
  const repo = owning.repos.repoPath(owning.roomId);
  const attachmentId = ORIGINAL_ATTACHMENT_ID;
  const attachmentMode =
    mode === 'runner-home-grants-attachments' || mode === 'runner-projection-before-provider';
  let entryId: string | undefined;
  let starts = 0;
  let placed: ReturnType<OriginalNativeLaunchFixture['readPlacedContext']>;
  let placementHeld = false;
  let idle: Promise<void> | undefined;
  let completion: ReturnType<typeof readOriginalRoomRunnerObservation>;
  let failed = false;
  let first: unknown;
  const remember = (cause: unknown): void => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const ask = (text: string, attachmentIds?: string[]) =>
    owning.subsystem.service.post(owning.roomId, {
      authorId: owning.operator.id,
      text,
      mentions: [target.authorId],
      ...(attachmentIds ? { attachmentIds } : {}),
    });
  try {
    if (attachmentMode) {
      const bytes = new LocalRoomAttachmentStore(owning.dir);
      const stored = await bytes.put(owning.roomId, attachmentId, 'log', Buffer.from('crash!'));
      owning.subsystem.attachments.create(
        {
          roomId: owning.roomId,
          id: attachmentId,
          authorId: owning.operator.id,
          name: 'crash.log',
          extension: 'log',
          mimeType: 'text/plain',
          size: 6,
          preview: null,
          url: stored.url,
        },
        new Date().toISOString()
      );
      setRoomAttachmentStores({ attachments: bytes, rows: owning.subsystem.attachments });
    }
    if (mode === 'runner-measured-launch-context') {
      ask('Establish the original native Room copy.');
      await owning.subsystem.service.triggersIdle();
      for (
        let i = 0;
        i < 1000 &&
        (isTurnInFlight(target.sessionId, runtime) ||
          peekProjector(target.sessionId)?.getStatus().lifecycle !== 'idle');
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(isTurnInFlight(target.sessionId, runtime), false);
      assert.equal(peekProjector(target.sessionId)?.getStatus().lifecycle, 'idle');
      await writeFile(path.join(repo, 'ROOM.md'), '# Updated original conventions\n');
      await git(['add', 'ROOM.md']);
      await git([
        '-c',
        'user.name=Owner',
        '-c',
        'user.email=owner@dorkos.local',
        'commit',
        '-q',
        '-m',
        'Update Room conventions',
      ]);
    }
    scenarioStore.getScenario = function (sessionId) {
      const previous = Reflect.apply(originalScenario, this, [sessionId]);
      if (sessionId !== target.sessionId) return previous;
      return async function* (_content, context, opts): AsyncGenerator<StreamEvent> {
        assert.equal(context.sessionId, target.sessionId);
        assert.ok(readTestModeOriginalActiveStream(runtime, target.sessionId));
        assert.ok(entryId);
        const prepared = owning.readPreparedContext(target.sessionId);
        assert.ok(prepared);
        assert.equal(prepared.triggerEntryId, entryId);
        completion = readOriginalRoomRunnerObservation(owning.runner, entryId);
        assert.ok(completion);
        starts++;
        if (mode === 'runner-accepted-no-files-context') {
          assert.ok(placed);
          assert.deepEqual(prepared, placed);
          assert.equal(prepared.files, undefined);
        } else if (mode === 'runner-measured-launch-context') {
          assert.ok(placed?.files);
          assert.equal(placed.files.behind, 1);
          assert.equal(prepared.files?.behind, 0);
          assert.equal(prepared.files?.ahead, 0);
          assert.equal(prepared.files?.refresh?.kind, 'refreshed');
          assert.deepEqual({ ...prepared, files: placed.files }, placed);
          assert.equal(
            await readFile(path.join(copy, 'ROOM.md'), 'utf8'),
            '# Updated original conventions\n'
          );
        }
        if (attachmentMode) {
          assert.equal(opts?.cwd, target.agentPath);
          assert.equal(opts?.forAgent, target.agentPath);
          assert.equal(peekProjector(target.sessionId)?.cwd, target.agentPath);
          const projected = path.join(
            target.agentPath,
            projectedAttachmentPath(entryId, attachmentId, 'crash.log')
          );
          // Read inside the original acquired provider before its first output.
          assert.deepEqual(await readFile(projected), Buffer.from('crash!'));
          if (mode === 'runner-home-grants-attachments') {
            assert.deepEqual(opts?.additionalDirectories, [
              { path: copy, access: 'write' },
              { path: repo, access: 'read' },
              { path: path.join(repo, '.git', 'objects'), access: 'write' },
              { path: path.join(repo, '.git', 'refs', 'heads', 'room'), access: 'write' },
              { path: path.join(repo, '.git', 'logs', 'refs', 'heads', 'room'), access: 'write' },
              { path: path.join(repo, '.git', 'worktrees', path.basename(copy)), access: 'write' },
            ]);
            assert.equal(opts?.roomTurn?.cwd, target.agentPath);
            assert.equal(opts?.roomTurn?.agentPath, target.agentPath);
            assert.equal(opts?.roomTurn?.worktree, copy);
          }
        }
        yield { type: 'session_status', data: { sessionId: target.sessionId, model: 'test-mode' } };
        yield { type: 'text_delta', data: { text: 'got it' } };
        yield { type: 'done', data: { sessionId: target.sessionId } };
      };
    };
    if (mode === 'runner-measured-launch-context' || mode === 'runner-accepted-no-files-context') {
      owning.pauseNextNativePlacement();
      placementHeld = true;
    }
    const entry = ask(
      'Inspect the original current Room context.',
      attachmentMode ? [attachmentId] : undefined
    );
    entryId = entry.id;
    idle = owning.subsystem.service.triggersIdle();
    void idle.catch(remember);
    if (placementHeld) {
      for (
        let i = 0;
        i < 1000 && owning.readPlacedContext(target.sessionId)?.triggerEntryId !== entry.id;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 1));
      placed = owning.readPlacedContext(target.sessionId);
      assert.ok(placed);
      assert.equal(placed.triggerEntryId, entry.id);
      owning.releaseNativePlacement();
      placementHeld = false;
    }
    await idle;
    if (mode === 'runner-projection-before-provider') {
      assert.ok(dispatchWitness);
      assert.equal(dispatchWitness.calls, 1);
      assert.equal(dispatchWitness.entryId, entry.id);
      assert.equal(dispatchWitness.present, true);
    }
    assert.equal(starts, 1);
    assert.ok(completion);
    const outcome = await completion.completion;
    if (outcome.kind !== 'returned') throw outcome.cause;
    assert.equal(outcome.kind, 'returned');
    assert.equal(outcome.result.text, 'got it');
    assert.equal(outcome.result.sessionId, target.sessionId);
    assert.equal(outcome.result.unanswered, undefined);
  } catch (cause) {
    remember(cause);
  } finally {
    if (placementHeld) {
      try {
        owning.releaseNativePlacement();
      } catch (cause) {
        remember(cause);
      }
    }
    if (idle) {
      try {
        await idle;
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
}

/** Passive phase DATA is measured at the real original Trigger launch closure. */
export function makeOriginalRunnerLaunchContextControl() {
  let owning: OriginalNativeLaunchFixture | undefined;
  let db: import('@dorkos/db').Db | undefined;
  let target: Awaited<ReturnType<OriginalNativeLaunchFixture['bootNativeAgent']>> | undefined;
  let runtime: import('../../../runtimes/codex/codex-runtime.js').CodexRuntime | undefined;
  let entryId: string | undefined;
  let observation: import('../../room-turn-runner.js').OriginalRoomRunnerObservation | undefined;
  let starts = 0;
  const launches: { sessionId: string; roomId: string; ownerOnRecord: boolean }[] = [];
  return {
    observeRun(
      id: string,
      current: import('../../room-turn-runner.js').OriginalRoomRunnerObservation
    ) {
      entryId = id;
      observation = current;
    },
    observeOriginalLaunch(data: Readonly<{ sessionId: string; roomId: string }>) {
      // No assertion can be hidden by the intentionally observational catch.
      const row = db
        ?.select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, data.sessionId))
        .get();
      launches.push({
        ...data,
        ownerOnRecord: row?.runtime === 'codex' && row.agentPath === target?.agentPath,
      });
      // Prove that even throw(undefined) cannot redirect or fail the native launch.
      throw undefined;
    },
    createRuntime(construction: Construction) {
      db = construction.db;
      target = construction.targets[0];
      assert.ok(target);
      runtime = new CodexRuntime({
        threadMap: new CodexThreadMap(db),
        defaultCwd: target.agentPath,
        transport: {
          kind: 'exec',
          capabilities: {},
          async *runTurn(input) {
            assert.ok(owning);
            assert.ok(target);
            assert.equal(input.cwd, target.agentPath);
            assert.equal(input.signal.aborted, false);
            assert.equal(launches.length, 1);
            assert.deepEqual(launches[0], {
              sessionId: input.sessionId,
              roomId: owning.roomId,
              ownerOnRecord: true,
            });
            starts++;
            yield {
              type: 'session_status',
              data: { sessionId: input.sessionId, model: 'scripted-transport' },
            };
            yield { type: 'text_delta', data: { text: 'On it.' } };
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
      runtime.setMeshCore(construction.mesh);
      runtime.setConnectorRuntimeTools({
        principals: construction.principals,
        listenerUrl: 'http://127.0.0.1:1/mcp/connections',
        agentToolsUrl: 'http://127.0.0.1:1/mcp/agent-tools',
        isConnectorCapabilityId: () => false,
      });
      return runtime;
    },
    async releaseProvider() {
      await runtime?.shutdown();
    },
    async run(
      actual: OriginalNativeLaunchFixture,
      mode: 'runner-bound-launch-context' | 'runner-owner-before-refresh'
    ) {
      owning = actual;
      target = await actual.bootNativeAgent();
      const fixedTarget = target;
      if (mode === 'runner-owner-before-refresh') {
        actual.db
          .delete(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, fixedTarget.sessionId))
          .run();
        actual.db
          .delete(roomSessions)
          .where(
            and(
              eq(roomSessions.roomId, actual.roomId),
              eq(roomSessions.authorId, fixedTarget.authorId)
            )
          )
          .run();
        assert.equal(
          actual.subsystem.store.getRoomSession(actual.roomId, fixedTarget.authorId),
          null
        );
      } else {
        assert.equal(
          actual.subsystem.store.getRoomSession(actual.roomId, fixedTarget.authorId),
          fixedTarget.sessionId
        );
      }
      const entry = actual.subsystem.service.post(actual.roomId, {
        authorId: actual.operator.id,
        text: 'Launch the original Room turn.',
        mentions: [fixedTarget.authorId],
      });
      await actual.subsystem.service.triggersIdle();
      assert.equal(entryId, entry.id);
      assert.equal(starts, 1);
      assert.equal(launches.length, 1);
      assert.equal(launches[0]!.roomId, actual.roomId);
      assert.equal(launches[0]!.ownerOnRecord, true);
      assert.ok(observation);
      const result = await observation.completion;
      if (result.kind !== 'returned') throw result.cause;
      assert.equal(result.kind, 'returned');
      assert.equal(result.result.text, 'On it.');
      assert.equal(result.result.sessionId, launches[0]!.sessionId);
      if (mode === 'runner-owner-before-refresh')
        assert.notEqual(result.result.sessionId, fixedTarget.sessionId);
      else assert.equal(result.result.sessionId, fixedTarget.sessionId);
    },
  };
}

/** The witness runs at the genuine pre-dispatch boundary, never in the provider. */
export function makeOriginalRunnerProjectionOrderControl() {
  const witness: ProjectionOrderWitness = { calls: 0 };
  return {
    observeBeforeDispatch(entryId: string) {
      witness.calls++;
      witness.entryId = entryId;
      witness.present =
        typeof witness.agentPath === 'string' &&
        existsSync(
          path.join(
            witness.agentPath,
            projectedAttachmentPath(entryId, ORIGINAL_ATTACHMENT_ID, 'crash.log')
          )
        );
      // The native result must survive even an undefined observational exception.
      throw undefined;
    },
    async run(
      owning: OriginalNativeLaunchFixture,
      git: (args: string[], cwd?: string) => Promise<string>
    ) {
      await runOriginalNativeRunnerContextControl(
        owning,
        'runner-projection-before-provider',
        git,
        witness
      );
    },
  };
}
