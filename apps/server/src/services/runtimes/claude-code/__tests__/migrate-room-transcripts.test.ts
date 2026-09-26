import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp, {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { logger } from '../../../../lib/logger.js';
import { RoomWorktreeManager } from '../../../rooms/repo/room-worktree-manager.js';
import { discoverClaudeCodeTranscripts } from '../../../search/claude-code-discovery.js';
import { projectSlug } from '../sessions/project-slug.js';
import {
  RECENT_WRITE_WINDOW_MS,
  ROOM_TRANSCRIPT_MIGRATION_MARKER,
  migrateRoomTranscripts,
  type RoomTranscriptMigrationMarker,
} from '../migrate-room-transcripts.js';

/**
 * The one-time move of room transcripts from worktree slugs to home slugs
 * (spec `agent-home-desk` §8.1), on the real filesystem.
 *
 * Every path is a temp dir: nothing here reads or writes a real Claude config
 * directory or a real `~/.dork`.
 */
describe('migrateRoomTranscripts', () => {
  // Room ids are ULIDs.
  const ROOM_1 = '01JAAAAAAAAAAAAAAAAAAAAAAA';
  const ROOM_2 = '01JBBBBBBBBBBBBBBBBBBBBBBB';
  const ROOM_3 = '01JCCCCCCCCCCCCCCCCCCCCCCC';

  let base: string;
  let dorkHome: string;
  let aliceHome: string;
  let bobHome: string;
  let aliceName: string;
  let aliceWorktree: string;
  let aliceWorktree2: string;
  let bobWorktree: string;
  let rootA: string;
  let rootB: string;

  /** One transcript line with a cwd, the shape the discovery head-read needs. */
  const transcript = (cwd: string, text: string) =>
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: text } }) + '\n';

  const exists = (p: string) =>
    access(p).then(
      () => true,
      () => false
    );

  /** Write a file last touched an hour ago: settled, not a live transcript. */
  const put = async (file: string, body: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(file, hourAgo, hourAgo);
  };

  const projectsDir = (root: string, cwd: string) => path.join(root, 'projects', projectSlug(cwd));
  const markerPath = () => path.join(dorkHome, ROOM_TRANSCRIPT_MIGRATION_MARKER);
  const readMarker = async () =>
    JSON.parse(await readFile(markerPath(), 'utf-8')) as RoomTranscriptMigrationMarker;
  const aliceOnly = () => ({ dorkHome, claudeRoots: [rootA], agentPaths: [aliceHome] });

  beforeEach(async () => {
    // realpath: macOS tmp is a symlink, and the SDK slugs the resolved path.
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'migrate-room-transcripts-')));
    dorkHome = path.join(base, 'dork');
    aliceHome = path.join(base, 'agents', 'alice');
    bobHome = path.join(base, 'agents', 'bob');
    await mkdir(aliceHome, { recursive: true });
    await mkdir(bobHome, { recursive: true });

    aliceName = RoomWorktreeManager.slugFor('Alice', aliceHome);
    const bobName = RoomWorktreeManager.slugFor('Bob', bobHome);
    aliceWorktree = path.join(dorkHome, 'rooms', ROOM_1, 'worktrees', aliceName);
    aliceWorktree2 = path.join(dorkHome, 'rooms', ROOM_2, 'worktrees', aliceName);
    bobWorktree = path.join(dorkHome, 'rooms', ROOM_1, 'worktrees', bobName);
    for (const dir of [aliceWorktree, aliceWorktree2, bobWorktree]) {
      await mkdir(dir, { recursive: true });
    }

    rootA = path.join(base, 'claude-a');
    rootB = path.join(base, 'claude-b');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(base, { recursive: true, force: true });
  });

  it('moves, skips and sets aside colliding transcripts, then writes the marker', async () => {
    const warn = vi.spyOn(logger, 'warn');

    // Root A: a plain move (with its sibling folder), and a collision.
    await put(
      path.join(projectsDir(rootA, aliceWorktree), 's1.jsonl'),
      transcript(aliceWorktree, 'one')
    );
    await put(
      path.join(projectsDir(rootA, aliceWorktree), 's1', 'subagents', 'agent-x.jsonl'),
      transcript(aliceWorktree, 'sub')
    );
    await put(
      path.join(projectsDir(rootA, aliceWorktree), 's2.jsonl'),
      transcript(aliceWorktree, 'old')
    );
    await put(path.join(projectsDir(rootA, aliceHome), 's2.jsonl'), transcript(aliceHome, 'kept'));
    // A second room's worktree for the same agent.
    await put(
      path.join(projectsDir(rootA, aliceWorktree2), 's5.jsonl'),
      transcript(aliceWorktree2, 'five')
    );
    // A worktree the reap removed: gone from disk, its transcripts are not.
    const reapedWorktree = path.join(dorkHome, 'rooms', ROOM_3, 'worktrees', aliceName);
    await put(
      path.join(projectsDir(rootA, reapedWorktree), 's6.jsonl'),
      transcript(reapedWorktree, 'six')
    );
    // Root B: a second Claude config dir must be visited too.
    await put(
      path.join(projectsDir(rootB, aliceWorktree), 's3.jsonl'),
      transcript(aliceWorktree, 'three')
    );
    // Bob is not registered: his worktree's transcripts stay where they are.
    await put(
      path.join(projectsDir(rootA, bobWorktree), 's4.jsonl'),
      transcript(bobWorktree, 'four')
    );

    const outcome = await migrateRoomTranscripts({
      dorkHome,
      claudeRoots: [rootA, rootB],
      agentPaths: [aliceHome],
    });

    const aliceHomeA = projectsDir(rootA, aliceHome);
    const aliceWorktreeA = projectsDir(rootA, aliceWorktree);

    // Moved, with the sibling folder.
    expect(await readFile(path.join(aliceHomeA, 's1.jsonl'), 'utf-8')).toContain('"one"');
    expect(await exists(path.join(aliceHomeA, 's1', 'subagents', 'agent-x.jsonl'))).toBe(true);
    expect(await exists(path.join(aliceWorktreeA, 's1.jsonl'))).toBe(false);
    expect(await exists(path.join(aliceWorktreeA, 's1'))).toBe(false);
    expect(await exists(path.join(aliceHomeA, 's5.jsonl'))).toBe(true);
    expect(await exists(path.join(aliceHomeA, 's6.jsonl'))).toBe(true);
    // The second config dir was visited.
    expect(await exists(path.join(projectsDir(rootB, aliceHome), 's3.jsonl'))).toBe(true);
    // Unregistered agent: untouched.
    expect(await exists(path.join(projectsDir(rootA, bobWorktree), 's4.jsonl'))).toBe(true);

    // Collision: the destination is never overwritten, the source is set aside.
    const conflict = path.join(aliceWorktreeA, 's2.jsonl.conflict');
    expect(await readFile(path.join(aliceHomeA, 's2.jsonl'), 'utf-8')).toContain('"kept"');
    expect(await exists(path.join(aliceWorktreeA, 's2.jsonl'))).toBe(false);
    expect(await readFile(conflict, 'utf-8')).toContain('"old"');
    const conflictLog = warn.mock.calls.find(([msg]) => String(msg).includes('conflict'));
    expect(JSON.stringify(conflictLog)).toContain(conflict);
    expect(JSON.stringify(conflictLog)).toContain(path.join(aliceHomeA, 's2.jsonl'));

    // The search frontier sees exactly one transcript for the colliding id.
    const discovery = await discoverClaudeCodeTranscripts([
      path.join(rootA, 'projects'),
      path.join(rootB, 'projects'),
    ]);
    const s2 = discovery.files.filter((f) => f.originKey === 's2');
    expect(s2.map((f) => f.filePath)).toEqual([path.join(aliceHomeA, 's2.jsonl')]);

    // The marker: counts, the conflict and the frozen worktree list.
    const marker = await readMarker();
    expect(marker).toEqual(outcome.marker);
    expect(marker.moved).toBe(4);
    expect(marker.conflicts).toEqual([
      { source: conflict, destination: path.join(aliceHomeA, 's2.jsonl') },
    ]);
    expect([...marker.worktrees].sort((a, b) => a.path.localeCompare(b.path))).toEqual(
      [
        { path: aliceWorktree, agentPath: aliceHome },
        { path: aliceWorktree2, agentPath: aliceHome },
        { path: bobWorktree, agentPath: null },
      ].sort((a, b) => a.path.localeCompare(b.path))
    );
    expect(outcome.ran).toBe(true);
  });

  it('never takes a lookalike slug folder for a reaped worktree', async () => {
    // A dev DorkOS running inside Alice's worktree keeps its own rooms there.
    const devInstance = path.join(
      aliceWorktree,
      'apps',
      'server',
      '.temp',
      '.dork',
      'rooms',
      ROOM_2,
      'worktrees',
      aliceName
    );
    const lookalikes = [
      devInstance,
      // A folder inside a worktree named like a worktree: the outer digest is in the name.
      path.join(aliceWorktree, aliceName),
      // Beside the rooms folder, and elsewhere entirely.
      path.join(dorkHome, 'rooms-old', ROOM_1, 'worktrees', aliceName),
      path.join(base, 'elsewhere', ROOM_1, 'worktrees', aliceName),
      // Inside a room, but not under `worktrees/`.
      path.join(dorkHome, 'rooms', ROOM_1, 'archive', aliceName),
    ];
    for (const [i, dir] of lookalikes.entries()) {
      await put(path.join(projectsDir(rootA, dir), `n${i}.jsonl`), transcript(dir, 'not mine'));
    }

    const outcome = await migrateRoomTranscripts(aliceOnly());

    for (const [i, dir] of lookalikes.entries()) {
      expect(await exists(path.join(projectsDir(rootA, dir), `n${i}.jsonl`))).toBe(true);
    }
    expect(await exists(projectsDir(rootA, aliceHome))).toBe(false);
    // The one that has the full shape and a registered digest is named for the operator.
    expect(outcome.marker?.nearMisses).toEqual([projectsDir(rootA, lookalikes[1]!)]);
  });

  it('finds a reaped worktree of an agent with the longest name', async () => {
    const longName = RoomWorktreeManager.slugFor('x'.repeat(100), aliceHome);
    const reaped = path.join(dorkHome, 'rooms', ROOM_3, 'worktrees', longName);
    await put(path.join(projectsDir(rootA, reaped), 's1.jsonl'), transcript(reaped, 'long'));

    await migrateRoomTranscripts(aliceOnly());

    expect(await exists(path.join(projectsDir(rootA, aliceHome), 's1.jsonl'))).toBe(true);
  });

  it('finds a reaped worktree of an agent whose name holds an 8-hex word', async () => {
    const dated = RoomWorktreeManager.slugFor('Release 20260926', aliceHome);
    const reaped = path.join(dorkHome, 'rooms', ROOM_3, 'worktrees', dated);
    await put(path.join(projectsDir(rootA, reaped), 's1.jsonl'), transcript(reaped, 'dated'));

    const outcome = await migrateRoomTranscripts(aliceOnly());

    expect(await exists(path.join(projectsDir(rootA, aliceHome), 's1.jsonl'))).toBe(true);
    expect(outcome.marker?.nearMisses).toEqual([]);
  });

  it('finishes a move a crash left linked under both names, without a conflict', async () => {
    const source = path.join(projectsDir(rootA, aliceWorktree), 's1.jsonl');
    const destination = path.join(projectsDir(rootA, aliceHome), 's1.jsonl');
    await put(source, transcript(aliceWorktree, 'one'));
    await mkdir(path.dirname(destination), { recursive: true });
    await fsp.link(source, destination);

    const outcome = await migrateRoomTranscripts(aliceOnly());

    expect(await exists(source)).toBe(false);
    expect(await exists(`${source}.conflict`)).toBe(false);
    expect(await readFile(destination, 'utf-8')).toContain('"one"');
    expect(outcome.marker).toMatchObject({ moved: 1, conflicts: [] });
  });

  it('guesses no owner when two registered paths share one digest', async () => {
    await put(
      path.join(projectsDir(rootA, aliceWorktree), 's1.jsonl'),
      transcript(aliceWorktree, 'one')
    );

    // Two spellings of one folder: one digest, two registered paths.
    const outcome = await migrateRoomTranscripts({
      dorkHome,
      claudeRoots: [rootA],
      agentPaths: [aliceHome, `${aliceHome}${path.sep}`],
    });

    expect(await exists(path.join(projectsDir(rootA, aliceWorktree), 's1.jsonl'))).toBe(true);
    expect(outcome.marker?.worktrees).toContainEqual({ path: aliceWorktree, agentPath: null });
  });

  it('never replaces an earlier set-aside on a second collision', async () => {
    const source = projectsDir(rootA, aliceWorktree);
    await put(path.join(source, 's2.jsonl.conflict'), transcript(aliceWorktree, 'first'));
    await put(path.join(source, 's2.jsonl'), transcript(aliceWorktree, 'second'));
    await put(path.join(projectsDir(rootA, aliceHome), 's2.jsonl'), transcript(aliceHome, 'kept'));

    const outcome = await migrateRoomTranscripts(aliceOnly());

    const destination = path.join(projectsDir(rootA, aliceHome), 's2.jsonl');
    expect(await readFile(path.join(source, 's2.jsonl.conflict'), 'utf-8')).toContain('"first"');
    expect(await readFile(path.join(source, 's2.jsonl.conflict.2'), 'utf-8')).toContain('"second"');
    expect(await readFile(destination, 'utf-8')).toContain('"kept"');
    expect(outcome.marker?.conflicts).toEqual(
      expect.arrayContaining([
        { source: path.join(source, 's2.jsonl.conflict'), destination },
        { source: path.join(source, 's2.jsonl.conflict.2'), destination },
      ])
    );
  });

  it('sets aside a sibling folder whose destination already exists', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const source = projectsDir(rootA, aliceWorktree);
    const dest = projectsDir(rootA, aliceHome);
    await put(path.join(source, 's8.jsonl'), transcript(aliceWorktree, 'eight'));
    await put(path.join(source, 's8', 'tool-results', 'mine.txt'), 'source side');
    await put(path.join(dest, 's8', 'tool-results', 'theirs.txt'), 'destination side');

    const outcome = await migrateRoomTranscripts(aliceOnly());

    expect(await exists(path.join(dest, 's8.jsonl'))).toBe(true);
    expect(await exists(path.join(dest, 's8', 'tool-results', 'theirs.txt'))).toBe(true);
    expect(await exists(path.join(source, 's8.conflict', 'tool-results', 'mine.txt'))).toBe(true);
    const conflict = {
      source: path.join(source, 's8.conflict'),
      destination: path.join(dest, 's8'),
    };
    expect(outcome.marker?.conflicts).toEqual([conflict]);
    expect(JSON.stringify(warn.mock.calls)).toContain(conflict.source);
  });

  it('leaves a recently written transcript alone and does not finish', async () => {
    const source = path.join(projectsDir(rootA, aliceWorktree), 's1.jsonl');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, transcript(aliceWorktree, 'live'));

    const first = await migrateRoomTranscripts(aliceOnly());

    expect(first.skippedRecent).toEqual([source]);
    expect(first.marker).toBeNull();
    expect(await exists(source)).toBe(true);
    expect(await exists(markerPath())).toBe(false);

    // Once it has gone quiet, the next start moves it and finishes.
    const later = new Date(Date.now() + RECENT_WRITE_WINDOW_MS + 60_000);
    const second = await migrateRoomTranscripts({ ...aliceOnly(), now: () => later });
    expect(second.marker?.moved).toBe(1);
    expect(await exists(path.join(projectsDir(rootA, aliceHome), 's1.jsonl'))).toBe(true);
  });

  it('records a cross-filesystem move once instead of retrying it every start', async () => {
    const source = path.join(projectsDir(rootA, aliceWorktree), 's1.jsonl');
    await put(source, transcript(aliceWorktree, 'one'));
    vi.spyOn(fsp, 'link').mockRejectedValue(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));

    const outcome = await migrateRoomTranscripts(aliceOnly());

    expect(await exists(source)).toBe(true);
    expect(outcome.marker?.unmovable).toEqual([
      {
        source,
        destination: path.join(projectsDir(rootA, aliceHome), 's1.jsonl'),
        reason: 'EXDEV',
      },
    ]);
    expect((await migrateRoomTranscripts(aliceOnly())).ran).toBe(false);
  });

  it("leaves Claude Code's per-project memory behind and names it", async () => {
    const source = projectsDir(rootA, aliceWorktree);
    await put(path.join(source, 's1.jsonl'), transcript(aliceWorktree, 'one'));
    await put(path.join(source, 'memory', 'MEMORY.md'), '# room notes');

    const outcome = await migrateRoomTranscripts(aliceOnly());

    expect(await exists(path.join(source, 'memory', 'MEMORY.md'))).toBe(true);
    expect(await exists(path.join(projectsDir(rootA, aliceHome), 'memory'))).toBe(false);
    expect(outcome.marker?.leftBehind).toEqual([path.join(source, 'memory')]);
  });

  it('is a no-op once the marker is written', async () => {
    await put(
      path.join(projectsDir(rootA, aliceWorktree), 's1.jsonl'),
      transcript(aliceWorktree, 'one')
    );
    await migrateRoomTranscripts(aliceOnly());
    const markerBefore = await readFile(markerPath(), 'utf-8');

    // A transcript that appears later is not the migration's to move.
    await put(
      path.join(projectsDir(rootA, aliceWorktree), 's9.jsonl'),
      transcript(aliceWorktree, 'late')
    );
    const second = await migrateRoomTranscripts(aliceOnly());

    expect(second.ran).toBe(false);
    expect(await exists(path.join(projectsDir(rootA, aliceWorktree), 's9.jsonl'))).toBe(true);
    expect(await exists(path.join(projectsDir(rootA, aliceHome), 's9.jsonl'))).toBe(false);
    expect(await readFile(markerPath(), 'utf-8')).toBe(markerBefore);
  });

  it('resumes a run that stopped part-way, and leaves the marker unwritten on a failure', async () => {
    // An interrupted earlier run moved the sibling folder but not the file.
    await put(
      path.join(projectsDir(rootA, aliceWorktree), 's1.jsonl'),
      transcript(aliceWorktree, 'one')
    );
    await put(path.join(projectsDir(rootA, aliceHome), 's1', 'tool-results', 'r.txt'), 'x');
    // ...and had already set a colliding source aside.
    const setAside = path.join(projectsDir(rootA, aliceWorktree), 's7.jsonl.conflict');
    await put(setAside, transcript(aliceWorktree, 'seven'));
    // And a config dir whose projects folder is a file cannot be read.
    await put(path.join(rootB, 'projects'), 'not a directory');

    const first = await migrateRoomTranscripts({
      dorkHome,
      claudeRoots: [rootA, rootB],
      agentPaths: [aliceHome],
    });

    expect(first.ran).toBe(true);
    expect(first.marker).toBeNull();
    expect(first.failures.length).toBeGreaterThan(0);
    expect(await exists(markerPath())).toBe(false);
    expect(await exists(path.join(projectsDir(rootA, aliceHome), 's1.jsonl'))).toBe(true);
    expect(
      await exists(path.join(projectsDir(rootA, aliceHome), 's1', 'tool-results', 'r.txt'))
    ).toBe(true);

    // The next start retries, finds nothing left to move, and records it.
    const second = await migrateRoomTranscripts(aliceOnly());
    expect(second.marker?.moved).toBe(0);
    // The earlier pass's conflict is still named for the operator.
    expect(second.marker?.conflicts).toEqual([
      { source: setAside, destination: path.join(projectsDir(rootA, aliceHome), 's7.jsonl') },
    ]);
    expect(await exists(markerPath())).toBe(true);
  });

  it('writes a marker on an install with no rooms, replacing a stale temp file', async () => {
    await rm(path.join(dorkHome, 'rooms'), { recursive: true, force: true });
    await put(`${markerPath()}.tmp`, 'half a marker');

    const outcome = await migrateRoomTranscripts(aliceOnly());

    expect(outcome.marker).toMatchObject({ moved: 0, worktrees: [], conflicts: [] });
    expect(await readdir(path.join(dorkHome, 'migrations'))).toEqual([
      path.basename(ROOM_TRANSCRIPT_MIGRATION_MARKER),
    ]);
  });
});
