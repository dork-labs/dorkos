import type { OriginalRoomRunnerObservation } from '../../room-turn-runner.js';
/** Fixed isolated native launch scenario; this module never imports Vitest. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq, sessionEvents, sessionMetadata, sql } from '@dorkos/db';
import { SessionEventSchema } from '@dorkos/shared/session-stream';
import { ROOM_REPO_CONFIG_UNSAFE_MEMBER_MESSAGE } from '../../data/room-errors.js';
import { internalGitArgs } from '../../../../lib/git-safety.js';
import { RoomWorktreeManager, roomWorktreeBranch } from '../room-worktree-manager.js';
import { interactionGate } from '../../../runtimes/test-mode/interaction-gate.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import { createOriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

// Temporary fixed phase DATA; elapsed process time includes actual static dependency loading.
function originalConstructionPhase(
  phase: 'module-ready' | 'fixture-start' | 'fixture-ready' | 'setup-start' | 'setup-ready'
): void {
  console.info('ORIGINAL_NATIVE_SETUP_PHASE ' + phase + ' ' + Math.round(process.uptime() * 1000));
}
originalConstructionPhase('module-ready');

function fixtureGitEnvironment(cwd: string, ceiling: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
  ])
    delete env[name];
  const rel = path.relative(path.resolve(ceiling), path.resolve(cwd));
  const [top, name] = rel.split(path.sep);
  if (top === 'worktrees' && name && name !== '..' && !path.isAbsolute(rel)) {
    const common = path.join(path.resolve(ceiling), 'repo', '.git');
    env.GIT_COMMON_DIR = common;
    env.GIT_DIR = path.join(common, 'worktrees', name);
    env.GIT_WORK_TREE = path.join(path.resolve(ceiling), 'worktrees', name);
  }
  return {
    ...env,
    GIT_CEILING_DIRECTORIES: ceiling,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function fixtureGitArguments(args: readonly string[]): string[] {
  return [
    ...internalGitArgs(),
    '-c',
    'diff.ignoreSubmodules=all',
    '-c',
    'status.submoduleSummary=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'maintenance.autoDetach=false',
    '-c',
    'gc.autoDetach=false',
    ...args,
  ];
}

async function fixtureGit(args: readonly string[], cwd: string, ceiling: string): Promise<string> {
  const { stdout } = await promisify(execFile)('git', fixtureGitArguments(args), {
    cwd,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    env: fixtureGitEnvironment(cwd, ceiling),
  });
  return stdout.trim();
}

async function scenario(): Promise<void> {
  if (caseName === 'runner-no-binding') {
    await noBindingControl!.run(owning);
    return;
  }
  if (
    caseName === 'runner-unstarted-cancel-data' ||
    caseName === 'runner-started-failed-data' ||
    caseName === 'runner-delayed-start-data' ||
    caseName === 'runner-own-tail-data' ||
    caseName === 'runner-foreign-words-data' ||
    caseName === 'runner-own-activity-data' ||
    caseName === 'runner-foreign-approval-data'
  ) {
    await identityControl!.run(owning, caseName);
    return;
  }
  if (caseName === 'runner-stop-state-pair') {
    await (
      await import('./room-original-native-runner-completion-control.js')
    ).runOriginalNativeRunnerCompletionControl(owning, 'runner-stream-text');
    return;
  }
  if (
    caseName === 'runner-approval-quick' ||
    caseName === 'runner-approval-standing' ||
    caseName === 'runner-approval-failed' ||
    caseName === 'runner-approval-ended'
  ) {
    await approvalControl!.run(owning, caseName);
    return;
  }
  if (
    caseName === 'runner-late-answer' ||
    caseName === 'runner-half-answer' ||
    caseName === 'runner-clamped-ceiling' ||
    caseName === 'runner-unclosed-ceiling'
  ) {
    await replyWaitControl!.run(owning, caseName);
    return;
  }
  if (caseName === 'runner-owner-write-failure') {
    await ownerWriteControl!.run(owning);
    return;
  }
  if (caseName === 'runner-confirmed-stop' || caseName === 'runner-unconfirmed-stop') {
    await stopReceiptControl!.run(owning, caseName);
    return;
  }
  if (
    caseName === 'runner-canonical-halt' ||
    caseName === 'runner-canonical-owner' ||
    caseName === 'runner-canonical-level'
  ) {
    await canonicalHaltControl!.run(owning, caseName);
    return;
  }
  if (caseName === 'runner-bound-launch-context' || caseName === 'runner-owner-before-refresh') {
    await launchContextControl!.run(owning, caseName);
    return;
  }
  if (caseName === 'runner-projection-before-provider') {
    const repo = owning.repos.repoPath(owning.roomId);
    const ceiling = owning.repos.homeDir(owning.roomId);
    await projectionOrderControl!.run(owning, (args, cwd = repo) => fixtureGit(args, cwd, ceiling));
    return;
  }
  if (
    caseName === 'runner-home-grants-attachments' ||
    caseName === 'runner-measured-launch-context' ||
    caseName === 'runner-accepted-no-files-context'
  ) {
    const repo = owning.repos.repoPath(owning.roomId);
    const ceiling = owning.repos.homeDir(owning.roomId);
    await (
      await import('./room-original-native-runner-context-control.js')
    ).runOriginalNativeRunnerContextControl(owning, caseName, (args, cwd = repo) =>
      fixtureGit(args, cwd, ceiling)
    );
    return;
  }
  if (
    caseName === 'runner-first-captured-halt' ||
    caseName === 'runner-preaccepted-halt' ||
    caseName === 'runner-remembered-halt' ||
    caseName === 'runner-boot-stop'
  ) {
    if (!captureControl) throw new Error('Original captured halt control absent');
    await captureControl.run(owning);
    return;
  }
  if (caseName === 'runner-foreign-lock' || caseName === 'runner-busy-disposition') {
    await (
      await import('./room-original-native-runner-foreign-lock-control.js')
    ).runOriginalNativeRunnerForeignLockControl(owning, () => observedRun);
    return;
  }
  if (
    caseName === 'runner-bound-codex' ||
    caseName === 'runner-first-codex' ||
    caseName === 'runner-owner-before-provider' ||
    caseName === 'runner-placeholder-codex' ||
    caseName === 'runner-bound-halt' ||
    caseName === 'runner-released-halt' ||
    caseName === 'runner-new-then-reused'
  ) {
    await codexControl!.run(owning, caseName);
    return;
  }
  if (
    caseName === 'runner-missing-runtime' ||
    caseName === 'runner-no-fallback' ||
    caseName === 'runner-missing-halt'
  ) {
    await (
      await import('./room-original-native-runner-refusal-control.js')
    ).runOriginalNativeRunnerRefusalControl(owning, caseName, () => ({
      count: observedRuns,
      pending: observedRunPending,
      entryId: observedEntryId,
      observation: observedRun,
    }));
    return;
  }
  if (caseName === 'runner-observer-failure') {
    await (
      await import('./room-original-native-runner-completion-control.js')
    ).runOriginalNativeRunnerCompletionControl(owning);
    assert.equal(observedRuns, 1);
    assert.ok(observedRun);
    assert.equal(Object.isFrozen(observedRun), true);
    assert.equal(Object.hasOwn(observedRun, 'request'), false);
    return;
  }
  if (
    caseName === 'runner-completion' ||
    caseName === 'runner-stream-text' ||
    caseName === 'runner-empty-text' ||
    caseName === 'runner-content' ||
    caseName === 'runner-paragraphs' ||
    caseName === 'runner-token-counts' ||
    caseName === 'runner-failed' ||
    caseName === 'runner-quiet' ||
    caseName === 'runner-no-files' ||
    caseName === 'runner-framing' ||
    caseName === 'runner-durable-error' ||
    caseName === 'runner-durable-log' ||
    caseName === 'runner-optional-posting' ||
    caseName === 'runner-false-posting' ||
    caseName === 'runner-posting-home' ||
    caseName === 'runner-turn-boundary' ||
    caseName === 'runner-desk-guard'
  ) {
    await (
      await import('./room-original-native-runner-completion-control.js')
    ).runOriginalNativeRunnerCompletionControl(owning, caseName);
    return;
  }
  if (caseName.startsWith('app-resume-')) {
    await (
      await import('./room-original-app-resume-controls.js')
    ).runOriginalNativeAppResumeControl(owning, caseName);
    return;
  }
  if (caseName === 'second-bound-dispatcher-busy' || caseName === 'second-bound-runtime-lock') {
    if (!setup.secondBound) throw new Error('Original second bound control unavailable');
    await setup.secondBound();
    return;
  }
  if (caseName === 'retired-id-busy' || caseName === 'busy-read-unknown') {
    if (!setup.retiredBusy) throw new Error('Original retired-id busy setup is unavailable');
    await setup.retiredBusy();
    return;
  }
  if (caseName === 'refresh-baselines') {
    const repo = owning.repos.repoPath(owning.roomId);
    const ceiling = owning.repos.homeDir(owning.roomId);
    await (
      await import('./room-original-native-placement-controls.js')
    ).runOriginalNativeRefreshBaselineControl(owning, (args, cwd = repo) =>
      fixtureGit(args, cwd, ceiling)
    );
    return;
  }
  if (caseName === 'placed-tip-change' || caseName === 'placed-dirty-counts') {
    const repo = owning.repos.repoPath(owning.roomId);
    const ceiling = owning.repos.homeDir(owning.roomId);
    await (
      await import('./room-original-native-placement-controls.js')
    ).runOriginalNativePlacementControl(
      owning,
      (args, cwd = repo) => fixtureGit(args, cwd, ceiling),
      caseName
    );
    return;
  }
  if (caseName === 'refresh-story') {
    if (!setup.refreshStory) throw new Error('Original native refresh setup is unavailable');
    await setup.refreshStory();
    return;
  }
  if (caseName === 'merge-capability' || caseName === 'merge-config-refusal') {
    const native = await owning.bootNativeAgent();
    owning.holdNativeSession(native.sessionId);
    owning.subsystem.service.post(owning.roomId, {
      authorId: owning.operator.id,
      text: 'Please merge the original native work.',
      mentions: [native.authorId],
    });
    // Actual emitted text precedes the original scenario's held step barrier.
    for (
      let i = 0;
      i < 1000 &&
      !peekProjector(native.sessionId)
        ?.replayFrom(0)
        .some((event) => event.type === 'text_delta');
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(
      peekProjector(native.sessionId)
        ?.replayFrom(0)
        .some((event) => event.type === 'text_delta')
    );
    assert.equal(interactionGate.isOpen(native.sessionId), true);
    const repo = owning.repos.repoPath(owning.roomId);
    const ceiling = owning.repos.homeDir(owning.roomId);
    const copy = path.join(
      owning.repos.worktreesPath(owning.roomId),
      RoomWorktreeManager.slugFor('Native Agent', native.agentPath)
    );
    const git = (args: string[], cwd = repo) => fixtureGit(args, cwd, ceiling);
    const before = await git(['rev-parse', 'HEAD']);
    await writeFile(path.join(copy, 'NATIVE-MERGE.md'), '# Original native merge\n');
    await git(['add', '--all'], copy);
    await git(
      [
        '-c',
        'user.name=Native Agent',
        '-c',
        'user.email=native@dorkos.local',
        'commit',
        '-q',
        '-m',
        'native work',
      ],
      copy
    );
    const branchTip = await git(['rev-parse', 'HEAD'], copy);
    // This helper reads the actual active stream's private principal and invokes
    // the original constructor-associated registry, never a context DTO.
    if (caseName === 'merge-config-refusal') {
      // Genuine native custody already exists; poison only fixture disk DATA afterwards.
      const config = path.join(repo, '.git', 'config');
      const marker = path.join(owning.dir, 'native-config-program-ran');
      await git(['config', '--file', config, 'filter.x.smudge', `touch ${marker}`]);
      let refused = false;
      try {
        await owning.mergeNative(native.sessionId, 'Original native work');
      } catch (cause) {
        refused = true;
        assert.ok(cause && typeof cause === 'object' && 'payload' in cause);
        assert.deepEqual(cause.payload, {
          code: 'ROOM_REPO_CONFIG_UNSAFE',
          error: ROOM_REPO_CONFIG_UNSAFE_MEMBER_MESSAGE,
        });
      }
      assert.equal(refused, true);
      // Use raw fixture Git to restore configuration before checking unchanged native effects.
      await git(['config', '--file', config, '--unset', 'filter.x.smudge']);
      assert.equal(await git(['rev-parse', 'HEAD']), before);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(repo, 'NATIVE-MERGE.md')), { code: 'ENOENT' });
      assert.equal(
        owning.subsystem.service
          .listEntries(owning.roomId, owning.operator.id, { limit: 100 })
          .filter((entry) => entry.body.merge !== undefined).length,
        0
      );
      await owning.finishNativeSession(native.sessionId);
      assert.equal(interactionGate.isOpen(native.sessionId), false);
      assert.equal(
        peekProjector(native.sessionId)
          ?.replayFrom(0)
          .filter((event) => event.type === 'turn_end').length,
        1
      );
      return;
    }
    const merged = await owning.mergeNative(native.sessionId, 'Original native work');
    const landed = await git(['rev-parse', 'HEAD']);
    assert.notEqual(landed, before);
    assert.equal(merged.commit, landed);
    assert.deepEqual((await git(['show', '-s', '--format=%P', 'HEAD'])).split(' '), [
      before,
      branchTip,
    ]);
    assert.equal(
      await readFile(path.join(repo, 'NATIVE-MERGE.md'), 'utf8'),
      '# Original native merge\n'
    );
    await owning.finishNativeSession(native.sessionId);
    assert.equal(interactionGate.isOpen(native.sessionId), false);
    assert.equal(
      peekProjector(native.sessionId)
        ?.replayFrom(0)
        .filter((event) => event.type === 'turn_end').length,
      1
    );
    return;
  }
  const native = await owning.bootNativeAgent();
  const repo = owning.repos.repoPath(owning.roomId),
    ceiling = owning.repos.homeDir(owning.roomId);
  const git = (args: string[], cwd = repo) => fixtureGit(args, cwd, ceiling);
  await writeFile(path.join(repo, 'PLAN.md'), '# Actual room plan\n');
  await git(['add', '--all']);
  await git([
    '-c',
    'user.name=Owner',
    '-c',
    'user.email=owner@dorkos.local',
    'commit',
    '-q',
    '-m',
    'plan',
  ]);
  const main = await git(['rev-parse', 'HEAD']);
  const posted = owning.subsystem.service.post(owning.roomId, {
    authorId: owning.operator.id,
    text: 'Please inspect the room plan.',
    mentions: [native.authorId],
  });
  await owning.subsystem.service.triggersIdle();
  const slug = RoomWorktreeManager.slugFor('Native Agent', native.agentPath);
  const copy = path.join(owning.repos.worktreesPath(owning.roomId), slug);
  assert.equal(await git(['branch', '--show-current'], copy), roomWorktreeBranch(slug));
  assert.equal(await git(['rev-parse', 'HEAD'], copy), main);
  assert.equal(await readFile(path.join(copy, 'PLAN.md'), 'utf8'), '# Actual room plan\n');
  const metadata = owning.db
    .select()
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, native.sessionId))
    .get();
  assert.equal(metadata?.agentPath, native.agentPath);
  assert.equal(
    owning.subsystem.store.getRoomSession(owning.roomId, native.authorId),
    native.sessionId
  );
  const events = owning.db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, native.sessionId))
    .all()
    .map((row) => SessionEventSchema.parse(JSON.parse(row.payload)));
  assert.equal(events.filter((event) => event.type === 'turn_start').length, 1);
  assert.equal(events.filter((event) => event.type === 'turn_end').length, 1);
  assert.equal(
    owning.db.get<{ n: number }>(
      sql`SELECT count(*) AS n FROM room_turn_spend WHERE room_id=${owning.roomId}`
    )?.n,
    1
  );
  assert.equal(posted.body.text, 'Please inspect the room plan.');
  assert.deepEqual(posted.mentions, [native.authorId]);
}

let failed = false;
let first: unknown;
const remember = (cause: unknown) => {
  if (!failed) {
    failed = true;
    first = cause;
  }
};
const caseName = process.argv[2] ?? 'launch';
if (
  process.argv.length > 3 ||
  ![
    'launch',
    'runner-no-binding',
    'runner-unstarted-cancel-data',
    'runner-started-failed-data',
    'runner-delayed-start-data',
    'runner-own-tail-data',
    'runner-foreign-words-data',
    'runner-own-activity-data',
    'runner-foreign-approval-data',
    'runner-busy-disposition',
    'runner-stop-state-pair',
    'runner-approval-ended',
    'runner-approval-failed',
    'runner-approval-standing',
    'runner-approval-quick',
    'runner-late-answer',
    'runner-half-answer',
    'runner-clamped-ceiling',
    'runner-unclosed-ceiling',
    'runner-completion',
    'runner-stream-text',
    'runner-empty-text',
    'runner-content',
    'runner-paragraphs',
    'runner-token-counts',
    'runner-failed',
    'runner-quiet',
    'runner-no-files',
    'runner-framing',
    'runner-durable-error',
    'runner-durable-log',
    'runner-foreign-lock',
    'runner-optional-posting',
    'runner-false-posting',
    'runner-posting-home',
    'runner-turn-boundary',
    'runner-home-grants-attachments',
    'runner-projection-before-provider',
    'runner-measured-launch-context',
    'runner-accepted-no-files-context',
    'runner-bound-launch-context',
    'runner-owner-before-refresh',
    'runner-missing-runtime',
    'runner-no-fallback',
    'runner-observer-failure',
    'runner-bound-codex',
    'runner-first-codex',
    'runner-owner-before-provider',
    'runner-placeholder-codex',
    'runner-bound-halt',
    'runner-canonical-halt',
    'runner-canonical-owner',
    'runner-canonical-level',
    'runner-confirmed-stop',
    'runner-unconfirmed-stop',
    'runner-owner-write-failure',
    'runner-desk-guard',
    'runner-released-halt',
    'runner-new-then-reused',
    'runner-first-captured-halt',
    'runner-preaccepted-halt',
    'runner-remembered-halt',
    'runner-boot-stop',
    'runner-missing-halt',
    'merge-capability',
    'merge-config-refusal',
    'refresh-story',
    'placed-tip-change',
    'placed-dirty-counts',
    'refresh-baselines',
    'retired-id-busy',
    'busy-read-unknown',
    'second-bound-dispatcher-busy',
    'second-bound-runtime-lock',
    'app-resume-home',
    'app-resume-copy',
    'app-resume-label',
    'app-resume-credential-revoked',
    'app-resume-target-retired',
    'app-resume-no-repo',
    'app-resume-config-off',
    'app-resume-opencode-copy',
  ].includes(caseName)
)
  throw new Error('Original native launch case is unknown');
const ownerWriteControl =
  caseName === 'runner-owner-write-failure'
    ? (
        await import('./room-original-native-runner-owner-write-control.js')
      ).makeOriginalRunnerOwnerWriteControl()
    : undefined;
const stopReceiptControl =
  caseName === 'runner-confirmed-stop' || caseName === 'runner-unconfirmed-stop'
    ? (
        await import('./room-original-native-runner-stop-receipt-control.js')
      ).makeOriginalRunnerStopReceiptControl()
    : undefined;
const canonicalHaltControl =
  caseName === 'runner-canonical-halt' ||
  caseName === 'runner-canonical-owner' ||
  caseName === 'runner-canonical-level'
    ? (
        await import('./room-original-native-runner-canonical-halt-control.js')
      ).makeOriginalRunnerCanonicalHaltControl()
    : undefined;
const codexControl =
  caseName === 'runner-bound-codex' ||
  caseName === 'runner-first-codex' ||
  caseName === 'runner-owner-before-provider' ||
  caseName === 'runner-placeholder-codex' ||
  caseName === 'runner-bound-halt' ||
  caseName === 'runner-released-halt' ||
  caseName === 'runner-new-then-reused'
    ? (
        await import('./room-original-native-runner-codex-control.js')
      ).makeOriginalRunnerCodexControl()
    : undefined;
const launchContextControl =
  caseName === 'runner-bound-launch-context' || caseName === 'runner-owner-before-refresh'
    ? (
        await import('./room-original-native-runner-context-control.js')
      ).makeOriginalRunnerLaunchContextControl()
    : undefined;
const projectionOrderControl =
  caseName === 'runner-projection-before-provider'
    ? (
        await import('./room-original-native-runner-context-control.js')
      ).makeOriginalRunnerProjectionOrderControl()
    : undefined;
const captureControl =
  caseName === 'runner-first-captured-halt' ||
  caseName === 'runner-preaccepted-halt' ||
  caseName === 'runner-remembered-halt' ||
  caseName === 'runner-boot-stop'
    ? (
        await import('./room-original-native-runner-capture-control.js')
      ).makeOriginalRunnerCapturedHaltControl(caseName)
    : undefined;
let observedRuns = 0;
let observedRunPending = false;
let observedEntryId: string | undefined;
let observedRun: OriginalRoomRunnerObservation | undefined;
const noBindingControl =
  caseName === 'runner-no-binding'
    ? (
        await import('./room-original-native-runner-no-binding-control.js')
      ).makeOriginalNativeNoBindingControl()
    : undefined;
const identityControl =
  caseName === 'runner-unstarted-cancel-data' ||
  caseName === 'runner-started-failed-data' ||
  caseName === 'runner-delayed-start-data' ||
  caseName === 'runner-own-tail-data' ||
  caseName === 'runner-foreign-words-data' ||
  caseName === 'runner-own-activity-data' ||
  caseName === 'runner-foreign-approval-data'
    ? (
        await import('./room-original-native-runner-identity-control.js')
      ).makeOriginalNativeReplyIdentityControl()
    : undefined;
const approvalControl =
  caseName === 'runner-approval-quick' ||
  caseName === 'runner-approval-standing' ||
  caseName === 'runner-approval-failed' ||
  caseName === 'runner-approval-ended'
    ? (
        await import('./room-original-native-runner-approval-control.js')
      ).makeOriginalNativeApprovalControl()
    : undefined;
const replyWaitControl =
  caseName === 'runner-late-answer' ||
  caseName === 'runner-half-answer' ||
  caseName === 'runner-clamped-ceiling' ||
  caseName === 'runner-unclosed-ceiling'
    ? (
        await import('./room-original-native-runner-wait-control.js')
      ).makeOriginalRunnerNativeWaitControl()
    : undefined;
const setupControl =
  caseName === 'second-bound-dispatcher-busy' || caseName === 'second-bound-runtime-lock'
    ? await import('./room-original-native-second-bound-controls.js')
    : caseName === 'retired-id-busy' || caseName === 'busy-read-unknown'
      ? await import('./room-original-native-placement-controls.js')
      : caseName === 'refresh-story'
        ? await import('./room-original-native-refresh-story.js')
        : undefined;
// This gate owns no fixture or native authority. Install cancellation before signaling readiness.
await new Promise<void>((resolve, reject) => {
  const cleanup = () => {
    process.off('message', onMessage);
    process.off('disconnect', onDisconnect);
  };
  const cancel = () => {
    cleanup();
    const cause = new Error('Original native child closed before setup started');
    remember(cause);
    if (process.connected) process.disconnect();
    reject(first);
  };
  const onDisconnect = () => cancel();
  const onMessage = (message: unknown) => {
    if (message === 'close') cancel();
    else if (message === 'start-setup') {
      cleanup();
      resolve();
    }
  };
  process.on('message', onMessage);
  process.once('disconnect', onDisconnect);
  if (!process.connected) cancel();
  else
    process.send?.({ phase: 'bootstrap-ready' }, (cause) => {
      if (cause) {
        remember(cause);
        cancel();
      }
    });
});
let initializationCancelled = false;
const cancelInitialization = (message?: unknown) => {
  if (message !== undefined && message !== 'close') return;
  initializationCancelled = true;
  remember(new Error('Original native child closed during fixture initialization'));
};
const disconnectInitialization = () => cancelInitialization();
process.on('message', cancelInitialization);
process.once('disconnect', disconnectInitialization);
if (!process.connected) cancelInitialization();
if (initializationCancelled) {
  process.off('message', cancelInitialization);
  process.off('disconnect', disconnectInitialization);
  throw first;
}
originalConstructionPhase('fixture-start');
const owning = await createOriginalNativeLaunchFixture(
  caseName === 'runner-no-binding'
    ? {
        observeRun: noBindingControl!.observeRun,
        observeOriginalLaunch: noBindingControl!.observeOriginalLaunch,
      }
    : caseName === 'runner-unstarted-cancel-data' ||
        caseName === 'runner-started-failed-data' ||
        caseName === 'runner-delayed-start-data' ||
        caseName === 'runner-own-tail-data' ||
        caseName === 'runner-foreign-words-data' ||
        caseName === 'runner-own-activity-data' ||
        caseName === 'runner-foreign-approval-data'
      ? {
          seed: false,
          observeRun: identityControl!.observeRun,
          releaseProvider: identityControl!.releaseProvider,
          replyBounds: { waitMs: () => 60_000, waitingGraceMs: () => 0 },
        }
      : caseName === 'runner-approval-quick' ||
          caseName === 'runner-approval-standing' ||
          caseName === 'runner-approval-failed' ||
          caseName === 'runner-approval-ended'
        ? {
            seed: false,
            observeRun: approvalControl!.observeRun,
            releaseProvider: approvalControl!.releaseProvider,
            replyBounds: {
              waitMs: () => 10 * 60_000,
              waitingGraceMs: () =>
                caseName === 'runner-approval-standing' || caseName === 'runner-approval-failed'
                  ? 1
                  : 60_000,
            },
          }
        : caseName === 'runner-late-answer' ||
            caseName === 'runner-half-answer' ||
            caseName === 'runner-clamped-ceiling' ||
            caseName === 'runner-unclosed-ceiling'
          ? {
              seed: false,
              observeRun: replyWaitControl!.observeRun,
              releaseProvider: replyWaitControl!.releaseProvider,
              replyBounds:
                caseName === 'runner-clamped-ceiling'
                  ? { waitMs: () => 60_000, ceilingMs: () => 1 }
                  : caseName === 'runner-unclosed-ceiling'
                    ? { waitMs: () => 5, ceilingMs: () => 30 }
                    : { waitMs: () => 5 },
            }
          : caseName === 'runner-owner-write-failure'
            ? { observeRun: ownerWriteControl!.observeRun }
            : caseName === 'runner-confirmed-stop' || caseName === 'runner-unconfirmed-stop'
              ? {
                  observeRun: stopReceiptControl!.observeRun,
                  releaseProvider: stopReceiptControl!.releaseProvider,
                }
              : caseName === 'runner-canonical-halt' ||
                  caseName === 'runner-canonical-owner' ||
                  caseName === 'runner-canonical-level'
                ? {
                    observeRun: canonicalHaltControl!.observeRun,
                    releaseProvider: canonicalHaltControl!.releaseProvider,
                  }
                : caseName === 'runner-bound-launch-context' ||
                    caseName === 'runner-owner-before-refresh'
                  ? {
                      nativeRuntimeType: 'codex',
                      observeRun: launchContextControl!.observeRun,
                      observeOriginalLaunch: launchContextControl!.observeOriginalLaunch,
                      createNativeRuntime: launchContextControl!.createRuntime,
                      releaseProvider: launchContextControl!.releaseProvider,
                    }
                  : caseName === 'runner-projection-before-provider'
                    ? { observeBeforeDispatch: projectionOrderControl!.observeBeforeDispatch }
                    : captureControl
                      ? {
                          observeRun: captureControl.observeRun,
                          roomConventions: captureControl.roomConventions,
                          releaseProvider: captureControl.releaseProvider,
                        }
                      : caseName === 'refresh-story'
                        ? { operatorName: 'Dorian', collectDebounceMs: 10 }
                        : caseName === 'runner-framing'
                          ? { roomTitle: '#backend', operatorName: 'Dorian' }
                          : caseName === 'app-resume-no-repo' ||
                              caseName === 'runner-no-files' ||
                              caseName === 'runner-accepted-no-files-context'
                            ? { seed: false }
                            : caseName === 'runner-bound-codex' ||
                                caseName === 'runner-first-codex' ||
                                caseName === 'runner-owner-before-provider' ||
                                caseName === 'runner-placeholder-codex' ||
                                caseName === 'runner-bound-halt' ||
                                caseName === 'runner-released-halt' ||
                                caseName === 'runner-new-then-reused'
                              ? {
                                  nativeRuntimeType: 'codex',
                                  observeRun: codexControl!.observeRun,
                                  createNativeRuntime: codexControl!.createRuntime,
                                  releaseProvider: codexControl!.releaseProvider,
                                }
                              : caseName === 'runner-missing-runtime' ||
                                  caseName === 'runner-no-fallback' ||
                                  caseName === 'runner-missing-halt' ||
                                  caseName === 'runner-observer-failure' ||
                                  caseName === 'runner-foreign-lock' ||
                                  caseName === 'runner-busy-disposition'
                                ? {
                                    observeRun: (entryId, observation) => {
                                      observedRuns++;
                                      observedEntryId = entryId;
                                      observedRun = observation;
                                      observedRunPending = true;
                                      void observation.completion.then(() => {
                                        if (observedRun === observation) observedRunPending = false;
                                      });
                                      if (caseName === 'runner-observer-failure') throw undefined;
                                    },
                                  }
                                : {}
)
  .catch((cause: unknown) => {
    remember(cause);
    throw first;
  })
  .finally(() => {
    process.off('message', cancelInitialization);
    process.off('disconnect', disconnectInitialization);
  });
originalConstructionPhase('fixture-ready');
const setup: {
  refreshStory?: () => Promise<void>;
  retiredBusy?: () => Promise<void>;
  secondBound?: () => Promise<void>;
} = {};
let started = false;
let running: Promise<void> | undefined;
let setupPending: Promise<void> | undefined;
let closing: Promise<void> | undefined;
process.on('message', (message: unknown) => {
  if (message === 'run' && !started && !closing) {
    started = true;
    running = scenario().then(
      () => {
        process.send?.({ phase: 'result', ok: true });
      },
      (cause: unknown) => {
        remember(cause);
        process.send?.({ phase: 'result', ok: false });
      }
    );
  } else if (message === 'close') {
    close();
  }
});
function close(): void {
  if (closing) return;
  // Stop the actual Trigger/runtime before waiting for a held scenario.
  closing = (async () => {
    const stop = Promise.resolve().then(() => owning.stopNative());
    for (const result of await Promise.allSettled([stop, setupPending, running]))
      if (result.status === 'rejected') remember(result.reason);
    // Setup may finish acquiring its original native owner after the first stop.
    // Stop that exact owner again before the enclosing Db/root can close; its
    // original memo joins the same cancellation when it was already acquired.
    try {
      await owning.stopNative();
    } catch (cause) {
      remember(cause);
    }
    try {
      await owning.close();
    } catch (cause) {
      remember(cause);
    }
    if (failed) {
      console.error(first);
      process.exitCode = 1;
    }
    if (process.connected) process.disconnect();
  })();
}
process.on('disconnect', close);
if (initializationCancelled || !process.connected) {
  close();
  await closing;
  throw failed ? first : new Error('Original native child disconnected during initialization');
}
originalConstructionPhase('setup-start');
try {
  setupPending = (async () => {
    if (caseName === 'second-bound-dispatcher-busy' || caseName === 'second-bound-runtime-lock') {
      const repo = owning.repos.repoPath(owning.roomId);
      const ceiling = owning.repos.homeDir(owning.roomId);
      setup.secondBound = await (
        setupControl as typeof import('./room-original-native-second-bound-controls.js')
      ).prepareOriginalNativeSecondBoundBusyControl(
        owning,
        (args, cwd = repo) => fixtureGit(args, cwd, ceiling),
        caseName === 'second-bound-runtime-lock'
      );
    } else if (caseName === 'retired-id-busy' || caseName === 'busy-read-unknown') {
      const repo = owning.repos.repoPath(owning.roomId);
      const ceiling = owning.repos.homeDir(owning.roomId);
      setup.retiredBusy = await (
        setupControl as typeof import('./room-original-native-placement-controls.js')
      ).prepareOriginalNativeRetiredIdBusyControl(
        owning,
        (args, cwd = repo) => fixtureGit(args, cwd, ceiling),
        caseName === 'busy-read-unknown'
      );
    } else if (caseName === 'refresh-story') {
      const repo = owning.repos.repoPath(owning.roomId);
      const ceiling = owning.repos.homeDir(owning.roomId);
      setup.refreshStory = await (
        setupControl as typeof import('./room-original-native-refresh-story.js')
      ).prepareOriginalNativeRefreshStory(owning, (args, cwd = repo) =>
        fixtureGit(args, cwd, ceiling)
      );
    }
  })();
  // Observe setup refusal immediately; close joins the original promise below.
  void setupPending.catch(remember);
  await setupPending;
} catch (cause) {
  remember(cause);
  close();
  await closing;
  throw first;
}
if (closing) throw new Error('Original native child closed during setup');
originalConstructionPhase('setup-ready');
process.send?.({ phase: 'ready' });
