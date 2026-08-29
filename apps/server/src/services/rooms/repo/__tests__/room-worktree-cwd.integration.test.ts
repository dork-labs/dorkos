/**
 * A room turn runs in that agent's working copy of the room's repo — end to end,
 * over real git (spec `project-rooms` §3.5, DOR-1597).
 *
 * The real store, the real repo service, the real worktree manager, the real
 * trigger dispatcher, and a real temporary DorkOS home sitting INSIDE another
 * git repository — the dev layout, which is also the trap layout. Only the turn
 * runner stands in, because the alternative is a model call.
 *
 * Four claims, and the second is as load-bearing as the first:
 *
 * 1. A project room's turn is placed in `worktrees/<agent>/`.
 * 2. **Everything else is exactly where it was.** A room with no files of its
 *    own still runs its turn in the agent's own directory, byte for byte.
 * 3. The files the model is told about are in the tree it is standing in — the
 *    DOR-1266 invariant, which the cwd rung could silently break by moving the
 *    tree and leaving the projection behind.
 * 4. Nothing about the busy ceilings moved (spec §5 Q6), and the reap can still
 *    see a live turn now that a live turn is standing in a worktree.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Dropping the room's `info/exclude` entry for DorkOS's own scratch area reddens "a
 *   worktree that received a file still reads clean".
 * - Keying the cross-room ceiling on `cwd` rather than `agentPath` reddens "an
 *   agent working in one room's worktree still holds another room's message".
 *
 * The two defects INSIDE the runner — stamping `agentPath` where `cwd` belongs,
 * and projecting attachments under the wrong root — are pinned in
 * `__tests__/room-turn-runner.test.ts`, not here: this file drives a scripted
 * runner, so it can see the dispatcher's answer and nothing the runner does with
 * it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { access, mkdtemp, mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { formatRoomContext } from '../../../runtimes/shared/room-context-block.js';
import { LocalRoomAttachmentStore } from '../../attachments/local-room-attachment-store.js';
import { projectRoomAttachments } from '../../attachments/attachment-projection.js';
import { PROJECTED_ATTACHMENTS_ROOT } from '../../attachments/attachment-paths.js';
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
import { hasUncommittedChanges, runGit } from '../room-repo-git.js';
import { removeFixtureTree, silenceGitAutoMaintenance } from './fixture-git.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('a room turn runs in the room’s repo', () => {
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

  it('runs the turn in the agent’s own working copy of the room’s repo', async () => {
    const runner = scriptedRunner(() => null);
    standUp(runner);
    const room = await openRoom('Release train', true);

    harness.service.post(room.id, { authorId: harness.human, text: '@ana what is left?' });
    await harness.service.triggersIdle();

    expect(runner.turns).toHaveLength(1);
    const turn = runner.turns[0]!;
    expect(turn.cwd).toBe(anaWorktree(room.id));
    // A real checkout, on its own branch, not just a directory name.
    expect(existsSync(path.join(turn.cwd, '.git'))).toBe(true);
    await expect(runGit(['branch', '--show-current'], turn.cwd, dorkHome)).resolves.toBe(
      `room/${RoomWorktreeManager.slugFor('Ana', anaPath)}`
    );
    // **And identity did not move.** Everything that decides who this agent is
    // still says the same thing it always did.
    expect(turn.agentPath).toBe(anaPath);
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
    expect(existsSync(repoStore.worktreesPath(room.id))).toBe(false);
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
    expect(new Set(forAna.map((turn) => turn.cwd)).size).toBe(1);
    expect(forAna[0]!.cwd).not.toBe(forBo[0]!.cwd);
    expect(await readdir(repoStore.worktreesPath(room.id))).toHaveLength(2);
  });

  it('puts the file the model is told about in the tree it is standing in', async () => {
    // DOR-1266 end to end, through the moved tree. The context names an ABSOLUTE
    // path; the projector plans a RELATIVE one and joins it to the turn's own
    // directory. Move one and not the other and the model is handed a path that
    // opens nothing, with no log line anywhere saying why.
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
    // Under the WORKTREE, and provably not under the agent's home.
    expect(landed.startsWith(anaWorktree(room.id) + path.sep)).toBe(true);
    expect(landed.startsWith(anaPath + path.sep)).toBe(false);
    // The bytes really are there.
    await expect(access(landed)).resolves.toBeUndefined();
    // And that exact string is what the model was handed — read back out of the
    // RENDERED block, not the structured data behind it.
    const block = formatRoomContext(turn.roomContext, { nonce: 'aaaa1111' });
    expect(block).toContain(landed);
  });

  it('leaves a worktree that received a file reading clean', async () => {
    // A projected attachment is DorkOS's own writing, not the agent's work. Left
    // visible it would make every worktree that ever carried a file permanently
    // dirty — never reaped, and never mergeable once §3.6 lands.
    const runner = scriptedRunner(() => null);
    standUp(runner);
    const room = await openRoom('Release train', true);
    const worktree = (await manager.ensureWorktree(room.id, anaPath, 'Ana')).path;

    await mkdir(path.join(worktree, PROJECTED_ATTACHMENTS_ROOT, 'entry-1'), { recursive: true });
    await writeFile(
      path.join(worktree, PROJECTED_ATTACHMENTS_ROOT, 'entry-1', 'notes.txt'),
      'the notes',
      'utf-8'
    );

    await expect(hasUncommittedChanges(worktree, repoStore.homeDir(room.id))).resolves.toBe(false);
  });

  it('still holds another room’s message while the agent works in a worktree', async () => {
    // Spec §5 Q6: no relaxation. The second ceiling is one working tree per
    // AGENT, and it is keyed on `agentPath` — which the cwd rung does not touch.
    // An agent mid-turn in a project room is still busy everywhere else, and the
    // waiting message is HELD rather than refused (`room-hold-when-busy`).
    const runner = gatedRunner({});
    standUp(runner);
    const project = await openRoom('Release train', true);
    const other = await openRoom('Backend', false);

    harness.service.post(project.id, { authorId: harness.human, text: '@ana what is left?' });
    await settleUntil(() => runner.turns.length === 1, 'Ana started work in the project room');
    // She really is in the worktree — otherwise this test would pass for the
    // ordinary reason and prove nothing about the new one.
    expect(runner.turns[0]!.cwd).toBe(anaWorktree(project.id));

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
    runner.releaseAll();
  });

  it('spares an ancient worktree that a live turn is standing in', async () => {
    // The 2.1 gate, now that it has something to guard. A turn that only READS
    // leaves no mark on any date source the sweep can see, so without the claim
    // map the reap would delete the directory the turn is standing in. This
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
    const worktree = runner.turns[0]!.cwd;
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
