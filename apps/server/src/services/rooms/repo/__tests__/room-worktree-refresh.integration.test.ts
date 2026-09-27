/**
 * The turn-start refresh end to end, over real git (spec `agent-home-desk`
 * §11 "Integration", second half).
 *
 * The real store, repo service, worktree manager, merge service, person file
 * editor and trigger dispatcher. Only the turn runner stands in (a model call
 * otherwise), and it does what the message dispatcher does at launch: run the
 * turn's launch step and put its files section into the room context before
 * the context is rendered.
 *
 * The story: Ana commits in her copy and merges → Bo's next turn finds his
 * clean copy brought up to date and is told so → Bo, with an uncommitted change
 * to a file Ana changes again, is held and told about the overlap → a person
 * edits ROOM.md, which posts one quiet entry and wakes nobody → Bo's next turn
 * names that person in its heads-up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import type { RoomContextData, RoomContextFiles } from '@dorkos/shared/additional-context';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { formatRoomContext } from '../../../runtimes/shared/room-context-block.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
  type ScriptedTurnRunner,
} from '../../__tests__/room-test-harness.js';
import type { RoomTurnRequest, RoomTurnResult } from '../../room-turn-port.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import { RoomRepoService } from '../room-repo-service.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import { RoomMergeService } from '../room-merge-service.js';
import { RoomFileEditor } from '../room-file-editor.js';
import { RoomFilesService } from '../room-files.js';
import { runGit } from '../room-repo-git.js';
import { removeFixtureTree, silenceGitAutoMaintenance } from './fixture-git.js';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { editBaselineStore } from '../../../diff/index.js';

/** One launched turn: who it was for, and the room context it launched with. */
interface Launched {
  agentPath: string;
  files: RoomContextFiles | undefined;
  context: RoomContextData;
}

describe('an agent’s copy of the room’s files is brought up to date at turn start', () => {
  let scratch: string;
  let dorkHome: string;
  let anaPath: string;
  let boPath: string;
  let harness: RoomHarness;
  let repos: RoomRepoService;
  let manager: RoomWorktreeManager;
  let repoStore: RoomRepoStore;
  let merges: RoomMergeService;
  let editor: RoomFileEditor;
  let launched: Launched[];

  /**
   * A runner that launches the way the message dispatcher does: the turn's
   * launch step first, its files section into the context, and only then the
   * turn — here, the scripted one.
   */
  function launchingRunner(inner: ScriptedTurnRunner): ScriptedTurnRunner {
    return {
      ...inner,
      async run(request: RoomTurnRequest): Promise<RoomTurnResult> {
        let context = request.roomContext;
        if (request.prepareLaunch) {
          const step = await request.prepareLaunch(request.sessionId ?? 'first-turn');
          if (step.files) context = { ...context, files: step.files };
        }
        launched.push({ agentPath: request.agentPath, files: context.files, context });
        return inner.run({ ...request, roomContext: context });
      },
    };
  }

  function standUp(): void {
    const mutex = new RoomRepoMutex();
    harness = createRoomHarness({
      agents: agentLookupFor({
        [anaPath]: { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
        [boPath]: { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
      }),
      runner: launchingRunner(scriptedRunner(() => null)),
      worktrees: () => manager,
    });
    repoStore = new RoomRepoStore(harness.db, dorkHome);
    repos = new RoomRepoService({
      store: repoStore,
      mutex,
      queueWaitMs: () => 5000,
      enabled: () => true,
      getRoom: (roomId) => harness.store.getRoom(roomId),
      isOwnerAuthor: (authorId) => authorId === harness.human,
      operatorGitName: () => 'Dorian',
      pinRoomMd: () => {},
      caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
    manager = new RoomWorktreeManager({
      store: repoStore,
      hasRepo: (roomId) => repos.hasRepo(roomId),
      listStrandedWorktrees: (roomId) => repos.listStrandedWorktrees(roomId),
      reapAfterDays: () => 14,
      busyAgentPaths: () => harness.service.listBusyAgentPaths(),
    });
    merges = new RoomMergeService({
      store: repoStore,
      mutex,
      enabled: () => true,
      mergeQueueWaitMs: () => 5000,
      requireMembership: (roomId, authorId) => harness.service.requireMembership(roomId, authorId),
      listAgentMembers: (roomId) => harness.service.listAgentMembers(roomId),
      listStrandedWorktrees: (roomId) => repos.listStrandedWorktrees(roomId),
      announce: (roomId, input) => harness.service.postMergeEvent(roomId, input),
      isOwnerAuthor: (authorId) => authorId === harness.human,
    });
    editor = new RoomFileEditor({
      store: repoStore,
      mutex,
      enabled: () => true,
      queueWaitMs: () => 5000,
      assertCanWriteFiles: (roomId, authorId) =>
        harness.service.assertCanWriteFiles(roomId, authorId),
      operatorGitName: () => 'Dorian',
      personName: () => null,
      announce: (roomId, input) => harness.service.postFileChangeEvent(roomId, input),
      uploadStagingRoot: () => path.join(scratch, 'staging'),
      files: new RoomFilesService({
        store: repoStore,
        hasRepo: (roomId) => repos.hasRepo(roomId),
        maxFileBytes: () => ROOM_REPO_CAP_DEFAULTS.maxFileBytes,
      }),
    });
  }

  async function openRoom(): Promise<RoomWithRoster> {
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Release train', members: [], agentPaths: [anaPath, boPath] },
      harness.human
    );
    await repos.enable(room.id, harness.human);
    return room;
  }

  /** Ask one agent something, and wait for every turn it causes. */
  async function ask(roomId: string, text: string): Promise<void> {
    harness.service.post(roomId, { authorId: harness.human, text });
    await harness.service.triggersIdle();
  }

  /** An agent's copy, as the manager names it. */
  function copyOf(roomId: string, agentPath: string, name: string): string {
    return path.join(repoStore.worktreesPath(roomId), RoomWorktreeManager.slugFor(name, agentPath));
  }

  /** What an agent does in its own copy with its own shell: write, commit. */
  async function commitIn(copy: string, file: string, text: string, message: string) {
    await writeFile(path.join(copy, file), text, 'utf-8');
    await runGit(['add', file], copy, dorkHome);
    await runGit(
      ['-c', 'user.name=Ana', '-c', 'user.email=ana@agent', 'commit', '-q', '-m', message],
      copy,
      dorkHome
    );
  }

  function authorIdOf(roomId: string, agentPath: string): string {
    return harness.service.listAgentMembers(roomId).find((m) => m.agentPath === agentPath)!
      .authorId;
  }

  function lastFor(agentPath: string): Launched {
    return launched.filter((turn) => turn.agentPath === agentPath).at(-1)!;
  }

  beforeEach(async () => {
    silenceGitAutoMaintenance();
    scratch = await mkdtemp(path.join(tmpdir(), 'dorkos-room-refresh-int-'));
    dorkHome = path.join(scratch, '.dork');
    await mkdir(dorkHome, { recursive: true });
    anaPath = path.join(scratch, 'agents', 'ana');
    boPath = path.join(scratch, 'agents', 'bo');
    await mkdir(anaPath, { recursive: true });
    await mkdir(boPath, { recursive: true });
    launched = [];
    standUp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeFixtureTree(scratch);
  });

  it('refreshes a clean copy, holds one with work in progress, and names who moved main', async () => {
    const room = await openRoom();
    await ask(room.id, '@ana @bo hello');
    const anaCopy = copyOf(room.id, anaPath, 'Ana');
    const boCopy = copyOf(room.id, boPath, 'Bo');

    // Ana works in her copy and merges.
    await commitIn(anaCopy, 'PLAN.md', '# plan v1\n', 'Plan v1');
    await merges.merge(room.id, authorIdOf(room.id, anaPath), { summary: 'Add the plan' });

    // Bo's next turn finds his clean copy brought up to date, and is told so.
    await ask(room.id, '@bo what changed?');
    const boTurn = lastFor(boPath);
    expect(boTurn.files?.refresh).toMatchObject({ kind: 'refreshed', paths: ['PLAN.md'] });
    expect(boTurn.files).toMatchObject({ behind: 0, ahead: 0 });
    expect(await readFile(path.join(boCopy, 'PLAN.md'), 'utf-8')).toBe('# plan v1\n');
    expect(formatRoomContext(boTurn.context)).toContain(
      'Your copy was brought up to date with main at the start of this turn (1 file changed).'
    );

    // Ana changes the plan again; Bo has an uncommitted change to the same file.
    await ask(room.id, '@ana keep going');
    await commitIn(anaCopy, 'PLAN.md', '# plan v2\n', 'Plan v2');
    await merges.merge(room.id, authorIdOf(room.id, anaPath), { summary: 'Plan v2' });
    await writeFile(path.join(boCopy, 'PLAN.md'), '# plan, Bo’s edit\n', 'utf-8');

    await ask(room.id, '@bo and now?');
    const held = lastFor(boPath);
    expect(held.files?.refresh).toMatchObject({
      kind: 'held',
      reason: 'changes',
      moved: {
        commits: [{ kind: 'merge', who: 'Ana', subject: 'Plan v2', files: ['PLAN.md'] }],
        overlap: ['PLAN.md'],
      },
    });
    // Bo's work in progress is exactly as he left it.
    expect(await readFile(path.join(boCopy, 'PLAN.md'), 'utf-8')).toBe('# plan, Bo’s edit\n');
    const block = formatRoomContext(held.context);
    expect(block).toContain('You have also changed one of those files (listed there).');
    expect(block).toContain('Files you have also changed: PLAN.md');

    // A person edits ROOM.md: one quiet entry, and no turn.
    const turnsBefore = launched.length;
    const entriesBefore = harness.store.listEntriesFrom(room.id, {
      afterSeq: 0,
      limit: 500,
    }).length;
    const head = await runGit(['rev-parse', 'HEAD'], repoStore.repoPath(room.id), dorkHome);
    const saved = await editor.save(
      room.id,
      { authorId: harness.human, signedIn: false },
      { path: 'ROOM.md', baseCommit: head, text: '# Release train\n\nShip Thursdays.\n' }
    );
    expect(saved.status).toBe('saved');
    await harness.service.triggersIdle();
    expect(launched.length).toBe(turnsBefore);
    expect(harness.store.listEntriesFrom(room.id, { afterSeq: 0, limit: 500 })).toHaveLength(
      entriesBefore + 1
    );

    // Bo's next turn names the person, from the room's own record of them.
    await ask(room.id, '@bo anything else?');
    const named = lastFor(boPath);
    const person = harness.authors.getById(harness.human)!.displayName;
    expect(named.files?.refresh).toMatchObject({ kind: 'held', reason: 'changes' });
    const moved = named.files?.refresh?.kind === 'held' ? named.files.refresh.moved : null;
    // Newest first: the person's edit, then Ana's merge still waiting for Bo.
    expect(moved?.commits.map((c) => [c.kind, c.who, c.files])).toEqual([
      ['person', person, ['ROOM.md']],
      ['merge', 'Ana', ['PLAN.md']],
    ]);
  });

  describe('as the room wires it (room-trigger.ts)', () => {
    /** Session ids whose runtime lock is held, as the registered runtime reports them. */
    let locked: Set<string>;

    beforeEach(() => {
      // The REAL registry the room's busy read resolves through, holding a
      // runtime whose lock this test controls.
      locked = new Set();
      const fake = new FakeAgentRuntime();
      fake.getInternalSessionId.mockReturnValue(undefined);
      fake.isLocked.mockImplementation((sessionId: string) => locked.has(sessionId));
      runtimeRegistry.register(fake);
      runtimeRegistry.setDefault(fake.type);
      runtimeRegistry.setDb(harness.db);
    });

    /** Commit one file on the room's `main`, as a hand commit would. */
    async function onMain(roomId: string, file: string, text: string): Promise<void> {
      const repoDir = repoStore.repoPath(roomId);
      await writeFile(path.join(repoDir, file), text, 'utf-8');
      await runGit(['add', file], repoDir, dorkHome);
      await runGit(
        ['-c', 'user.name=Hand', '-c', 'user.email=h@x', 'commit', '-q', '-m', file],
        repoDir,
        dorkHome
      );
    }

    it('leaves the copy alone while a turn runs on a RETIRED id of the same binding', async () => {
      const room = await openRoom();
      await ask(room.id, '@bo hello');
      const boSession = harness.store.getRoomSession(room.id, authorIdOf(room.id, boPath))!;
      // The session was renamed once; the old id still resolves to the binding,
      // so an app-resumed turn on it is granted the same copy — and one is running.
      harness.store.sessionLedger.retire('bo-before-rename', boSession);
      locked.add('bo-before-rename');
      await onMain(room.id, 'PLAN.md', '# plan\n');
      const boCopy = copyOf(room.id, boPath, 'Bo');

      await ask(room.id, '@bo now?');
      expect(lastFor(boPath).files?.refresh).toEqual({ kind: 'held', reason: 'busy', moved: null });
      expect(existsSync(path.join(boCopy, 'PLAN.md'))).toBe(false);

      locked.delete('bo-before-rename');
      await ask(room.id, '@bo and now?');
      expect(lastFor(boPath).files?.refresh).toMatchObject({ kind: 'refreshed' });
      expect(existsSync(path.join(boCopy, 'PLAN.md'))).toBe(true);
    });

    it('forgets the diff baselines of the files a refresh moved, and only those', async () => {
      const room = await openRoom();
      await ask(room.id, '@bo hello');
      const boSession = harness.store.getRoomSession(room.id, authorIdOf(room.id, boPath))!;
      const boCopy = copyOf(room.id, boPath, 'Bo');
      const baseline = {
        bytes: Buffer.from('old'),
        capturedAt: 1,
        capturedFrom: 'pre-tool' as const,
      };
      const moved = path.join(boCopy, 'PLAN.md');
      const movedReal = path.join(realpathSync(boCopy), 'PLAN.md');
      const kept = path.join(boCopy, 'KEEP.md');
      for (const p of [moved, movedReal, kept]) editBaselineStore.set(boSession, p, baseline);
      await onMain(room.id, 'PLAN.md', '# plan\n');

      await ask(room.id, '@bo now?');

      expect(lastFor(boPath).files?.refresh).toMatchObject({ kind: 'refreshed' });
      expect(editBaselineStore.get(boSession, moved)).toBeUndefined();
      expect(editBaselineStore.get(boSession, movedReal)).toBeUndefined();
      expect(editBaselineStore.get(boSession, kept)).toBeDefined();
      editBaselineStore.clearSession(boSession);
    });
  });
});
