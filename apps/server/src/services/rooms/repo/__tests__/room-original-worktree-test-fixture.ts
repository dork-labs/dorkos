/** Actual native placement/launch and accepted maintenance for the legacy manager controls. */
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { interactionGate } from '../../../runtimes/test-mode/interaction-gate.js';
import path from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { vi } from 'vitest';
import { configManager } from '../../../core/config-manager.js';
import { createOriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';
import { RoomWorktreeManager, type RoomWorktreeHandle } from '../room-worktree-manager.js';
import { commitAll, removeWorktree } from '../room-repo-git.js';
import { fixtureGit } from './fixture-git.js';
import {
  withRecognizedInstallationRoomNamespace,
  readInstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';

export async function createOriginalWorktreeTestFixture(options: {
  homeParent: string;
  now: () => number;
  reapDays: () => number;
}) {
  const original = await createOriginalNativeLaunchFixture({
    seed: false,
    homeParent: options.homeParent,
    now: options.now,
    maintenance: true,
  });
  let postContext: AsyncResource | undefined;
  try {
    const targets = await original.bootNativePair();
    // Capture a genuinely independent caller outside any later owning maintenance
    // scope. A filesystem observer must not inherit that operation's async owner.
    const independentPosts = new AsyncResource('original-native-room-post', {
      requireManualDestroy: true,
    });
    postContext = independentPosts;
    const postEntry = (input: Parameters<typeof original.subsystem.service.post>[1]) =>
      independentPosts.runInAsyncScope(() =>
        original.subsystem.service.post(original.roomId, input)
      );
    const targetFor = (agentPath: string) => {
      const target = targets.find((entry) => entry.agentPath === agentPath);
      assert.ok(target, 'Actual registered native target required.');
      return target;
    };
    const git = (args: string[], cwd = original.repos.repoPath(original.roomId)) =>
      fixtureGit(args, cwd, original.repos.homeDir(original.roomId));
    const issuedEntries = new Set<string>();
    const post = async (agentPath: string, text: string) => {
      const target = targetFor(agentPath);
      const entry = postEntry({
        authorId: original.operator.id,
        mentions: [target.authorId],
        text,
      });
      issuedEntries.add(entry.id);
      await original.subsystem.service.triggersIdle();
      const prepared = original.readBoundPreparedContext(target.sessionId);
      assert.ok(prepared);
      // Concurrent real posts may share the final prepared observation after
      // the room-wide idle join. Its exact entry must still belong to this Room.
      assert.ok(typeof prepared.triggerEntryId === 'string');
      assert.ok(issuedEntries.has(prepared.triggerEntryId));
      return prepared;
    };
    const ensure = async (
      roomId: string,
      agentPath: string,
      name: string
    ): Promise<RoomWorktreeHandle> => {
      assert.equal(roomId, original.roomId);
      targetFor(agentPath);
      const slug = RoomWorktreeManager.slugFor(name, agentPath);
      const directory = path.join(original.repos.worktreesPath(roomId), slug);
      const hadCheckout = existsSync(path.join(directory, '.git'));
      const prepared = await post(agentPath, 'Inspect the original Room working copy.');
      assert.ok(prepared.files, 'Actual native turn must acquire Room file placement.');
      assert.equal(prepared.files.worktreePath, directory);
      return {
        slug,
        path: prepared.files.worktreePath,
        branch: prepared.files.branch,
        repo: prepared.files.repoPath,
        // Historical result DATA observed before the real native request; no capability is returned.
        created: !hadCheckout,
      };
    };
    const historical = async (agentPath: string, name: string) => {
      targetFor(agentPath);
      const slug = RoomWorktreeManager.slugFor(name, agentPath);
      const directory = path.join(original.repos.worktreesPath(original.roomId), slug);
      await mkdir(path.dirname(directory), { recursive: true });
      // Existing legacy disk DATA predates this constructor's first genuine native launch.
      await git(['worktree', 'add', '-b', `room/${slug}`, directory, 'main']);
      return directory;
    };
    const leaves = async (root: string): Promise<Set<string>> => {
      const answer = new Set<string>();
      const visit = async (directory: string) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.name === '.git') continue;
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await visit(file);
          else answer.add(file);
        }
      };
      await visit(root);
      return answer;
    };
    const retire = async (roomId: string, directory: string, agentPath: string) => {
      assert.equal(roomId, original.roomId);
      const before = await leaves(directory);
      const exclude = path.join(original.repos.repoPath(roomId), '.git', 'info', 'exclude');
      const beforeExclude = await readFile(exclude, 'utf8');
      await post(agentPath, 'Retire original historical Room plumbing.');
      let removed = 0;
      for (const file of before) if (!existsSync(file)) removed++;
      const afterExclude = await readFile(exclude, 'utf8');
      return {
        removed,
        blockRemoved:
          beforeExclude.includes('# --- DorkOS:') && !afterExclude.includes('# --- DorkOS:'),
      };
    };
    const reconcile = async () => {
      assert.ok(original.reconciler);
      configManager.set('rooms', {
        ...configManager.get('rooms'),
        repo: { ...configManager.get('rooms').repo, worktreeReapDays: options.reapDays() },
      });
      return original.reconciler.reconcile();
    };
    const reap = async (roomId: string) => {
      assert.equal(roomId, original.roomId);
      const root = original.repos.worktreesPath(roomId);
      const before = existsSync(root) ? await readdir(root) : [];
      const enabled = configManager.get('rooms').repo.enabled;
      const result = await reconcile();
      const detailed = {
        reaped: [] as string[],
        reapedTreeKeptBranch: [] as string[],
        spared: [] as string[],
        stranded: [] as string[],
      };
      if (!enabled || !original.repo.hasRepo(roomId)) {
        assert.deepEqual(result.worktrees, {
          reaped: 0,
          reapedTreeKeptBranch: 0,
          spared: 0,
          stranded: 0,
        });
        assert.deepEqual(existsSync(root) ? await readdir(root) : [], before);
        return detailed;
      }
      for (const slug of before) {
        const directory = path.join(root, slug);
        if (!existsSync(directory)) {
          const branch = await git(['branch', '--list', `room/${slug}`]);
          (branch.trim() ? detailed.reapedTreeKeptBranch : detailed.reaped).push(slug);
        } else {
          try {
            const status = await original.manager.worktreeStatus(roomId, slug);
            (status && !status.dirty && status.aheadOfMain === 0
              ? detailed.spared
              : detailed.stranded
            ).push(slug);
          } catch {
            detailed.stranded.push(slug);
          }
        }
      }
      // The genuine accepted maintenance result is authoritative; disk observations
      // only recover per-tree DATA that its aggregate public response does not expose.
      for (const key of ['reaped', 'reapedTreeKeptBranch', 'spared', 'stranded'] as const)
        assert.equal(detailed[key].length, result.worktrees[key]);
      return detailed;
    };
    const claim = async (agentPath: string) => {
      const target = targetFor(agentPath);
      original.holdNativeSession(target.sessionId);
      const entry = postEntry({
        authorId: original.operator.id,
        mentions: [target.authorId],
        text: 'Hold the original native Room turn.',
      });
      // Room claims precede placement. Maintenance can own its same room lease,
      // so waiting for the SDK barrier here would deadlock that actual lease.
      await vi.waitFor(() => {
        assert.ok(
          original.subsystem.service.listActiveClaims().some((own) => own.entryId === entry.id)
        );
      });
      return async () => {
        await vi.waitFor(() => assert.equal(interactionGate.isOpen(target.sessionId), true));
        await original.finishNativeSession(target.sessionId);
      };
    };
    const hold = async (agentPath: string) => {
      const release = await claim(agentPath);
      const target = targetFor(agentPath);
      await vi.waitFor(() => assert.equal(interactionGate.isOpen(target.sessionId), true));
      return release;
    };
    let closingPromise: Promise<void> | undefined;
    return {
      original,
      agentPath: (name: string) => {
        const index = name.toLowerCase() === 'ana' ? 0 : name.toLowerCase() === 'bo' ? 1 : -1;
        const target = targets[index];
        assert.ok(target, 'Actual fixture agent name required.');
        return target.agentPath;
      },
      enable: async () => {
        const response = await request(original.server)
          .post(`/api/rooms/${original.roomId}/repo`)
          .set('Authorization', `Bearer ${original.ownerKey.key}`);
        assert.ok(response.status === 201 || response.status === 409);
      },
      manager: {
        ensureWorktree: ensure,
        retireLegacyPlumbing: retire,
        reapRoom: reap,
        worktreeStatus: original.manager.worktreeStatus.bind(original.manager),
        turnFilesContext: original.manager.turnFilesContext.bind(original.manager),
      },
      historical,
      hold,
      claim,
      reconcile,
      commit: (checkout: string, message: string, identity: { name: string; email: string }) =>
        withRecognizedInstallationRoomNamespace(original.writer, original.roomId, (scope) =>
          commitAll(
            checkout,
            message,
            identity,
            original.repos.homeDir(original.roomId),
            readInstallationRoomMutationContext(original.writer, original.roomId, scope)
          )
        ),
      remove: (directory: string) =>
        withRecognizedInstallationRoomNamespace(original.writer, original.roomId, (scope) =>
          removeWorktree(
            original.repos.repoPath(original.roomId),
            directory,
            original.repos.homeDir(original.roomId),
            readInstallationRoomMutationContext(original.writer, original.roomId, scope)
          )
        ),
      close: () =>
        (closingPromise ??= Promise.resolve().then(async () => {
          let failed = false;
          let first: unknown;
          const remember = (cause: unknown): void => {
            if (!failed) {
              failed = true;
              first = cause;
            }
          };
          try {
            await original.close();
          } catch (cause) {
            remember(cause);
          }
          try {
            independentPosts.emitDestroy();
          } catch (cause) {
            remember(cause);
          }
          if (failed) throw first;
        })),
    };
  } catch (cause) {
    try {
      await original.close();
    } catch {
      /* Exact setup cause, including undefined, stays first. */
    }
    try {
      postContext?.emitDestroy();
    } catch {
      /* The same original setup cause remains first. */
    }
    throw cause;
  }
}
