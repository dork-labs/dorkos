/**
 * A Room turn stands at its agent's home and reaches its own Room copy through
 * exact grants. Real Git, the original owning HTTP composition, original Room
 * trigger/runner and constructor-owned TestMode native entry are exercised.
 * Only model output is local TestMode output; copied runner/request DTOs never
 * authorize placement. The temporary installation remains inside another Git
 * repository, preserving the original discovery trap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
import { access, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sessionMetadata } from '@dorkos/db';
import request from '@dorkos/test-utils/supertest';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import { formatRoomContext } from '../../../runtimes/shared/room-context-block.js';
import { LocalRoomAttachmentStore } from '../../attachments/local-room-attachment-store.js';
import { setRoomAttachmentStores } from '../../attachments/attachment-stores.js';
import { projectedAttachmentPath } from '../../attachments/attachment-paths.js';
import { configManager } from '../../../core/config-manager.js';
import { runtimeRegistry, readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { interactionGate } from '../../../runtimes/test-mode/interaction-gate.js';
import {
  readTestModeOriginalPlacementOptions,
  readTestModeOriginalPreparedRoomContext,
  readTestModeOriginalScenarioCounts,
} from '../../../runtimes/test-mode/test-mode-runtime.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import {
  disposeProjector,
  getOrCreateProjector,
  peekProjector,
} from '../../../session/session-state-projector.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import { createOriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';
import {
  fixtureGit as runGit,
  removeFixtureTree,
  silenceGitAutoMaintenance,
} from './fixture-git.js';

const DAY_MS = 24 * 60 * 60 * 1000;
type Fixture = Awaited<ReturnType<typeof createOriginalNativeLaunchFixture>>;
type Target = Awaited<ReturnType<Fixture['bootNativePair']>>[number];
type ObservedTurn = {
  entryId: string;
  cwd: string;
  agentPath: string;
  worktree: string | null;
  additionalDirectories: readonly Readonly<{ path: string; access: 'read' | 'write' }>[];
  roomContext: RoomContextData;
};

describe('a room turn stands at home with the room’s files granted', () => {
  let scratch: string;
  let native: Awaited<ReturnType<typeof createOriginalNativeLaunchFixture>>;
  let acquired: boolean;
  let nativeConstructionAttempted: boolean;
  let targets: Awaited<ReturnType<typeof native.bootNativePair>>;
  let nowMs: number;
  let otherRoomId: string | undefined;
  let otherSessionId: string | undefined;
  const observations = new Map<
    string,
    { sessionId: string; controller: AbortController; stream: AsyncIterable<SessionEvent> }
  >();
  const observationClosures = new Set<Promise<void>>();
  const turns: ObservedTurn[] = [];
  const launches: Array<Readonly<{ sessionId: string; roomId: string }>> = [];

  beforeEach(async () => {
    acquired = false;
    nativeConstructionAttempted = false;
    otherRoomId = undefined;
    otherSessionId = undefined;
    turns.length = 0;
    launches.length = 0;
    silenceGitAutoMaintenance();
    scratch = await mkdtemp(path.join(await realpath(tmpdir()), 'dorkos-room-cwd-'));
    await runGit(['init', '-b', 'main', '--quiet', '.'], scratch, scratch);
    await writeFile(path.join(scratch, '.gitignore'), '*\n');
    await runGit(['add', '-f', '.gitignore'], scratch, scratch);
    await runGit(
      ['-c', 'user.name=E', '-c', 'user.email=e@dorkos.local', 'commit', '-q', '-m', 'base'],
      scratch,
      scratch
    );
    nowMs = Date.now();
    nativeConstructionAttempted = true;
    native = await createOriginalNativeLaunchFixture({
      seed: false,
      homeParent: scratch,
      now: () => nowMs,
      maintenance: true,
      observeOriginalLaunch: (data) => launches.push(data),
    });
    acquired = true;
    configManager.set('rooms', { ...configManager.get('rooms'), maxConcurrentTurnsPerAgent: 1 });
    targets = await native.bootNativePair();
  });

  afterEach(async () => {
    // Start same-owner cancellation for the extra Room before the original
    // fixture joins its own native and file owners. Any uncertain close keeps
    // the enclosing root; no copied token or signal substitutes for closure.
    let failed = false,
      first: unknown;
    const remember = (cause: unknown) => {
      if (!failed) {
        failed = true;
        first = cause;
      }
    };
    // A rejected constructor preserves setup cause even if its owned close fails.
    // Retain the enclosing root unless construction never began or close joins.
    // Abort and join only our read-only streams before cancelling native owners.
    for (const observation of observations.values()) observation.controller.abort();
    await Promise.all(observationClosures);
    observations.clear();
    let closed = !nativeConstructionAttempted;
    if (acquired) {
      const selected = runtimeRegistry.get('claude-code');
      const stops = [
        Promise.resolve().then(() => {
          if (!otherRoomId) return;
          return native.subsystem.service.haltRoom(otherRoomId, native.operator.id);
        }),
        Promise.resolve().then(() => {
          if (!otherSessionId) return;
          return selected?.interruptQuery(otherSessionId);
        }),
      ];
      for (const result of await Promise.allSettled(stops))
        if (result.status === 'rejected') remember(result.reason);
      try {
        await native.close();
        closed = true;
      } catch (cause) {
        remember(cause);
      }
      if (closed && otherSessionId) {
        try {
          scenarioStore.clearSession(otherSessionId);
          disposeProjector(otherSessionId);
        } catch (cause) {
          remember(cause);
        }
      }
    }
    try {
      vi.unstubAllEnvs();
    } catch (cause) {
      remember(cause);
    }
    if (closed && !failed) {
      try {
        await removeFixtureTree(scratch);
      } catch (cause) {
        remember(cause);
      }
    }
    if (failed) throw first;
  });

  const ana = () => targets[0]!;
  const bo = () => targets[1]!;
  const copyFor = (target: Target) =>
    path.join(
      native.repos.worktreesPath(native.roomId),
      RoomWorktreeManager.slugFor(target === ana() ? 'Ana' : 'Bo', target.agentPath)
    );

  async function enable(): Promise<void> {
    const response = await request(native.server)
      .post(`/api/rooms/${native.roomId}/repo`)
      .set('Authorization', `Bearer ${native.ownerKey.key}`);
    expect(response.status).toBe(201);
  }

  function post(target: Target, text: string, roomId = native.roomId, attachmentIds?: string[]) {
    const sessionId = roomId === native.roomId ? target.sessionId : otherSessionId;
    expect(sessionId).toBeDefined();
    // The original trigger feeds this same projector. Capture its cursor BEFORE
    // posting; durable replay retains events even if observe starts after launch.
    const projector = getOrCreateProjector(sessionId!, target.agentPath, { persist: 'history' });
    const controller = new AbortController();
    const stream = projector.subscribe(projector.getCursor(), controller.signal);
    try {
      const entry = native.subsystem.service.post(roomId, {
        authorId: native.operator.id,
        mentions: [target.authorId],
        text,
        ...(attachmentIds ? { attachmentIds } : {}),
      });
      observations.set(entry.id, { sessionId: sessionId!, controller, stream });
      return entry;
    } catch (cause) {
      controller.abort();
      throw cause;
    }
  }

  async function observe(
    target: Target,
    entryId: string,
    sessionId = target.sessionId
  ): Promise<ObservedTurn> {
    const selected = runtimeRegistry.get('claude-code');
    expect(selected).toBeDefined();
    const original = readOriginalRegisteredRuntime(selected!);
    expect(original).toBeDefined();
    const observation = observations.get(entryId);
    expect(observation?.sessionId).toBe(sessionId);
    if (!observation) throw new Error('Original Room observation was not captured before post.');
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    observationClosures.add(closed);
    try {
      let ready = false;
      for await (const event of observation.stream) {
        if (
          interactionGate.isOpen(sessionId) &&
          readTestModeOriginalPlacementOptions(original!, sessionId) !== undefined &&
          readTestModeOriginalPreparedRoomContext(original!, sessionId)?.triggerEntryId === entryId
        ) {
          // Opening events precede warm-echo's awaitStep registration. Observe
          // that same original gate's queued barrier without consuming a step.
          await interactionGate.waitForStep(sessionId, observation.controller.signal);
          ready = true;
          break;
        }
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'turn_end')
          throw new Error(
            `Original Room turn ended before native readiness: ${event.terminalReason ?? 'closed'}`
          );
      }
      if (!ready) throw new Error('Original Room readiness stream closed before native entry.');
      expect(interactionGate.isOpen(sessionId)).toBe(true);
      expect(readTestModeOriginalPlacementOptions(original!, sessionId)).toBeDefined();
      expect(readTestModeOriginalPreparedRoomContext(original!, sessionId)?.triggerEntryId).toBe(
        entryId
      );
    } finally {
      observation.controller.abort();
      observations.delete(entryId);
      resolveClosed();
      observationClosures.delete(closed);
    }
    const options = readTestModeOriginalPlacementOptions(original!, sessionId)!;
    const roomContext = readTestModeOriginalPreparedRoomContext(original!, sessionId)!;
    expect(options.cwd).toBe(target.agentPath);
    expect(options.forAgent).toBe(target.agentPath);
    const observed = {
      entryId,
      cwd: options.cwd!,
      agentPath: options.forAgent!,
      worktree: roomContext.files?.worktreePath ?? null,
      additionalDirectories: options.additionalDirectories ?? [],
      roomContext,
    };
    turns.push(observed);
    return observed;
  }

  async function turn(
    target: Target,
    text: string,
    attachmentIds?: string[]
  ): Promise<ObservedTurn> {
    native.holdNativeSession(target.sessionId);
    const entry = post(target, text, native.roomId, attachmentIds);
    const observed = await observe(target, entry.id);
    await native.finishNativeSession(target.sessionId);
    return observed;
  }

  it('stands the turn at home and grants the agent’s copy of the room’s files', async () => {
    await enable();
    const observed = await turn(ana(), 'What is left?');
    expect(turns).toHaveLength(1);
    expect(observed.cwd).toBe(ana().agentPath);
    expect(observed.agentPath).toBe(ana().agentPath);
    expect(observed.worktree).toBe(copyFor(ana()));
    const slug = RoomWorktreeManager.slugFor('Ana', ana().agentPath);
    await expect(
      runGit(['branch', '--show-current'], observed.worktree!, native.repos.homeDir(native.roomId))
    ).resolves.toBe(`room/${slug}`);
    const repo = realpathSync(native.repos.repoPath(native.roomId));
    const git = path.join(repo, '.git');
    expect(observed.additionalDirectories).toEqual([
      { path: realpathSync(copyFor(ana())), access: 'write' },
      { path: repo, access: 'read' },
      { path: path.join(git, 'objects'), access: 'write' },
      { path: path.join(git, 'refs', 'heads', 'room'), access: 'write' },
      { path: path.join(git, 'logs', 'refs', 'heads', 'room'), access: 'write' },
      { path: path.join(git, 'worktrees', slug), access: 'write' },
    ]);
    // A real original native entry consumed the protected preparation, rather
    // than merely receiving a copied prepareLaunch callback from a fake runner.
    expect(launches).toEqual([{ sessionId: ana().sessionId, roomId: native.roomId }]);
  });

  it('leaves a room with no files of its own exactly where it was', async () => {
    const observed = await turn(ana(), 'What is left?');
    expect(turns).toHaveLength(1);
    expect(observed.cwd).toBe(ana().agentPath);
    expect(observed.cwd).toBe(observed.agentPath);
    expect(observed.additionalDirectories).toEqual([]);
    expect(observed.worktree).toBeNull();
    expect(observed.roomContext).not.toHaveProperty('files');
    expect(existsSync(native.repos.worktreesPath(native.roomId))).toBe(false);
  });

  it('tells the turn where its own copy is, and how far the room has moved', async () => {
    await enable();
    const observed = await turn(ana(), 'What is left?');
    const files = observed.roomContext.files;
    expect(files).toBeDefined();
    expect(files!.worktreePath).toBe(copyFor(ana()));
    expect(files!.worktreePath).toBe(observed.worktree);
    expect(files!.worktreePath).not.toBe(observed.cwd);
    expect(files!.repoPath).toBe(native.repos.repoPath(native.roomId));
    expect(files!.branch).toBe(`room/${RoomWorktreeManager.slugFor('Ana', ana().agentPath)}`);
    expect(files).toMatchObject({ ahead: 0, behind: 0 });
  });

  it('counts the commits the room gained while an agent was away', async () => {
    await enable();
    await turn(ana(), 'What is left?');
    const repo = native.repos.repoPath(native.roomId);
    // The ordinary launch fast-forwards a clean copy. Keep genuine local work
    // so the original refresh holds it and reports the two commits still owed.
    const localPath = path.join(copyFor(ana()), 'ROOM.md');
    const localDraft = (await readFile(localPath, 'utf8')) + '\nAgent work not yet committed.\n';
    await writeFile(localPath, localDraft);
    for (const name of ['CHECKLIST.md', 'NOTES.md']) {
      await writeFile(path.join(repo, name), `# ${name}\n`);
      await runGit(['add', name], repo, native.repos.homeDir(native.roomId));
      await runGit(
        ['-c', 'user.name=E', '-c', 'user.email=e@dorkos.local', 'commit', '-q', '-m', name],
        repo,
        native.repos.homeDir(native.roomId)
      );
    }
    const observed = await turn(ana(), 'And now?');
    expect(observed.roomContext.files).toMatchObject({
      behind: 2,
      ahead: 0,
      refresh: { kind: 'held', reason: 'changes' },
    });
    expect(await readFile(localPath, 'utf8')).toBe(localDraft);
  });

  it('tells a room with no files of its own nothing about files', async () => {
    const observed = await turn(ana(), 'What is left?');
    expect(observed.roomContext).not.toHaveProperty('files');
  });

  it('gives each agent its own working copy, and reuses it across turns', async () => {
    await enable();
    await turn(ana(), 'What is left?');
    await turn(bo(), 'What is left?');
    await turn(ana(), 'And now?');
    const forAna = turns.filter((entry) => entry.agentPath === ana().agentPath);
    const forBo = turns.filter((entry) => entry.agentPath === bo().agentPath);
    expect(forAna.length).toBeGreaterThanOrEqual(2);
    expect(forBo.length).toBeGreaterThanOrEqual(1);
    expect(new Set(forAna.map((entry) => entry.worktree)).size).toBe(1);
    expect(forAna[0]!.worktree).not.toBe(forBo[0]!.worktree);
    expect(new Set(forAna.map((entry) => entry.cwd))).toEqual(new Set([ana().agentPath]));
    expect(await readdir(native.repos.worktreesPath(native.roomId))).toHaveLength(2);
  });

  it('puts the file the model is told about under the folder it stands in: its home', async () => {
    await enable();
    const attachments = new LocalRoomAttachmentStore(native.dir);
    const { url } = await attachments.put(native.roomId, 'att1', 'txt', Buffer.from('the notes'));
    native.subsystem.attachments.create(
      {
        roomId: native.roomId,
        id: 'att1',
        authorId: native.operator.id,
        name: 'notes.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        size: 9,
        preview: null,
        url,
      },
      new Date().toISOString()
    );
    setRoomAttachmentStores({ attachments, rows: native.subsystem.attachments });
    const observed = await turn(ana(), 'Read this.', ['att1']);
    expect(turns).toHaveLength(1);
    expect(observed.roomContext.triggerAttachments).toHaveLength(1);
    const landed = path.join(
      observed.cwd,
      projectedAttachmentPath(observed.entryId, 'att1', 'notes.txt')
    );
    expect(landed.startsWith(ana().agentPath + path.sep)).toBe(true);
    expect(landed.startsWith(copyFor(ana()) + path.sep)).toBe(false);
    await expect(access(landed)).resolves.toBeUndefined();
    await expect(readFile(landed, 'utf8')).resolves.toBe('the notes');
    expect(formatRoomContext(observed.roomContext, { nonce: 'aaaa1111' })).toContain(landed);
  });

  it('still holds another room’s message while the agent works in a worktree', async () => {
    await enable();
    const other = native.subsystem.service.createRoom(
      {
        kind: 'channel',
        title: 'Backend',
        members: [],
        agentPaths: [ana().agentPath],
      },
      native.operator.id
    );
    // Distinct genuine sessions for the same actual agent make this the
    // per-agent ceiling, rather than a same-session runtime-lock test.
    otherRoomId = other.id;
    otherSessionId = randomUUID();
    native.db
      .insert(sessionMetadata)
      .values({
        sessionId: otherSessionId,
        agentPath: ana().agentPath,
        runtime: 'claude-code',
        createdAt: new Date().toISOString(),
      })
      .run();
    const selected = runtimeRegistry.get('claude-code');
    expect(selected).toBeDefined();
    selected!.ensureSession(otherSessionId, { cwd: ana().agentPath, permissionMode: 'default' });
    expect(
      native.subsystem.store.bindRoomSession(
        other.id,
        ana().authorId,
        otherSessionId,
        new Date().toISOString()
      )
    ).toBe(otherSessionId);
    const beforeNative = readTestModeOriginalScenarioCounts(selected!);
    expect(beforeNative).toBeDefined();
    const nativeStarts = beforeNative!.scenarioStarts;
    scenarioStore.setForSession(otherSessionId, 'warm-echo');
    expect(otherSessionId).not.toBe(ana().sessionId);
    native.holdNativeSession(ana().sessionId);
    const first = post(ana(), 'What is left?');
    const observed = await observe(ana(), first.id);
    expect(observed.worktree).toBe(copyFor(ana()));
    const second = post(ana(), 'And here?', other.id);
    await vi.waitFor(() => expect(native.subsystem.service.listHolds()).toHaveLength(1));
    expect(launches).toHaveLength(1);
    expect(readTestModeOriginalScenarioCounts(selected!)).toEqual({
      scenarioStarts: nativeStarts + 1,
    });
    expect(native.subsystem.service.listBusyAgentPaths()).toContain(ana().agentPath);
    // Release the first actual stream without joining the room-wide idle drain:
    // that drain includes the held successor, which must get its own barrier.
    expect(interactionGate.step(ana().sessionId)).toBe(true);
    const next = await observe(ana(), second.id, otherSessionId);
    // The callback observes copy-refresh launches only; this no-files Room
    // correctly has none. Count both actual once-start native entries instead.
    expect(launches).toHaveLength(1);
    expect(readTestModeOriginalScenarioCounts(selected!)).toEqual({
      scenarioStarts: nativeStarts + 2,
    });
    expect(next.roomContext.room.id).toBe(other.id);
    expect(next.cwd).toBe(ana().agentPath);
    expect(next.worktree).toBeNull();
    expect(interactionGate.step(otherSessionId)).toBe(true);
    await native.subsystem.service.triggersIdle();
    scenarioStore.clearSession(ana().sessionId);
    scenarioStore.clearSession(otherSessionId);
    await vi.waitFor(() => {
      for (const id of [ana().sessionId, otherSessionId!]) {
        expect(isTurnInFlight(id, selected!)).toBe(false);
        expect(peekProjector(id)?.getStatus().lifecycle).toBe('idle');
      }
    });
    expect(native.subsystem.service.listHolds()).toEqual([]);
  });

  it('spares an ancient worktree that a live turn is working on', async () => {
    await enable();
    native.holdNativeSession(ana().sessionId);
    const entry = post(ana(), 'What is left?');
    const observed = await observe(ana(), entry.id);
    expect(observed.worktree).toBe(copyFor(ana()));
    // The original manager's injected epoch advances beyond every actual commit
    // and mtime while the genuine native claim remains held. No fake busy DTO.
    nowMs += 40 * DAY_MS;
    expect(native.subsystem.service.listBusyAgentPaths()).toContain(ana().agentPath);
    expect(native.reconciler).toBeDefined();
    const swept = await native.reconciler!.reconcile();
    expect(swept.worktrees).toEqual({ reaped: 0, reapedTreeKeptBranch: 0, spared: 1, stranded: 0 });
    expect(existsSync(observed.worktree!)).toBe(true);
    await native.finishNativeSession(ana().sessionId);
    expect(native.subsystem.service.listBusyAgentPaths()).toEqual([]);
  });
});
