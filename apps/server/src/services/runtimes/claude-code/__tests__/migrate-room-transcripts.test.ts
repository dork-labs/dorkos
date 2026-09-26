import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { logger } from '../../../../lib/logger.js';
import { RoomWorktreeManager } from '../../../rooms/repo/room-worktree-manager.js';
import { discoverClaudeCodeTranscripts } from '../../../search/claude-code-discovery.js';
import { projectSlug } from '../sessions/project-slug.js';
import {
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
  let base: string;
  let dorkHome: string;
  let aliceHome: string;
  let bobHome: string;
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

  const put = async (file: string, body: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  };

  const projectsDir = (root: string, cwd: string) => path.join(root, 'projects', projectSlug(cwd));

  beforeEach(async () => {
    // realpath: macOS tmp is a symlink, and the SDK slugs the resolved path.
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'migrate-room-transcripts-')));
    dorkHome = path.join(base, 'dork');
    aliceHome = path.join(base, 'agents', 'alice');
    bobHome = path.join(base, 'agents', 'bob');
    await mkdir(aliceHome, { recursive: true });
    await mkdir(bobHome, { recursive: true });

    const aliceName = RoomWorktreeManager.slugFor('Alice', aliceHome);
    const bobName = RoomWorktreeManager.slugFor('Bob', bobHome);
    aliceWorktree = path.join(dorkHome, 'rooms', 'room-1', 'worktrees', aliceName);
    aliceWorktree2 = path.join(dorkHome, 'rooms', 'room-2', 'worktrees', aliceName);
    bobWorktree = path.join(dorkHome, 'rooms', 'room-1', 'worktrees', bobName);
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
    const marker = JSON.parse(
      await readFile(path.join(dorkHome, ROOM_TRANSCRIPT_MIGRATION_MARKER), 'utf-8')
    ) as RoomTranscriptMigrationMarker;
    expect(marker).toEqual(outcome.marker);
    expect(marker.moved).toBe(3);
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

  it('is a no-op once the marker is written', async () => {
    await put(
      path.join(projectsDir(rootA, aliceWorktree), 's1.jsonl'),
      transcript(aliceWorktree, 'one')
    );
    const deps = { dorkHome, claudeRoots: [rootA], agentPaths: [aliceHome] };
    await migrateRoomTranscripts(deps);
    const markerPath = path.join(dorkHome, ROOM_TRANSCRIPT_MIGRATION_MARKER);
    const markerBefore = await readFile(markerPath, 'utf-8');

    // A transcript that appears later is not the migration's to move.
    await put(
      path.join(projectsDir(rootA, aliceWorktree), 's9.jsonl'),
      transcript(aliceWorktree, 'late')
    );
    const second = await migrateRoomTranscripts(deps);

    expect(second.ran).toBe(false);
    expect(await exists(path.join(projectsDir(rootA, aliceWorktree), 's9.jsonl'))).toBe(true);
    expect(await exists(path.join(projectsDir(rootA, aliceHome), 's9.jsonl'))).toBe(false);
    expect(await readFile(markerPath, 'utf-8')).toBe(markerBefore);
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
    expect(await exists(path.join(dorkHome, ROOM_TRANSCRIPT_MIGRATION_MARKER))).toBe(false);
    expect(await exists(path.join(projectsDir(rootA, aliceHome), 's1.jsonl'))).toBe(true);
    expect(
      await exists(path.join(projectsDir(rootA, aliceHome), 's1', 'tool-results', 'r.txt'))
    ).toBe(true);

    // The next start retries, finds nothing left to move, and records it.
    const second = await migrateRoomTranscripts({
      dorkHome,
      claudeRoots: [rootA],
      agentPaths: [aliceHome],
    });
    expect(second.marker?.moved).toBe(0);
    // The earlier pass's conflict is still named for the operator.
    expect(second.marker?.conflicts).toEqual([
      { source: setAside, destination: path.join(projectsDir(rootA, aliceHome), 's7.jsonl') },
    ]);
    expect(await exists(path.join(dorkHome, ROOM_TRANSCRIPT_MIGRATION_MARKER))).toBe(true);
  });

  it('writes a marker on an install with no rooms', async () => {
    await rm(path.join(dorkHome, 'rooms'), { recursive: true, force: true });
    const outcome = await migrateRoomTranscripts({
      dorkHome,
      claudeRoots: [rootA],
      agentPaths: [aliceHome],
    });
    expect(outcome.marker).toMatchObject({ moved: 0, worktrees: [], conflicts: [] });
    expect(await readdir(path.join(dorkHome, 'migrations'))).toEqual([
      path.basename(ROOM_TRANSCRIPT_MIGRATION_MARKER),
    ]);
  });
});
