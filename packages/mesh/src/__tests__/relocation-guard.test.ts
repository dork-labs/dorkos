/**
 * The relocation guard: a duplicate manifest never registers, and a genuine
 * move still works (ADR 260801-003050).
 *
 * `.dork/agent.json` is git-tracked, so every clone and linked worktree of an
 * agent's repo carries the same manifest ULID — on the machine this was written
 * against, ten checkouts shared one id. Registration used to resolve that by
 * rewriting `project_path` to whichever copy a scan reached last, so the agent's
 * `@handle` stopped resolving, its `responseMode` fell back to `'always'`, and
 * its room membership 404'd, flipping back on the next scan.
 *
 * Every test here is driven through the real `MeshCore` over a real temp
 * directory, because the whole mechanism is a decision about what is on disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Logger } from '@dorkos/shared/logger';
import { MeshCore } from '../mesh-core.js';
import { writeManifest, MANIFEST_DIR, MANIFEST_FILE } from '../manifest.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocation-guard-'));
  tempDirs.push(dir);
  return dir;
}

let db: Db;

beforeEach(() => {
  tempDirs.length = 0;
  db = createTestDb();
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function makeManifest(overrides: Partial<AgentManifest> & { id: string }): AgentManifest {
  return {
    workspace: { mode: 'home' },
    name: 'ana',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-08-01T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
    ...overrides,
  };
}

/** A logger that records every line, so a test can read what an operator would. */
function recordingLogger(): Logger & {
  warns: Array<[string, unknown]>;
  infos: Array<[string, unknown]>;
} {
  const warns: Array<[string, unknown]> = [];
  const infos: Array<[string, unknown]> = [];
  return {
    warns,
    infos,
    warn: (msg: unknown, ...rest: unknown[]) => void warns.push([String(msg), rest[0]]),
    info: (msg: unknown, ...rest: unknown[]) => void infos.push([String(msg), rest[0]]),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger & { warns: Array<[string, unknown]>; infos: Array<[string, unknown]> };
}

/**
 * Where an agent is registered, or `undefined` when it is not.
 *
 * `MeshCore.list`/`get` return the projectPath-STRIPPED manifest shape, and the
 * whole subject here is which directory a row points at — so the read has to be
 * the one that carries it.
 */
function pathOf(mesh: MeshCore, agentId: string): string | undefined {
  return mesh.listWithPaths().find((agent) => agent.id === agentId)?.projectPath;
}

/** Write a manifest into `dir`, creating it first. */
async function seedAgent(dir: string, manifest: AgentManifest): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await writeManifest(dir, manifest);
}

// ---------------------------------------------------------------------------
// §5.1 + §5.2 — a duplicate is refused, and the refusal costs nothing
// ---------------------------------------------------------------------------

describe('a duplicate manifest never registers', () => {
  it('leaves both rows untouched and says so once, naming every rejected copy', async () => {
    const base = await makeTempDir();
    const logger = recordingLogger();
    const primary = path.join(base, 'repo');
    const worktreeOne = path.join(base, 'worktrees', 'one');
    const worktreeTwo = path.join(base, 'worktrees', 'two');
    const manifest = makeManifest({ id: '01ANA0000000000000000000A' });
    for (const dir of [primary, worktreeOne, worktreeTwo]) await seedAgent(dir, manifest);

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger });
    // A whole scan, so the aggregation is exercised the way a scan exercises it.
    for await (const _ of mesh.discover([base])) void _;

    // Exactly one row, and it is the first copy the sorted walk reached.
    const rows = mesh.listWithPaths();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.projectPath).toBe(primary);

    // ONE warning for the whole scan, naming BOTH rejected copies. A per-pair
    // damp would print one line per worktree; a per-process damp would never
    // print again after the situation changed.
    const refusals = logger.warns.filter(
      ([, fields]) =>
        (fields as { event?: string } | undefined)?.event === 'mesh.identity.duplicate_manifest'
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]![1]).toMatchObject({
      agentId: manifest.id,
      registeredPath: primary,
    });
    expect((refusals[0]![1] as { rejectedPaths: string[] }).rejectedPaths.sort()).toEqual(
      [worktreeOne, worktreeTwo].sort()
    );

    mesh.close();
  });

  it('THE B1 SCENARIO: a refused registration does not delete the agent already at that path', async () => {
    // The ordering defect this guard could have introduced, and the reason the
    // id conflict is resolved BEFORE the path-incumbent delete. `/w` is
    // registered as X; `/w` then checks out a branch carrying D's committed
    // manifest. Under the old ordering X was deleted and D was refused, leaving
    // `/w` agent-less and X gone.
    const base = await makeTempDir();
    const dHome = path.join(base, 'd-home');
    const workspace = path.join(base, 'w');
    const dManifest = makeManifest({ id: '01DDD0000000000000000000D', name: 'dee' });
    await seedAgent(dHome, dManifest);
    await seedAgent(workspace, makeManifest({ id: '01XXX0000000000000000000X', name: 'ex' }));

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    for await (const _ of mesh.discover([base])) void _;
    expect(mesh.listWithPaths()).toHaveLength(2);

    // The branch switch: `/w` now carries D's manifest too.
    await writeManifest(workspace, dManifest);
    await mesh.syncFromDisk(workspace);

    // D stayed home, and X — who was never mentioned — is still registered.
    expect(pathOf(mesh, '01DDD0000000000000000000D')).toBe(dHome);
    expect(pathOf(mesh, '01XXX0000000000000000000X')).toBe(workspace);

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// §5.3 — errno discipline
// ---------------------------------------------------------------------------

describe('what the incumbent directory says decides the outcome', () => {
  it("relocates when the incumbent's manifest is gone (ENOENT)", async () => {
    const base = await makeTempDir();
    const logger = recordingLogger();
    const oldHome = path.join(base, 'old');
    const newHome = path.join(base, 'new');
    const manifest = makeManifest({ id: '01ANA0000000000000000000A' });
    await seedAgent(oldHome, manifest);

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger });
    await mesh.syncFromDisk(oldHome);
    expect(pathOf(mesh, manifest.id)).toBe(oldHome);

    // A genuine move: the directory is emptied and the manifest reappears next
    // door. ADR-0043's file-first contract says this must keep working.
    await fs.rm(path.join(oldHome, MANIFEST_DIR), { recursive: true, force: true });
    await seedAgent(newHome, manifest);
    expect(await mesh.syncFromDisk(newHome)).toBe('synced');

    expect(pathOf(mesh, manifest.id)).toBe(newHome);
    expect(mesh.listWithPaths()).toHaveLength(1);
    expect(
      logger.infos.some(
        ([, fields]) =>
          (fields as { event?: string } | undefined)?.event === 'mesh.identity.relocated'
      )
    ).toBe(true);

    mesh.close();
  });

  it('relocates when the incumbent now carries a DIFFERENT id', async () => {
    const base = await makeTempDir();
    const oldHome = path.join(base, 'old');
    const newHome = path.join(base, 'new');
    const manifest = makeManifest({ id: '01ANA0000000000000000000A' });
    await seedAgent(oldHome, manifest);

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    await mesh.syncFromDisk(oldHome);

    // The old directory was re-inited: it holds somebody else's identity now,
    // so it has genuinely given this one up.
    await writeManifest(oldHome, makeManifest({ id: '01BOB0000000000000000000B', name: 'bo' }));
    await seedAgent(newHome, manifest);

    expect(await mesh.syncFromDisk(newHome)).toBe('synced');
    expect(pathOf(mesh, manifest.id)).toBe(newHome);

    mesh.close();
  });

  it('refuses when the incumbent manifest cannot be READ, rather than assuming it is gone', async () => {
    // The irreversible direction. Treating a transient EACCES/EIO as "gone"
    // hands the identity to the duplicate — and the guard would then refuse the
    // true owner's return, with no way back.
    const base = await makeTempDir();
    const logger = recordingLogger();
    const home = path.join(base, 'home');
    const copy = path.join(base, 'copy');
    const manifest = makeManifest({ id: '01ANA0000000000000000000A' });
    await seedAgent(home, manifest);
    await seedAgent(copy, manifest);

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger });
    await mesh.syncFromDisk(home);

    // Drop read permission on the file itself — a real EACCES, not a mock.
    const manifestFile = path.join(home, MANIFEST_DIR, MANIFEST_FILE);
    await fs.chmod(manifestFile, 0o000);
    try {
      expect(await mesh.syncFromDisk(copy)).toBe('duplicate-id');
    } finally {
      await fs.chmod(manifestFile, 0o600);
    }

    // Nothing moved, and nothing new was written.
    expect(pathOf(mesh, manifest.id)).toBe(home);
    expect(mesh.listWithPaths()).toHaveLength(1);
    expect(
      logger.warns.some(
        ([, fields]) =>
          (fields as { event?: string } | undefined)?.event === 'mesh.identity.incumbent_unreadable'
      )
    ).toBe(true);

    mesh.close();
  });

  it('refuses when the incumbent still carries the SAME id', async () => {
    const base = await makeTempDir();
    const home = path.join(base, 'home');
    const copy = path.join(base, 'copy');
    const manifest = makeManifest({ id: '01ANA0000000000000000000A' });
    await seedAgent(home, manifest);
    await seedAgent(copy, manifest);

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    await mesh.syncFromDisk(home);

    expect(await mesh.syncFromDisk(copy)).toBe('duplicate-id');
    expect(pathOf(mesh, manifest.id)).toBe(home);

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// §5.4 — relocate owns the destination's incumbent
// ---------------------------------------------------------------------------

describe('relocating onto an occupied directory', () => {
  it('replaces the row already there instead of throwing a UNIQUE constraint', async () => {
    // **The state the guard itself makes reachable.** `/w` is registered as X.
    // D's manifest is checked out into `/w`, AND D's old home has genuinely lost
    // its manifest — so this is a true relocation whose destination is taken.
    // `agents.project_path` is NOT NULL UNIQUE, so a `relocate` that did not own
    // the incumbent would throw SQLITE_CONSTRAINT out of `syncFromDisk` and, on
    // the scan path, abort the whole `discover()` generator with an opaque
    // error — trading a silent theft for a dead scan.
    const base = await makeTempDir();
    const dHome = path.join(base, 'd-home');
    const workspace = path.join(base, 'w');
    const dManifest = makeManifest({ id: '01DDD0000000000000000000D', name: 'dee' });
    await seedAgent(dHome, dManifest);
    await seedAgent(workspace, makeManifest({ id: '01XXX0000000000000000000X', name: 'ex' }));

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    for await (const _ of mesh.discover([base])) void _;
    expect(mesh.listWithPaths()).toHaveLength(2);

    // D moves house: its old home is emptied and its manifest lands in `/w`,
    // which X still holds.
    await fs.rm(path.join(dHome, MANIFEST_DIR), { recursive: true, force: true });
    await writeManifest(workspace, dManifest);

    await expect(mesh.syncFromDisk(workspace)).resolves.toBe('synced');

    // D lives at `/w` now, and X — the incumbent it replaced — is gone, which is
    // the same replace-the-path-incumbent rule an ordinary registration follows.
    expect(pathOf(mesh, '01DDD0000000000000000000D')).toBe(workspace);
    expect(pathOf(mesh, '01XXX0000000000000000000X')).toBeUndefined();
    expect(mesh.listWithPaths()).toHaveLength(1);

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// §5.6 — the contract stops lying
// ---------------------------------------------------------------------------

describe('syncFromDisk reports what it actually did', () => {
  it("says 'duplicate-id' for a refused duplicate — never the same answer as an empty directory", async () => {
    const base = await makeTempDir();
    const home = path.join(base, 'home');
    const copy = path.join(base, 'copy');
    const manifest = makeManifest({ id: '01ANA0000000000000000000A' });
    await seedAgent(home, manifest);
    await seedAgent(copy, manifest);

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    expect(await mesh.syncFromDisk(home)).toBe('synced');

    const refused = await mesh.syncFromDisk(copy);
    expect(refused).toBe('duplicate-id');
    // The distinction that matters: this is not the answer an agent-less
    // directory gives. Collapsing them is the readManifest defect one layer up.
    expect(refused).not.toBe(await mesh.syncFromDisk(path.join(base, 'nothing-here')));

    mesh.close();
  });
});
