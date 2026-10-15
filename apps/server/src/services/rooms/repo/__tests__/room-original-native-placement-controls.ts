/** Actual original placement/launch controls over the owning isolated fixture. */
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { peekProjector } from '../../../session/session-state-projector.js';
import { editBaselineStore } from '../../../diff/index.js';
import path from 'node:path';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import { runOwnedRoomTurnLaunchStep } from '../room-turn-place.js';
import {
  withRecognizedInstallationRoomNamespace,
  readInstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

/** Two literal original controls; the pause does not issue a request or placement. */
export async function runOriginalNativePlacementControl(
  owning: OriginalNativeLaunchFixture,
  git: (args: string[], cwd?: string) => Promise<string>,
  caseName: 'placed-tip-change' | 'placed-dirty-counts'
): Promise<void> {
  const [ana] = await owning.bootNativePair();
  assert.ok(ana);
  const roomId = owning.roomId;
  const ask = (text: string) =>
    owning.subsystem.service.post(roomId, {
      authorId: owning.operator.id,
      text,
      mentions: [ana.authorId],
    });
  ask('@ana hello');
  await owning.subsystem.service.triggersIdle();
  assert.ok(owning.readPreparedContext(ana.sessionId));
  const copy = path.join(
    owning.repos.worktreesPath(roomId),
    RoomWorktreeManager.slugFor('Ana', ana.agentPath)
  );
  const onMain = async (file: string, text: string, message: string) => {
    await writeFile(path.join(owning.repos.repoPath(roomId), file), text, 'utf8');
    await git(['add', file]);
    await git(['-c', 'user.name=Hand', '-c', 'user.email=h@x', 'commit', '-q', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };
  let a: string | undefined;
  if (caseName === 'placed-tip-change') a = await onMain('A.md', 'a\n', 'A');
  owning.pauseNextNativePlacement();
  ask('@ana inspect the current main');
  for (let i = 0; i < 1000 && !owning.readPlacedContext(ana.sessionId); i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const placed = owning.readPlacedContext(ana.sessionId);
  assert.ok(placed?.files);
  assert.equal(placed.files.behind, caseName === 'placed-tip-change' ? 1 : 0);
  if (caseName === 'placed-dirty-counts') await onMain('A.md', 'a\n', 'A');
  const b = await onMain('B.md', 'b\n', 'B');
  if (a !== undefined) assert.notEqual(b, a);
  if (caseName === 'placed-dirty-counts')
    await writeFile(path.join(copy, 'draft.md'), 'mine\n', 'utf8');
  owning.releaseNativePlacement();
  await owning.subsystem.service.triggersIdle();
  const launched = owning.readPreparedContext(ana.sessionId);
  assert.ok(launched?.files);
  if (caseName === 'placed-tip-change') {
    assert.equal(await git(['rev-parse', 'HEAD'], copy), b);
    assert.equal(launched.files.behind, 0);
    assert.equal(launched.files.ahead, 0);
    assert.equal(launched.files.refresh?.kind, 'refreshed');
    if (launched.files.refresh?.kind !== 'refreshed')
      throw new Error('Original clean launch not refreshed');
    assert.equal(launched.files.refresh.to, b);
    assert.deepEqual(launched.files.refresh.paths, ['A.md', 'B.md']);
    assert.equal(await readFile(path.join(copy, 'A.md'), 'utf8'), 'a\n');
    assert.equal(await readFile(path.join(copy, 'B.md'), 'utf8'), 'b\n');
  } else {
    assert.equal(placed.files.behind, 0);
    assert.equal(launched.files.behind, 2);
    assert.equal(launched.files.ahead, 0);
    assert.equal(launched.files.refresh?.kind, 'held');
    if (launched.files.refresh?.kind !== 'held') throw new Error('Original dirty launch not held');
    assert.equal(launched.files.refresh.reason, 'changes');
    assert.equal(await readFile(path.join(copy, 'draft.md'), 'utf8'), 'mine\n');
  }
}

/** Original baseline invalidation assertions, after actual native placement and refresh. */
export async function runOriginalNativeRefreshBaselineControl(
  owning: OriginalNativeLaunchFixture,
  git: (args: string[], cwd?: string) => Promise<string>
): Promise<void> {
  const [, bo] = await owning.bootNativePair();
  assert.ok(bo);
  const ask = async (text: string) => {
    owning.subsystem.service.post(owning.roomId, {
      authorId: owning.operator.id,
      text,
      mentions: [bo.authorId],
    });
    await owning.subsystem.service.triggersIdle();
    assert.ok(owning.readPreparedContext(bo.sessionId));
  };
  await ask('@bo hello');
  const copy = path.join(
    owning.repos.worktreesPath(owning.roomId),
    RoomWorktreeManager.slugFor('Bo', bo.agentPath)
  );
  const baseline = {
    bytes: Buffer.from('old'),
    capturedAt: 1,
    capturedFrom: 'pre-tool' as const,
  };
  const moved = path.join(copy, 'PLAN.md');
  const movedReal = path.join(await realpath(copy), 'PLAN.md');
  const kept = path.join(copy, 'KEEP.md');
  try {
    for (const file of [moved, movedReal, kept])
      editBaselineStore.set(bo.sessionId, file, baseline);
    await writeFile(path.join(owning.repos.repoPath(owning.roomId), 'PLAN.md'), '# plan\n', 'utf8');
    await git(['add', 'PLAN.md']);
    await git(['-c', 'user.name=Hand', '-c', 'user.email=h@x', 'commit', '-q', '-m', 'PLAN.md']);
    await ask('@bo now?');
    assert.equal(owning.readPreparedContext(bo.sessionId)?.files?.refresh?.kind, 'refreshed');
    assert.equal(editBaselineStore.get(bo.sessionId, moved), undefined);
    assert.equal(editBaselineStore.get(bo.sessionId, movedReal), undefined);
    assert.ok(editBaselineStore.get(bo.sessionId, kept));
    assert.equal(await readFile(path.join(copy, 'PLAN.md'), 'utf8'), '# plan\n');
  } finally {
    editBaselineStore.clearSession(bo.sessionId);
  }
}

/** Real canonical rekey and original held message; no retired row or lock is supplied by the test. */
export async function prepareOriginalNativeRetiredIdBusyControl(
  owning: OriginalNativeLaunchFixture,
  git: (args: string[], cwd?: string) => Promise<string>,
  checkUnknownBusyRead = false
): Promise<() => Promise<void>> {
  const [, bo] = await owning.bootNativePair();
  assert.ok(bo);
  const post = (text: string) =>
    owning.subsystem.service.post(owning.roomId, {
      authorId: owning.operator.id,
      text,
      mentions: [bo.authorId],
    });
  post('@bo hello');
  await owning.subsystem.service.triggersIdle();
  assert.ok(owning.readPreparedContext(bo.sessionId));
  const copy = path.join(
    owning.repos.worktreesPath(owning.roomId),
    RoomWorktreeManager.slugFor('Bo', bo.agentPath)
  );
  const starts = () => {
    const projector = peekProjector(bo.sessionId);
    assert.ok(projector, 'Original native producer projector is unavailable');
    return projector.replayFrom(0).filter((event) => event.type === 'turn_start').length;
  };
  const before = starts();
  assert.equal(before, 1);
  owning.holdCanonicalSession(bo.sessionId);
  const originalHeldMessage = post('@bo hold this original turn');
  for (let i = 0; i < 1000 && starts() !== before + 1; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(starts(), before + 1);
  let released = false;
  for (let i = 0; i < 1000 && !released; i++) {
    released = owning.stepCanonicalSession(bo.sessionId);
    if (!released) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(released, true);
  for (let i = 0; i < 1000 && !owning.readCanonicalSession(bo.sessionId); i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const canonical = owning.readCanonicalSession(bo.sessionId);
  assert.ok(canonical && canonical !== bo.sessionId);
  assert.equal(owning.subsystem.store.getRoomSession(owning.roomId, bo.authorId), canonical);
  assert.ok(owning.subsystem.store.sessionLedger.retiredIdsFor(canonical).includes(bo.sessionId));
  return async () => {
    const head = await git(['rev-parse', 'HEAD'], copy);
    const moved = path.join(copy, 'PLAN.md'),
      kept = path.join(copy, 'KEEP.md');
    const baseline = {
      bytes: Buffer.from('old'),
      capturedAt: 1,
      capturedFrom: 'pre-tool' as const,
    };
    for (const id of [bo.sessionId, canonical]) {
      editBaselineStore.set(id, moved, baseline);
      editBaselineStore.set(id, kept, baseline);
    }
    if (checkUnknownBusyRead) {
      // This finite body negative is separate from the genuine held producer below.
      // Its actual namespace cannot issue a launch target; a failed read returns before any effect.
      // This held turn entered under the original ID before its genuine rekey.
      // Constructor DATA stays keyed by that entry; the next turn uses the current ID.
      const prepared = owning.readPreparedContext(bo.sessionId);
      assert.ok(prepared, 'Original held native prepared context unavailable');
      assert.equal(prepared.triggerEntryId, originalHeldMessage.id);
      const files = prepared.files;
      assert.ok(files);
      const calls: string[] = [];
      const refused = await withRecognizedInstallationRoomNamespace(
        owning.writer,
        owning.roomId,
        (scope) =>
          runOwnedRoomTurnLaunchStep(
            {
              boundSessionIds: () => [canonical, bo.sessionId],
              isTurnInFlight: () => Promise.reject(undefined),
              worktrees: owning.manager,
              describeCommits: () => {
                calls.push('describe');
                return new Map();
              },
              forgetBaselines: () => {
                calls.push('forget');
              },
            },
            { roomId: owning.roomId, worktree: copy, agentPath: bo.agentPath, files },
            canonical,
            readInstallationRoomMutationContext(owning.writer, owning.roomId, scope)
          )
      );
      assert.deepEqual(refused.files?.refresh, { kind: 'held', reason: 'busy', moved: null });
      assert.deepEqual(calls, []);
      assert.equal(await git(['rev-parse', 'HEAD'], copy), head);
    }
    await writeFile(path.join(owning.repos.repoPath(owning.roomId), 'PLAN.md'), '# plan\n', 'utf8');
    await git(['add', 'PLAN.md']);
    await git(['-c', 'user.name=Hand', '-c', 'user.email=h@x', 'commit', '-q', '-m', 'PLAN.md']);
    const pending = post('@bo now?');
    // Same-room messages park behind this original claim; listHolds reports only other rooms.
    const held = () =>
      owning.subsystem.service
        .listActiveClaims()
        .find(
          (entry) =>
            entry.roomId === owning.roomId &&
            entry.authorId === bo.authorId &&
            entry.entryId === originalHeldMessage.id
        );
    assert.ok(held());
    const committedPending = owning.subsystem.store.getEntryById(owning.roomId, pending.id);
    assert.ok(committedPending);
    assert.equal(committedPending.id, pending.id);
    assert.equal(owning.readCanonicalSession(bo.sessionId), canonical);
    assert.equal(starts(), before + 1);
    assert.equal(await git(['rev-parse', 'HEAD'], copy), head);
    await assert.rejects(readFile(path.join(copy, 'PLAN.md')), { code: 'ENOENT' });
    await owning.finishCanonicalSession(bo.sessionId);
    assert.equal(starts(), before + 2);
    assert.equal(held(), undefined);
    const refreshed = owning.readBoundPreparedContext(bo.sessionId);
    assert.ok(refreshed);
    assert.equal(refreshed.triggerEntryId, pending.id);
    assert.equal(
      refreshed.files?.refresh?.kind,
      'refreshed',
      JSON.stringify(refreshed.files?.refresh)
    );
    assert.equal(await readFile(path.join(copy, 'PLAN.md'), 'utf8'), '# plan\n');
    for (const id of [bo.sessionId, canonical]) {
      assert.equal(editBaselineStore.get(id, moved), undefined);
      assert.ok(editBaselineStore.get(id, kept));
    }
  };
}
