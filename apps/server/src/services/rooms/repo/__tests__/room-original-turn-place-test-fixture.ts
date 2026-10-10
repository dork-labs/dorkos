/** DATA observed at the genuine original native placement/launch boundary. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { eq, sessionMetadata } from '@dorkos/db';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import { OPERATING_SKILLS_PACK, seedOperatingSkills } from '@dorkos/operating-skills';
import { projectAgentWorkspace } from '../../../harness/project-agent-workspace.js';
import { fixtureGit } from './fixture-git.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import request from '@dorkos/test-utils/supertest';
import { vi } from 'vitest';
import { createOriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';
import { runtimeRegistry, readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { readTestModeOriginalPlacementOptions } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { interactionGate } from '../../../runtimes/test-mode/interaction-gate.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { mergeNoFf, type GitIdentity } from '../room-repo-git.js';
import {
  withRecognizedInstallationRoomNamespace,
  readInstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import type { RoomTurnPlace } from '../room-turn-place.js';
import type { Db } from '@dorkos/db';
import type { RoomRepoStore } from '../room-repo-store.js';

export async function createOriginalTurnPlaceTestFixture() {
  const original = await createOriginalNativeLaunchFixture({ seed: false });
  try {
    const targets = await original.bootNativePair();
    const selected = runtimeRegistry.get('claude-code');
    assert.ok(selected);
    const native = readOriginalRegisteredRuntime(selected);
    assert.ok(native);
    const place = async (
      roomId: string,
      agentPath: string,
      name: string
    ): Promise<RoomTurnPlace> => {
      assert.equal(roomId, original.roomId);
      const target = targets.find((entry) => entry.agentPath === agentPath);
      assert.ok(target);
      assert.equal(original.subsystem.authors.getById(target.authorId)?.displayName, name);
      original.holdNativeSession(target.sessionId);
      original.subsystem.service.post(roomId, {
        authorId: original.operator.id,
        mentions: [target.authorId],
        text: 'Inspect the original native Room directory grants.',
      });
      let failed = false,
        cause: unknown;
      let result: RoomTurnPlace | undefined;
      try {
        await vi.waitFor(() => {
          assert.equal(interactionGate.isOpen(target.sessionId), true);
          assert.ok(
            peekProjector(target.sessionId)
              ?.replayFrom(0)
              .some((event) => event.type === 'text_delta')
          );
        });
        const prepared = original.readBoundPreparedContext(target.sessionId);
        assert.ok(prepared);
        const options = readTestModeOriginalPlacementOptions(native, target.sessionId);
        assert.ok(options, 'Actual native entry must have consumed placement options.');
        assert.equal(options.cwd, agentPath);
        result = {
          cwd: options.cwd,
          additionalDirectories: (options.additionalDirectories ?? []).map((grant) => ({
            ...grant,
          })),
          worktree: prepared.files?.worktreePath ?? null,
          files: prepared.files ?? null,
        };
      } catch (error) {
        failed = true;
        cause = error;
      }
      try {
        await original.finishNativeSession(target.sessionId);
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
      try {
        await vi.waitFor(() => {
          assert.equal(isTurnInFlight(target.sessionId, selected), false);
          assert.equal(peekProjector(target.sessionId)?.getStatus().lifecycle, 'idle');
        });
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
      if (failed) throw cause;
      assert.ok(result);
      return result;
    };
    return {
      original,
      targets,
      place,
      enable: async () => {
        const response = await request(original.server)
          .post(`/api/rooms/${original.roomId}/repo`)
          .set('Authorization', `Bearer ${original.ownerKey.key}`);
        assert.equal(response.status, 201);
      },
      mergeNoFf: (
        db: Db,
        repos: RoomRepoStore,
        roomId: string,
        checkout: string,
        branch: string,
        message: string,
        identity: GitIdentity,
        ceiling: string
      ) => {
        assert.equal(db, original.db);
        assert.equal(repos, original.repos);
        assert.equal(roomId, original.roomId);
        return withRecognizedInstallationRoomNamespace(original.writer, roomId, (scope) =>
          mergeNoFf(
            checkout,
            branch,
            message,
            identity,
            ceiling,
            readInstallationRoomMutationContext(original.writer, roomId, scope)
          )
        );
      },
      close: original.close,
    };
  } catch (cause) {
    try {
      await original.close();
    } catch {
      /* Acquired setup cause stays first, including undefined. */
    }
    throw cause;
  }
}

/** Actual historical disk artifacts before the recognized manager's first file launch. */
export async function createOriginalTurnRetirementTestFixture() {
  const original = await createOriginalNativeLaunchFixture({ seed: false });
  try {
    const target = await original.bootNativeAgent();
    const selected = runtimeRegistry.get('claude-code');
    assert.ok(selected);
    // Establish the genuine retired/current bound pair while this Room has no
    // repository. No worktree retirement has occurred in this cold manager.
    original.holdCanonicalSession(target.sessionId);
    original.subsystem.service.post(original.roomId, {
      authorId: original.operator.id,
      mentions: [target.authorId],
      text: 'Establish the original native Room binding.',
    });
    await vi.waitFor(() => assert.equal(original.stepCanonicalSession(target.sessionId), true));
    await vi.waitFor(() => assert.ok(original.readCanonicalSession(target.sessionId)));
    const canonical = original.readCanonicalSession(target.sessionId);
    assert.ok(canonical && canonical !== target.sessionId);
    assert.equal(
      original.subsystem.store.getRoomSession(original.roomId, target.authorId),
      canonical
    );
    assert.ok(
      original.subsystem.store.sessionLedger.retiredIdsFor(canonical).includes(target.sessionId)
    );
    await original.finishCanonicalSession(target.sessionId);
    await vi.waitFor(() => assert.equal(isTurnInFlight(target.sessionId, selected), false));
    const current = original.db
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, canonical))
      .get();
    const alias = original.db
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, target.sessionId))
      .get();
    assert.ok(current);
    assert.equal(current.agentPath, target.agentPath);
    assert.equal(current.runtime, 'claude-code');
    const restored = { ...current, sessionId: target.sessionId };
    if (alias === undefined) {
      // The genuine canonical rekey may move the settings row. Restore only
      // this positively observed retired alias as ordinary settings DATA.
      original.db.insert(sessionMetadata).values(restored).run();
    } else {
      assert.equal(alias.agentPath, target.agentPath);
      assert.equal(alias.runtime, current.runtime);
      original.db
        .update(sessionMetadata)
        .set(restored)
        .where(eq(sessionMetadata.sessionId, target.sessionId))
        .run();
    }
    assert.deepEqual(
      original.db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, target.sessionId))
        .get(),
      { ...current, sessionId: target.sessionId }
    );
    selected.ensureSession(target.sessionId, { cwd: target.agentPath, permissionMode: 'default' });
    const enabled = await request(original.server)
      .post(`/api/rooms/${original.roomId}/repo`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`);
    assert.equal(enabled.status, 201);
    const copy = path.join(
      original.repos.worktreesPath(original.roomId),
      RoomWorktreeManager.slugFor('Native Agent', target.agentPath)
    );
    await fs.mkdir(path.dirname(copy), { recursive: true });
    await fixtureGit(
      [
        'worktree',
        'add',
        '-b',
        `room/${RoomWorktreeManager.slugFor('Native Agent', target.agentPath)}`,
        copy,
        'main',
      ],
      original.repos.repoPath(original.roomId),
      original.repos.homeDir(original.roomId)
    );
    await seedOperatingSkills(copy);
    projectAgentWorkspace(copy);
    const exclude = path.join(original.repos.repoPath(original.roomId), '.git', 'info', 'exclude');
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    const info = await fs.lstat(path.dirname(exclude));
    assert.equal(info.isDirectory(), true);
    assert.equal(info.isSymbolicLink(), false);
    await fs.writeFile(
      exclude,
      [
        '# somebody’s own line',
        '/scratch/',
        '# --- DorkOS: generated for the agent, not anybody’s work (room-worktree-manager.ts) ---',
        '/.claude/skills/',
        '/.agents/harness.manifest.json',
        '/.claude/CLAUDE.md',
        ...OPERATING_SKILLS_PACK.map((skill) => `/.agents/skills/${skill.name}/SKILL.md`),
        '# --- end DorkOS ---',
        '',
      ].join('\n')
    );
    const legacy = path.join(copy, '.agents', 'skills', 'working-in-room-repos', 'SKILL.md');
    assert.equal(existsSync(legacy), true);
    const holder = new EventEmitter() as SseResponse;
    const holderId = 'original-retirement-bound-peer';
    let locked = false;
    const release = () => {
      if (!locked) return;
      selected.releaseLock(target.sessionId, holderId);
      locked = false;
    };
    let closing: Promise<void> | undefined;
    return {
      legacy,
      copy,
      canonical,
      selected,
      isCurrentTurnInFlight: () => isTurnInFlight(canonical, selected),
      holdOther: () => {
        assert.equal(selected.acquireLock(target.sessionId, holderId, holder), true);
        locked = true;
        assert.equal(isTurnInFlight(target.sessionId, selected), true);
      },
      release,
      launch: async () => {
        original.pauseNextNativePlacement();
        let placementHeld = true;
        let failed = false;
        let cause: unknown;
        let observed: ReturnType<typeof original.readBoundPlacedContext>;
        try {
          const entry = original.subsystem.service.post(original.roomId, {
            authorId: original.operator.id,
            mentions: [target.authorId],
            text: 'Retire only original Room plumbing.',
          });
          await vi.waitFor(() => assert.ok(original.readBoundPlacedContext(target.sessionId)));
          observed = original.readBoundPlacedContext(target.sessionId);
          assert.ok(observed);
          assert.equal(observed.triggerEntryId, entry.id);
          assert.equal(observed.files?.worktreePath, copy);
          original.releaseNativePlacement();
          placementHeld = false;
          await original.subsystem.service.triggersIdle();
        } catch (error) {
          failed = true;
          cause = error;
        } finally {
          if (placementHeld) {
            try {
              original.releaseNativePlacement();
            } catch (error) {
              if (!failed) {
                failed = true;
                cause = error;
              }
            }
          }
        }
        if (failed) throw cause;
        assert.ok(observed);
        return observed;
      },
      close: () =>
        (closing ??= Promise.resolve().then(async () => {
          let failed = false,
            cause: unknown;
          try {
            release();
          } catch (error) {
            failed = true;
            cause = error;
          }
          try {
            await original.close();
          } catch (error) {
            if (!failed) {
              failed = true;
              cause = error;
            }
          }
          if (failed) throw cause;
        })),
    };
  } catch (cause) {
    try {
      await original.close();
    } catch {
      /* Acquired original setup cause stays first. */
    }
    throw cause;
  }
}
