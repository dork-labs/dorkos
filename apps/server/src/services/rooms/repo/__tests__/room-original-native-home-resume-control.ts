/** Genuine Room Trigger and constructor; external SDK data describes historical cwd only. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { eq, sessionMetadata } from '@dorkos/db';
import { configManager } from '../../../core/config-manager.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import { LocalSessionAttachmentStore } from '../../../session/attachments/local-session-attachment-store.js';
import { ClaudeCodeRuntime } from '../../../runtimes/claude-code/claude-code-runtime.js';
import {
  observeOriginalClaudeSession,
  readOriginalClaudeSdkHomeInputs,
} from '../../../runtimes/claude-code/__tests__/room-original-claude-sdk-data.js';
import { OpenCodeRuntime } from '../../../runtimes/opencode/opencode-runtime.js';
import { OpenCodeSessionMap } from '../../../runtimes/opencode/sessions/session-map.js';
import { createOriginalOpenCodeHomeData } from '../../../runtimes/opencode/__tests__/room-original-opencode-home-data.js';
import type { OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
import { createOriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

export async function prepareOriginalHomeResumeControl(
  kind: 'opencode-copy' | 'opencode-home' | 'claude-copy'
) {
  const type = kind === 'claude-copy' ? 'claude-code' : 'opencode';
  const sidecar = createOriginalOpenCodeHomeData();
  let observation: OriginalRoomRunnerObservation | undefined;
  let observedEntry: string | undefined;
  let raw: ClaudeCodeRuntime | OpenCodeRuntime | undefined;
  let owning: Awaited<ReturnType<typeof createOriginalNativeLaunchFixture>> | undefined;
  let target: Awaited<ReturnType<NonNullable<typeof owning>['bootNativeAgent']>> | undefined;
  let sdkMap: OpenCodeSessionMap | undefined;
  let copy: string | undefined;
  let failed = false;
  let first: unknown;
  let closing: Promise<void> | undefined;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const persist = runtimeRegistry.persistSessionRuntime;
  const close = () =>
    (closing ??= Promise.resolve().then(async () => {
      try {
        runtimeRegistry.persistSessionRuntime = persist;
      } catch (cause) {
        remember(cause);
      }
      // Join the original owner after its captured sidecar queue cancellation starts.
      try {
        await owning?.close();
      } catch (cause) {
        remember(cause);
      }
      try {
        sidecar.close();
      } catch (cause) {
        remember(cause);
      }
      if (failed) throw first;
    }));
  try {
    owning = await createOriginalNativeLaunchFixture({
      nativeRuntimeType: type,
      // Release external event queues before the original native owner joins them.
      releaseProvider: () => {
        sidecar.close();
      },
      observeRun(id, value) {
        observedEntry = id;
        observation = value;
      },
      createNativeRuntime({ dir, db, mesh, principals, targets }) {
        const current = targets[0]!;
        assert.ok(owning);
        copy = path.join(owning.repos.worktreesPath(owning.roomId), 'historical-agent');
        // Seeded external history stands under this actual owned Room's old copy name.
        if (type === 'opencode') {
          sdkMap = new OpenCodeSessionMap(db);
          const sdkId = 'ses_original_room_home';
          sdkMap.bind(current.sessionId, sdkId);
          sidecar.seed(sdkId, kind === 'opencode-copy' ? copy : current.agentPath);
          raw = new OpenCodeRuntime({ sessionMap: sdkMap, provider: sidecar.provider });
        } else {
          raw = new ClaudeCodeRuntime(
            dir,
            current.agentPath,
            new LocalSessionAttachmentStore(path.join(dir, 'attachments'))
          );
          raw.ensureSession(current.sessionId, {
            cwd: copy,
            permissionMode: 'default',
            hasStarted: true,
          });
          assert.equal(raw.getSessionCwd(current.sessionId), copy);
        }
        raw.setMeshCore?.(mesh);
        raw.setConnectorRuntimeTools?.({
          principals,
          listenerUrl: 'http://127.0.0.1:1/mcp/connections',
          agentToolsUrl: 'http://127.0.0.1:1/mcp/agent-tools',
          isConnectorCapabilityId: () => false,
        });
        return raw;
      },
    });
    const account = path.join(owning.dir, 'original-home-resume-account');
    await mkdir(path.join(account, 'projects'), { recursive: true });
    const runtimes = configManager.get('runtimes');
    configManager.set('runtimes', {
      ...runtimes,
      claudeCode: { ...runtimes.claudeCode, defaultAccount: account, persistentSession: false },
    });
    target = await owning.bootNativeAgent();
    assert.ok(raw && copy);
    await mkdir(copy, { recursive: true });
    if (raw instanceof ClaudeCodeRuntime) assert.equal(raw.getSessionCwd(target.sessionId), copy);
    if (raw instanceof OpenCodeRuntime) {
      if (kind === 'opencode-copy') {
        // The real bootstrap registers home; make the same tracked historical
        // session agree with its already seeded external copy before querying it.
        raw.ensureSession(target.sessionId, { cwd: copy, permissionMode: 'default' });
      }
      const previous = await raw.getSession(target.agentPath, target.sessionId);
      assert.ok(previous);
      assert.equal(previous.cwd, kind === 'opencode-copy' ? copy : target.agentPath);
    }
    const old = owning.subsystem.store.getRoomSession(owning.roomId, target.authorId);
    assert.equal(old, target.sessionId);
    const row = owning.db
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, old!))
      .get();
    assert.ok(row);
    assert.equal(row.runtime, type);
    assert.equal(row.agentPath, target.agentPath);
    runtimeRegistry.persistSessionRuntime = async function (...args) {
      const result = await Reflect.apply(persist, this, args);
      if (args[1] === 'claude-code') observeOriginalClaudeSession(args[0]);
      return result;
    };
  } catch (cause) {
    remember(cause);
    try {
      await close();
    } catch {
      /* Setup cause remains first. */
    }
    throw first;
  }
  return {
    close,
    async run() {
      try {
        assert.ok(owning && target && raw);
        const entry = owning.subsystem.service.post(owning.roomId, {
          authorId: owning.operator.id,
          text: 'is the build green?',
          mentions: [target.authorId],
        });
        await owning.subsystem.service.triggersIdle();
        assert.equal(observedEntry, entry.id);
        assert.ok(observation);
        const completion = await observation.completion;
        if (completion.kind !== 'returned') throw completion.cause;
        assert.equal(completion.kind, 'returned');
        assert.equal(completion.result.text, 'green');
        const actual = completion.result.sessionId;
        assert.ok(actual);
        if (kind === 'opencode-copy') assert.notEqual(actual, target.sessionId);
        else assert.equal(actual, target.sessionId);
        assert.equal(owning.subsystem.store.getRoomSession(owning.roomId, target.authorId), actual);
        const row = owning.db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, actual))
          .get();
        assert.ok(row);
        assert.equal(row.runtime, type);
        assert.equal(row.agentPath, target.agentPath);
        if (type === 'opencode') {
          assert.equal(sidecar.prompts.length, 1);
          assert.equal(sidecar.prompts[0]!.cwd, target.agentPath);
          if (kind === 'opencode-copy')
            assert.notEqual(sidecar.prompts[0]!.sessionId, 'ses_original_room_home');
          else assert.equal(sidecar.prompts[0]!.sessionId, 'ses_original_room_home');
          assert.equal(
            sdkMap!.listAll().find((value) => value.sessionId === target.sessionId)?.ocSessionId,
            'ses_original_room_home'
          );
          assert.equal(
            sdkMap!.listAll().find((value) => value.sessionId === actual)?.ocSessionId,
            sidecar.prompts[0]!.sessionId
          );
        } else {
          assert.ok(raw instanceof ClaudeCodeRuntime);
          assert.deepEqual(readOriginalClaudeSdkHomeInputs(), [
            { sessionId: actual, cwd: target.agentPath, resume: target.sessionId },
          ]);
        }
        const selected = runtimeRegistry.get(type);
        for (
          let i = 0;
          i < 1000 &&
          (isTurnInFlight(actual, selected) ||
            peekProjector(actual)?.getStatus().lifecycle !== 'idle');
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 1));
        assert.equal(isTurnInFlight(actual, selected), false);
        assert.equal(peekProjector(actual)?.getStatus().lifecycle, 'idle');
      } catch (cause) {
        remember(cause);
      }
      if (failed) throw first;
    },
  };
}
