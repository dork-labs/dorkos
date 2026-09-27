/**
 * A room turn stands in its agent's home and is granted the room's files —
 * end to end, over real git (spec `agent-home-desk` §5.1, §11 "Integration").
 *
 * The real store, the real repo service, the real worktree manager, the real
 * trigger dispatcher, and a real temporary DorkOS home sitting INSIDE another
 * git repository — the dev layout, which is also the trap layout. Only the turn
 * runner stands in, because the alternative is a model call; what the runner
 * hands the runtime is pinned in `__tests__/room-turn-runner.test.ts`.
 *
 * The claims:
 *
 * 1. A project room's turn stands at home (`cwd === agentPath`, invariant I4)
 *    and is granted exactly its copy, the room's shared tree read-only, and the
 *    parts of `.git` a commit writes.
 * 2. A room with no files of its own grants nothing and makes no copy.
 * 3. The files the model is told about are under the folder it stands in — the
 *    agent's home — and the files section names the copy it was granted.
 * 4. Nothing about the busy ceilings moved, and the reap still sees a live turn
 *    working on a copy it only reaches by path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
import { access, mkdtemp, mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { formatRoomContext } from '../../../runtimes/shared/room-context-block.js';
import { LocalRoomAttachmentStore } from '../../attachments/local-room-attachment-store.js';
import { projectRoomAttachments } from '../../attachments/attachment-projection.js';
import {
  agentLookupFor,
  createRoomHarness,
  gatedRunner,
  scriptedRunner,
  settleUntil,
  type RoomHarness,
  type ScriptedTurnRunner,
} from '../../__tests__/room-test-harness.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import { RoomRepoService } from '../room-repo-service.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import { runGit } from '../room-repo-git.js';
import { removeFixtureTree, silenceGitAutoMaintenance } from './fixture-git.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('a room turn stands at home with the room’s files granted', () => {
  let scratch: string;
  let dorkHome: string;
  let anaPath: string;
  let boPath: string;
  let harness: RoomHarness;
  let repos: RoomRepoService;
  let manager: RoomWorktreeManager;
  let repoStore: RoomRepoStore;
  /** The agent workspace paths holding a live room claim — the reap's gate. */
  let busyAgentPaths: string[];

  /**
   * Stand the whole thing up around one runner.
   *
   * The manager is reached through a thunk exactly as production reaches it:
   * it needs the claim map the room service owns, so it cannot exist before the
   * service does.
   */
  function standUp(runner: ScriptedTurnRunner): void {
    harness = createRoomHarness({
      agents: agentLookupFor({
        // **`mention-only`, both of them, on purpose.** Two agents on `always`
        // answer each other's replies, so the number of turns a message
        // produces stops being a property of the test — which is how a suite
        // acquires assertions that usually hold. Here every turn is one this
        // test asked for by name.
        [anaPath]: { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
        [boPath]: { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
      }),
      runner,
      worktrees: () => manager,
    });
    repoStore = new RoomRepoStore(harness.db, dorkHome);
    repos = new RoomRepoService({
      store: repoStore,
      mutex: new RoomRepoMutex(),
      queueWaitMs: () => 5000,
      enabled: () => true,
      getRoom: (roomId) => harness.store.getRoom(roomId),
      // The harness's `human` is the owner, and enabling a repo is operator-only.
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
      // Wired exactly as `index.ts` wires it — off the live claim map — so the
      // reap gate below is the production one and not a fixture.
      busyAgentPaths: () => [...busyAgentPaths, ...harness.service.listBusyAgentPaths()],
    });
  }

  /** A channel both agents are in, optionally with files of its own. */
  async function openRoom(title: string, withRepo: boolean): Promise<RoomWithRoster> {
    const room = harness.service.createRoom(
      { kind: 'channel', title, members: [], agentPaths: [anaPath, boPath] },
      harness.human
    );
    if (withRepo) await repos.enable(room.id, harness.human);
    return room;
  }

  beforeEach(async () => {
    // Before anything makes a repo: keep git's detached maintenance child from
    // racing this suite's teardown into the directory. See `fixture-git.ts`.
    silenceGitAutoMaintenance();
    // The DorkOS home sits inside a git repository on purpose — the trap layout.
    scratch = await mkdtemp(path.join(tmpdir(), 'dorkos-room-cwd-'));
    await runGit(['init', '-b', 'main', '--quiet', '.'], scratch, scratch);
    await writeFile(path.join(scratch, '.gitignore'), '*\n', 'utf-8');
    await runGit(['add', '-f', '.gitignore'], scratch, scratch);
    await runGit(
      ['-c', 'user.name=E', '-c', 'user.email=e@dorkos.local', 'commit', '-q', '-m', 'base'],
      scratch,
      scratch
    );
    dorkHome = path.join(scratch, '.dork');
    await mkdir(dorkHome, { recursive: true });
    anaPath = path.join(scratch, 'agents', 'ana');
    boPath = path.join(scratch, 'agents', 'bo');
    await mkdir(anaPath, { recursive: true });
    await mkdir(boPath, { recursive: true });
    busyAgentPaths = [];
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeFixtureTree(scratch);
  });

  /** Ana's worktree in `roomId`, as the manager names it. */
  function anaWorktree(roomId: string): string {
    return path.join(repoStore.worktreesPath(roomId), RoomWorktreeManager.slugFor('Ana', anaPath));
  }

  it('stands the turn at home and grants the agent’s copy of the room’s files', async () => {
    const runner = scriptedRunner(() => null);
    standUp(runner);
    const room = await openRoom('Release train', true);

    harness.service.post(room.id, { authorId: harness.human, text: '@ana what is left?' });
    await harness.service.triggersIdle();

    expect(runner.turns).toHaveLength(1);
    const turn = runner.turns[0]!;
    // Invariant I4: the agent's home, never its copy, never `repo/`.
    expect(turn.cwd).toBe(anaPath);
    expect(turn.agentPath).toBe(anaPath);
    expect(turn.worktree).toBe(anaWorktree(room.id));
    // A real checkout, on its own branch, not just a directory name.
    await expect(runGit(['branch', '--show-current'], turn.worktree!, dorkHome)).resolves.toBe(
      `room/${RoomWorktreeManager.slugFor('Ana', anaPath)}`
    );
    // Grants are realpath-resolved (a symlinked `/var` spelling would not match
    // what a backend compares), so the expectation is too.
    const repoDir = realpathSync(repoStore.repoPath(room.id));
    const gitDir = path.join(repoDir, '.git');
    expect(turn.additionalDirectories).toEqual([
      { path: realpathSync(anaWorktree(room.id)), access: 'write' },
      { path: repoDir, access: 'read' },
      { path: path.join(gitDir, 'objects'), access: 'write' },
      { path: path.join(gitDir, 'refs', 'heads', 'room'), access: 'write' },
      { path: path.join(gitDir, 'logs', 'refs', 'heads', 'room'), access: 'write' },
      {
        path: path.join(gitDir, 'worktrees', RoomWorktreeManager.slugFor('Ana', anaPath)),
        access: 'write',
      },
    ]);
    // And a launch step, which the dispatcher runs when the turn launches.
    expect(typeof turn.prepareLaunch).toBe('function');
  });

  it('leaves a room with no files of its own exactly where it was', async () => {
    // The regression pin. Before the cwd rung a room turn ran in the agent's own
    // directory, full stop; for every room that has not been given files, it
    // still does, and nothing about the answer is derived from a worktree.
    const runner = scriptedRunner(() => null);
    standUp(runner);
    const room = await openRoom('Backend', false);

    harness.service.post(room.id, { authorId: harness.human, text: '@ana what is left?' });
    await harness.service.triggersIdle();

    expect(runner.turns).toHaveLength(1);
    const turn = runner.turns[0]!;
    expect(turn.cwd).toBe(anaPath);
    expect(turn.cwd).toBe(turn.agentPath);
    expect(turn.additionalDirectories).toEqual([]);
    expect(turn.worktree).toBeNull();
    expect(turn.prepareLaunch).toBeUndefined();
    expect(existsSync(repoStore.worktreesPath(room.id))).toBe(false);
  });

  it('tells the turn where its own copy is, and how far the room has moved', async () => {
    // Spec §3.7 end to end. The files section names the copy the turn was just
    // granted, never the folder it stands in.
    const runner = scriptedRunner(() => null);
    standUp(runner);
    const room = await openRoom('Release train', true);

    harness.service.post(room.id, { authorId: harness.human, text: '@ana what is left?' });
    await harness.service.triggersIdle();

    const files = runner.turns[0]!.roomContext?.files;
    expect(files).toBeDefined();
    expect(files!.worktreePath).toBe(anaWorktree(room.id));
    expect(files!.worktreePath).toBe(runner.turns[0]!.worktree);
    expect(files!.worktreePath).not.toBe(runner.turns[0]!.cwd);
    expect(files!.repoPath).toBe(repoStore.repoPath(room.id));
    expect(files!.branch).toBe(`room/${RoomWorktreeManager.slugFor('Ana', anaPath)}`);
    // A tree just branched off `main` is level with it in both directions.
    expect(files).toMatchObject({ ahead: 0, behind: 0 });
  });

  it('counts the commits the room gained while an agent was away', async () => {
    // The number the section exists for: "sync before you edit" is advice
    // without it, because an agent cannot see what landed on `main` from inside
    // its own tree.
    const runner = scriptedRunner(() => null);
    standUp(runner);
    const room = await openRoom('Release train', true);

    // First turn: Ana's worktree is created off main.
    harness.service.post(room.id, { authorId: harness.human, text: '@ana what is left?' });
    await harness.service.triggersIdle();

    // The room moves on without her — two commits on `main`, as a merge would
    // leave it.
    const repoDir = repoStore.repoPath(room.id);
    for (const name of ['CHECKLIST.md', 'NOTES.md']) {
      await writeFile(path.join(repoDir, name), `# ${name}\n`, 'utf-8');
      await runGit(['add', name], repoDir, dorkHome);
      await runGit(
        ['-c', 'user.name=E', '-c', 'user.email=e@dorkos.local', 'commit', '-q', '-m', name],
        repoDir,
        dorkHome
      );
    }

    harness.service.post(room.id, { authorId: harness.human, text: '@ana and now?' });
    await harness.service.triggersIdle();

    const forAna = runner.turns.filter((turn) => turn.agentPath === anaPath);
    expect(forAna.at(-1)!.roomContext?.files).toMatchObject({ behind: 2, ahead: 0 });
  });

  it('tells a room with no files of its own nothing about files', async () => {
    // The additive promise: a conversation-only room renders a context
    // byte-identical to the one it rendered before this field existed.
    const runner = scriptedRunner(() => null);
    standUp(runner);
    const room = await openRoom('Backend', false);

    harness.service.post(room.id, { authorId: harness.human, text: '@ana what is left?' });
    await harness.service.triggersIdle();

    expect(runner.turns[0]!.roomContext).not.toHaveProperty('files');
  });

  it('gives each agent its own working copy, and reuses it across turns', async () => {
    const runner = scriptedRunner(() => null);
    standUp(runner);
    const room = await openRoom('Release train', true);

    // Waited out to IDLE rather than to a turn count: the second message lands
    // while Ana may still be holding her claim, in which case it is held and run
    // afterwards (RP8) — so "two turns have happened" is a moment, not a settled
    // state. The assertions below count turns PER AGENT for the same reason
    // rather than in total: an agent that was mentioned once carries an engaged
    // window afterwards, so how many turns a second message produces is the
    // engagement rules' business and not this test's.
    harness.service.post(room.id, { authorId: harness.human, text: '@ana @bo what is left?' });
    await harness.service.triggersIdle();
    harness.service.post(room.id, { authorId: harness.human, text: '@ana and now?' });
    await harness.service.triggersIdle();

    const forAna = runner.turns.filter((turn) => turn.agentPath === anaPath);
    const forBo = runner.turns.filter((turn) => turn.agentPath === boPath);
    expect(forAna.length).toBeGreaterThanOrEqual(2);
    expect(forBo.length).toBeGreaterThanOrEqual(1);
    // One tree per agent, standing across turns — a second turn must not mint a
    // second checkout, or an agent would lose its uncommitted work every time
    // somebody spoke to it.
    expect(new Set(forAna.map((turn) => turn.worktree)).size).toBe(1);
    expect(forAna[0]!.worktree).not.toBe(forBo[0]!.worktree);
    expect(new Set(forAna.map((turn) => turn.cwd))).toEqual(new Set([anaPath]));
    expect(await readdir(repoStore.worktreesPath(room.id))).toHaveLength(2);
  });

  it('puts the file the model is told about under the folder it stands in: its home', async () => {
    // DOR-1266 end to end (spec `agent-home-desk` §5.4). The context names an
    // ABSOLUTE path; the projector plans a RELATIVE one and joins it to the
    // turn's own directory — the agent's home, room files or not.
    const runner = scriptedRunner(() => null);
    standUp(runner);
    const room = await openRoom('Release train', true);

    const attachments = new LocalRoomAttachmentStore(dorkHome);
    const { url } = await attachments.put(room.id, 'att1', 'txt', Buffer.from('the notes'));
    harness.attachments.create(
      {
        roomId: room.id,
        id: 'att1',
        authorId: harness.human,
        name: 'notes.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        size: 9,
        preview: null,
        url,
      },
      '2026-08-27T10:00:00.000Z'
    );
    harness.service.post(room.id, {
      authorId: harness.human,
      text: '@ana read this',
      attachmentIds: ['att1'],
    });
    await harness.service.triggersIdle();
    expect(runner.turns).toHaveLength(1);

    const turn = runner.turns[0]!;
    // Exactly what the production runner does, with exactly what it is handed.
    await projectRoomAttachments({
      store: () => attachments,
      roomId: room.id,
      cwd: turn.cwd,
      attachments: turn.attachmentProjection,
    });

    // The plan the dispatcher made, and the path it must resolve to from where
    // the turn stands.
    expect(turn.attachmentProjection).toHaveLength(1);
    const landed = path.join(turn.cwd, turn.attachmentProjection[0]!.relativePath);
    // Under the agent's HOME, and provably not in its copy of the room's files,
    // which would dirty the copy and could be merged into the room.
    expect(landed.startsWith(anaPath + path.sep)).toBe(true);
    expect(landed.startsWith(anaWorktree(room.id) + path.sep)).toBe(false);
    // The bytes really are there.
    await expect(access(landed)).resolves.toBeUndefined();
    // And that exact string is what the model was handed — read back out of the
    // RENDERED block, not the structured data behind it.
    const block = formatRoomContext(turn.roomContext, { nonce: 'aaaa1111' });
    expect(block).toContain(landed);
  });

  it('still holds another room’s message while the agent works in a worktree', async () => {
    // Spec §5 Q6: no relaxation. The second ceiling is one working tree per
    // AGENT, and it is keyed on `agentPath` — its home, where it stands.
    // An agent mid-turn in a project room is still busy everywhere else, and the
    // waiting message is HELD rather than refused (`room-hold-when-busy`).
    const runner = gatedRunner({});
    standUp(runner);
    const project = await openRoom('Release train', true);
    const other = await openRoom('Backend', false);

    harness.service.post(project.id, { authorId: harness.human, text: '@ana what is left?' });
    await settleUntil(() => runner.turns.length === 1, 'Ana started work in the project room');
    // She really is working on the room's copy — otherwise this test would pass
    // for the ordinary reason and prove nothing.
    expect(runner.turns[0]!.worktree).toBe(anaWorktree(project.id));

    harness.service.post(other.id, { authorId: harness.human, text: '@ana and here?' });
    await settleUntil(
      () => harness.service.listHolds().length === 1,
      'the second room’s message was held'
    );
    expect(runner.turns).toHaveLength(1);

    // And the hold is released by the claim, not by anything about directories.
    runner.releaseAll();
    await settleUntil(() => runner.turns.length === 2, 'the held message ran');
    expect(runner.turns[1]!.roomId).toBe(other.id);
    expect(runner.turns[1]!.cwd).toBe(anaPath);
    expect(runner.turns[1]!.worktree).toBeNull();
    runner.releaseAll();
  });

  it('spares an ancient worktree that a live turn is working on', async () => {
    // The 2.1 gate. A turn that only READS its copy leaves no mark on any date
    // source the sweep can see, so without the claim map the reap would delete
    // the copy the turn was granted. This
    // drives it through the real claim map: the turn is mid-flight, held open,
    // while the sweep runs.
    const runner = gatedRunner({});
    standUp(runner);
    const room = await openRoom('Release train', true);

    // Age MAIN before the turn, so the worktree branches from an already-old
    // commit — `lastTouchedAt` reads HEAD's committer date, and a tree branched
    // from a commit made seconds ago can never look idle however its mtimes are
    // backdated.
    const when = new Date(Date.now() - 40 * DAY_MS);
    vi.stubEnv('GIT_COMMITTER_DATE', when.toISOString());
    vi.stubEnv('GIT_AUTHOR_DATE', when.toISOString());
    await runGit(
      [
        // **Identity inline, never the machine's.** An `--amend` needs a
        // COMMITTER, and a CI runner has no global `user.name`/`user.email` at
        // all — this failed there while passing on every developer machine,
        // which is the whole failure mode of leaning on ambient git config.
        // `--no-edit` keeps the original author, so this only names the
        // committer, and it names the same operator that made the commit.
        '-c',
        'user.name=Dorian',
        '-c',
        'user.email=operator@dorkos.local',
        'commit',
        '--amend',
        '--no-edit',
        '--quiet',
      ],
      repoStore.repoPath(room.id),
      repoStore.homeDir(room.id)
    );
    // Drops the two date stubs — and the maintenance belt with them, since it is
    // stubbed too, so it is put straight back for the rest of this test.
    vi.unstubAllEnvs();
    silenceGitAutoMaintenance();

    harness.service.post(room.id, { authorId: harness.human, text: '@ana what is left?' });
    await settleUntil(() => runner.turns.length === 1, 'Ana started work');
    const worktree = runner.turns[0]!.worktree!;
    expect(worktree).toBe(anaWorktree(room.id));

    // And age every mtime the sweep reads, so the ONLY thing keeping this tree
    // is the live claim. That is the directory and its top-level entries — the
    // git index is deliberately NOT among them (the sweep's own reads would
    // refresh it), so there is nothing else to backdate here.
    for (const name of await readdir(worktree)) {
      await utimes(path.join(worktree, name), when, when).catch(() => undefined);
    }
    await utimes(worktree, when, when);

    // The claim is live right now — this is the join the reap makes.
    expect(harness.service.listBusyAgentPaths()).toContain(anaPath);

    const swept = await manager.reapRoom(room.id);

    expect(swept.reaped).toEqual([]);
    expect(swept.spared).toEqual([RoomWorktreeManager.slugFor('Ana', anaPath)]);
    expect(existsSync(worktree)).toBe(true);

    runner.releaseAll();
    await settleUntil(() => harness.service.listBusyAgentPaths().length === 0, 'the turn ended');
  });
});
