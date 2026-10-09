/** Original refresh story driven by genuine Room post, Trigger, Runner and native merge. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { peekProjector } from '../../../session/session-state-projector.js';
import { formatRoomContext } from '../../../runtimes/shared/room-context-block.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

/** Fixed scenario; shell writes represent only an agent's own work in its real copy. */
export async function prepareOriginalNativeRefreshStory(
  owning: OriginalNativeLaunchFixture,
  git: (args: string[], cwd?: string) => Promise<string>
): Promise<() => Promise<void>> {
  const startedAt = process.hrtime.bigint();
  let phaseRows = 0;
  // Fixed phase DATA only; never emit room/session/path/content or alter original first cause.
  const phase = (label: string): void => {
    if (phaseRows++ >= 64) return;
    try {
      console.info('ORIGINAL_REFRESH_STORY_PHASE', {
        phase: label,
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      });
    } catch {
      // Secondary diagnostic output cannot replace an original scenario refusal.
    }
  };
  phase('boot-pair-start');
  const [ana, bo] = await owning.bootNativePair();
  phase('boot-pair-done');
  assert.ok(ana && bo);
  const roomId = owning.roomId;
  const copyOf = (target: typeof ana, name: string) =>
    path.join(
      owning.repos.worktreesPath(roomId),
      RoomWorktreeManager.slugFor(name, target.agentPath)
    );
  // Held native turns are not durable until turn_end; read their actual projected feed.
  const starts = (sessionId: string) =>
    peekProjector(sessionId)
      ?.replayFrom(0)
      .filter((event) => event.type === 'turn_start').length ?? 0;
  let launched = 0;
  async function ask(targets: readonly (typeof ana)[], text: string, held = false): Promise<void> {
    const before = targets.map((target) => starts(target.sessionId));
    for (const target of targets) owning.holdNativeSession(target.sessionId);
    owning.subsystem.service.post(roomId, {
      authorId: owning.operator.id,
      text,
      mentions: targets.map((target) => target.authorId),
    });
    phase('ask-observe-start');
    // Observe the real projected starts, never mint a launch/context from the wait.
    for (let i = 0; i < 1000; i++) {
      if (
        targets.every(
          (target, index) =>
            starts(target.sessionId) === before[index]! + 1 &&
            owning.readPreparedContext(target.sessionId)
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (const [index, target] of targets.entries()) {
      assert.equal(starts(target.sessionId), before[index]! + 1);
      assert.ok(owning.readPreparedContext(target.sessionId));
    }
    phase('ask-observe-done');
    launched += targets.length;
    if (!held) {
      if (targets.length === 2) await owning.finishNativePair();
      else await owning.finishNativeSession(targets[0]!.sessionId);
    }
  }
  async function commitIn(copy: string, text: string, message: string): Promise<void> {
    await writeFile(path.join(copy, 'PLAN.md'), text, 'utf8');
    await git(['add', 'PLAN.md'], copy);
    await git(
      ['-c', 'user.name=Ana', '-c', 'user.email=ana@agent', 'commit', '-q', '-m', message],
      copy
    );
  }
  // Original owning setup establishes both real copies and positively drains its first turns.
  phase('setup-hello-start');
  await ask([ana, bo], '@ana @bo hello');
  phase('setup-hello-done');
  return async () => {
    const anaCopy = copyOf(ana, 'Ana'),
      boCopy = copyOf(bo, 'Bo');
    phase('plan-v1-ask-start');
    await ask([ana], '@ana work on the plan', true);
    phase('plan-v1-ask-done');
    phase('plan-v1-commit-start');
    await commitIn(anaCopy, '# plan v1\n', 'Plan v1');
    phase('plan-v1-commit-done');
    phase('plan-v1-merge-start');
    await owning.mergeNative(ana.sessionId, 'Add the plan');
    phase('plan-v1-merge-done');
    phase('ana-finish-start');
    await owning.finishNativeSession(ana.sessionId);
    phase('ana-finish-done');

    phase('clean-copy-ask-start');
    await ask([bo], '@bo what changed?');
    phase('clean-copy-ask-done');
    const boTurn = owning.readPreparedContext(bo.sessionId)!;
    assert.equal(boTurn.files?.refresh?.kind, 'refreshed');
    if (boTurn.files?.refresh?.kind !== 'refreshed')
      throw new Error('Original clean copy was not refreshed');
    assert.deepEqual(boTurn.files.refresh.paths, ['PLAN.md']);
    assert.equal(boTurn.files?.behind, 0);
    assert.equal(boTurn.files?.ahead, 0);
    assert.equal(await readFile(path.join(boCopy, 'PLAN.md'), 'utf8'), '# plan v1\n');
    assert.ok(
      formatRoomContext(boTurn).includes(
        'Your copy was brought up to date with main at the start of this turn (1 file changed).'
      )
    );

    phase('plan-v2-ask-start');
    await ask([ana], '@ana keep going', true);
    phase('plan-v2-ask-done');
    phase('plan-v2-commit-start');
    await commitIn(anaCopy, '# plan v2\n', 'Plan v2');
    phase('plan-v2-commit-done');
    phase('plan-v2-merge-start');
    await owning.mergeNative(ana.sessionId, 'Plan v2');
    phase('plan-v2-merge-done');
    phase('ana-finish-start');
    await owning.finishNativeSession(ana.sessionId);
    phase('ana-finish-done');
    phase('dirty-copy-write-start');
    await writeFile(path.join(boCopy, 'PLAN.md'), '# plan, Bo’s edit\n', 'utf8');
    phase('dirty-copy-write-done');
    phase('dirty-copy-ask-start');
    await ask([bo], '@bo and now?');
    phase('dirty-copy-ask-done');
    const held = owning.readPreparedContext(bo.sessionId)!;
    assert.equal(held.files?.refresh?.kind, 'held');
    if (held.files?.refresh?.kind !== 'held')
      throw new Error('Original dirty refresh was not held');
    assert.equal(held.files.refresh.reason, 'changes');
    assert.deepEqual(
      held.files.refresh.moved?.commits.map((c) => ({
        kind: c.kind,
        who: c.who,
        subject: c.subject,
        files: c.files,
      })),
      [{ kind: 'merge', who: 'Ana', subject: 'Plan v2', files: ['PLAN.md'] }]
    );
    assert.deepEqual(held.files.refresh.moved?.overlap, ['PLAN.md']);
    assert.equal(await readFile(path.join(boCopy, 'PLAN.md'), 'utf8'), '# plan, Bo’s edit\n');
    const block = formatRoomContext(held);
    assert.ok(block.includes('You have also changed one of those files (listed there).'));
    assert.ok(block.includes('Files you have also changed: PLAN.md'));

    const turnsBefore = launched;
    const projectedBefore = starts(ana.sessionId) + starts(bo.sessionId);
    const entriesBefore = owning.subsystem.store.listEntriesFrom(roomId, {
      afterSeq: 0,
      limit: 500,
    }).length;
    const head = await git(['rev-parse', 'HEAD']);
    phase('save-room-start');
    const saved = await request(owning.server)
      .put(`/api/rooms/${roomId}/files/content`)
      .set('Authorization', `Bearer ${owning.ownerKey.key}`)
      .send({ path: 'ROOM.md', baseCommit: head, text: '# Release train\n\nShip Thursdays.\n' });
    phase('save-room-done');
    assert.equal(saved.status, 200);
    phase('post-save-idle-start');
    await owning.subsystem.service.triggersIdle();
    phase('post-save-idle-done');
    assert.equal(launched, turnsBefore);
    assert.equal(starts(ana.sessionId) + starts(bo.sessionId), projectedBefore);
    assert.equal(
      owning.subsystem.store.listEntriesFrom(roomId, { afterSeq: 0, limit: 500 }).length,
      entriesBefore + 1
    );
    phase('saved-room-ask-start');
    await ask([bo], '@bo anything else?');
    phase('saved-room-ask-done');
    const named = owning.readPreparedContext(bo.sessionId)!;
    assert.equal(named.files?.refresh?.kind, 'held');
    if (named.files?.refresh?.kind !== 'held')
      throw new Error('Original dirty refresh was not held');
    assert.equal(named.files.refresh.reason, 'changes');
    assert.deepEqual(
      named.files.refresh.moved?.commits.map((c) => [c.kind, c.who, c.files]),
      [
        ['person', 'Dorian', ['ROOM.md']],
        ['merge', 'Ana', ['PLAN.md']],
      ]
    );
  };
}
