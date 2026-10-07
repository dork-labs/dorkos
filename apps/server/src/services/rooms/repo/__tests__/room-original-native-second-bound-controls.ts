/** Real Room request plus a second bound session's original dispatcher/lock. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq, sessionMetadata } from '@dorkos/db';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { dispatchMessage, isTurnInFlight } from '../../../session/message-dispatcher.js';
import { getOrCreateProjector, peekProjector } from '../../../session/session-state-projector.js';
import { interactionGate } from '../../../runtimes/test-mode/interaction-gate.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

export async function prepareOriginalNativeSecondBoundBusyControl(
  owning: OriginalNativeLaunchFixture,
  git: (args: string[], cwd?: string) => Promise<string>,
  lockOnly: boolean
): Promise<() => Promise<void>> {
  const native = await owning.bootNativeAgent();
  const post = (text: string) =>
    owning.subsystem.service.post(owning.roomId, {
      authorId: owning.operator.id,
      text,
      mentions: [native.authorId],
    });
  post('@native hello');
  await owning.subsystem.service.triggersIdle();
  const starts = () =>
    peekProjector(native.sessionId)!
      .replayFrom(0)
      .filter((event) => event.type === 'turn_start').length;
  const before = starts();
  owning.holdCanonicalSession(native.sessionId);
  post('@native establish original canonical binding');
  for (let i = 0; i < 1000 && starts() !== before + 1; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(starts(), before + 1);
  let released = false;
  for (let i = 0; i < 1000 && !released; i++) {
    released = owning.stepCanonicalSession(native.sessionId);
    if (!released) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(released, true);
  for (let i = 0; i < 1000 && !owning.readCanonicalSession(native.sessionId); i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const canonical = owning.readCanonicalSession(native.sessionId);
  assert.ok(canonical && canonical !== native.sessionId);
  assert.equal(owning.subsystem.store.getRoomSession(owning.roomId, native.authorId), canonical);
  assert.ok(
    owning.subsystem.store.sessionLedger.retiredIdsFor(canonical).includes(native.sessionId)
  );
  await owning.finishCanonicalSession(native.sessionId);
  const copy = path.join(
    owning.repos.worktreesPath(owning.roomId),
    RoomWorktreeManager.slugFor('Native Agent', native.agentPath)
  );
  // The real rekey established canonical settings and a durable retired alias.
  // Reconstruct the old conversation's metadata from those observed settings,
  // not a principal/binding/permission DTO.
  const current = owning.db
    .select()
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, canonical))
    .get();
  assert.ok(current);
  const retained = owning.db
    .select()
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, native.sessionId))
    .get();
  // Original runtime rekey retires the alias but deletes its metadata row.
  // Restore only the genuine observed canonical settings for this resumed
  // conversation; a surviving row must still belong to the same agent/runtime.
  assert.equal(current.agentPath, native.agentPath);
  if (retained) {
    assert.equal(retained.agentPath, native.agentPath);
    assert.equal(retained.runtime, current.runtime);
    owning.db
      .update(sessionMetadata)
      .set({ ...current, sessionId: native.sessionId })
      .where(eq(sessionMetadata.sessionId, native.sessionId))
      .run();
  } else {
    owning.db
      .insert(sessionMetadata)
      .values({ ...current, sessionId: native.sessionId })
      .run();
  }
  assert.deepEqual(
    owning.db
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, native.sessionId))
      .get(),
    { ...current, sessionId: native.sessionId }
  );
  const runtime = runtimeRegistry.get('claude-code');
  runtime.ensureSession(native.sessionId, { cwd: native.agentPath, permissionMode: 'default' });
  return async () => {
    const head = await git(['rev-parse', 'HEAD'], copy);
    let finished: Promise<void> | undefined;
    let settled!: () => void;
    let dispatchAccepted = false;
    let canonicalHeld = false;
    let failed = false;
    let first: unknown;
    const remember = (cause: unknown): void => {
      if (!failed) {
        failed = true;
        first = cause;
      }
    };
    const holder = new EventEmitter() as SseResponse;
    const holderId = 'original-second-bound-lock';
    try {
      if (lockOnly) {
        assert.equal(runtime.acquireLock(native.sessionId, holderId, holder), true);
        assert.equal(getOrCreateProjector(native.sessionId).peekInProgressTurn(), null);
      } else {
        finished = new Promise<void>((resolve) => {
          settled = resolve;
        });
        scenarioStore.setForSession(native.sessionId, 'warm-echo');
        const result = await dispatchMessage({
          sessionId: native.sessionId,
          clientId: 'original-second-bound-client',
          content: 'an app-resumed turn',
          cwd: native.agentPath,
          forAgent: native.agentPath,
          runtime,
          projector: getOrCreateProjector(native.sessionId),
          onError: remember,
          onSettled: (outcome) => {
            if (outcome !== 'ok') remember(new Error('Original resumed turn failed'));
            settled();
          },
        });
        dispatchAccepted = result.queued === false;
        assert.equal(result.queued, false);
        for (let i = 0; i < 1000 && !peekProjector(native.sessionId)?.peekInProgressTurn(); i++)
          await new Promise((resolve) => setTimeout(resolve, 1));
        assert.ok(peekProjector(native.sessionId)?.peekInProgressTurn());
      }
      assert.equal(isTurnInFlight(native.sessionId, runtime), true);
      assert.equal(owning.subsystem.service.listActiveClaims().length, 0);
      await writeFile(
        path.join(owning.repos.repoPath(owning.roomId), 'PLAN.md'),
        '# second-bound plan\n'
      );
      await git(['add', 'PLAN.md']);
      await git([
        '-c',
        'user.name=Owner',
        '-c',
        'user.email=owner@dorkos.local',
        'commit',
        '-q',
        '-m',
        'PLAN',
      ]);
      // The actual dispatcher refuses a foreign in-flight turn before launching.
      // A bare runtime lock instead reaches launch preparation, which reports held.
      const canonicalStarts = () =>
        peekProjector(canonical)
          ?.replayFrom(0)
          .filter((event) => event.type === 'turn_start').length ?? 0;
      const startsBefore = canonicalStarts();
      if (lockOnly) {
        scenarioStore.setForSession(canonical, 'warm-echo');
        canonicalHeld = true;
      }
      const held = post('@native original launch while second session is busy');
      if (lockOnly) {
        for (
          let i = 0;
          i < 1000 && owning.readBoundPreparedContext(native.sessionId)?.triggerEntryId !== held.id;
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 1));
        const prepared = owning.readBoundPreparedContext(native.sessionId);
        assert.ok(prepared);
        assert.equal(prepared.triggerEntryId, held.id);
        assert.deepEqual(prepared.files?.refresh, { kind: 'held', reason: 'busy', moved: null });
        let canonicalReleased = false;
        for (let i = 0; i < 1000 && !canonicalReleased; i++) {
          canonicalReleased = interactionGate.step(canonical);
          if (!canonicalReleased) await new Promise((resolve) => setTimeout(resolve, 1));
        }
        assert.equal(canonicalReleased, true);
        canonicalHeld = false;
        scenarioStore.clearSession(canonical);
      }
      await owning.subsystem.service.triggersIdle();
      if (!lockOnly) {
        const notices = owning.subsystem.store
          .listEntriesAfter(owning.roomId, held.seq)
          .filter(
            (entry) =>
              entry.body.notice === 'agent_busy' && entry.body.subjectAuthorId === native.authorId
          );
        assert.equal(notices.length, 1);
        assert.equal(canonicalStarts(), startsBefore);
        assert.notEqual(owning.readBoundPreparedContext(native.sessionId)?.triggerEntryId, held.id);
        assert.equal(isTurnInFlight(native.sessionId, runtime), true);
      }
      assert.equal(await git(['rev-parse', 'HEAD'], copy), head);
      await assert.rejects(readFile(path.join(copy, 'PLAN.md')), { code: 'ENOENT' });
      if (lockOnly) runtime.releaseLock(native.sessionId, holderId);
      else {
        assert.equal(interactionGate.step(native.sessionId), true);
        await finished;
      }
      if (failed) throw first;
      assert.equal(isTurnInFlight(native.sessionId, runtime), false);
      const next = post('@native original launch after the second session settles');
      await owning.subsystem.service.triggersIdle();
      const refreshed = owning.readBoundPreparedContext(native.sessionId);
      assert.ok(refreshed);
      assert.equal(refreshed.triggerEntryId, next.id);
      assert.equal(refreshed.files?.refresh?.kind, 'refreshed');
      assert.equal(await readFile(path.join(copy, 'PLAN.md'), 'utf8'), '# second-bound plan\n');
    } catch (cause) {
      remember(cause);
    } finally {
      try {
        scenarioStore.clearSession(canonical);
      } catch (cause) {
        remember(cause);
      }
      const cancellations: Promise<unknown>[] = [];
      if (canonicalHeld) {
        try {
          const cancellation = runtime.interruptQuery(canonical);
          void cancellation.catch(remember);
          cancellations.push(cancellation);
        } catch (cause) {
          remember(cause);
        }
      }
      try {
        runtime.releaseLock(native.sessionId, holderId);
      } catch (cause) {
        remember(cause);
      }
      try {
        const cancellation = runtime.interruptQuery(native.sessionId);
        void cancellation.catch(remember);
        cancellations.push(cancellation);
      } catch (cause) {
        remember(cause);
      }
      await Promise.allSettled(cancellations);
      try {
        if (finished && dispatchAccepted) await finished;
      } catch (cause) {
        remember(cause);
      }
      try {
        scenarioStore.clearSession(native.sessionId);
      } catch (cause) {
        remember(cause);
      }
    }
    if (failed) throw first;
  };
}
