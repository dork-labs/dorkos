/**
 * What the scanner offers as a NEW agent, and in what order.
 *
 * Two rules, both of them consequences of ADR 260801-003050:
 *
 * 1. A directory that holds a `.dork/agent.json` FILE is never a candidate,
 *    whatever its registration state. The Register button mints a fresh ULID and
 *    overwrites the manifest, so offering it for a refused duplicate — or for a
 *    manifest that will not parse — would dirty a git-tracked file and, if that
 *    were merged, change the primary agent's id.
 * 2. A traversal is reproducible. `fs.readdir` order is filesystem-dependent,
 *    and identity used to be decided by it.
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-candidates-'));
  tempDirs.push(dir);
  return dir;
}

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function makeManifest(id: string): AgentManifest {
  return {
    workspace: { mode: 'home' },
    id,
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
  };
}

/** A logger whose warnings a test can read, standing in for the scan's own. */
function recordingLogger(): Logger & { warns: Array<[string, unknown]> } {
  const warns: Array<[string, unknown]> = [];
  return {
    warns,
    warn: (msg: unknown, ...rest: unknown[]) => void warns.push([String(msg), rest[0]]),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger & { warns: Array<[string, unknown]> };
}

/** Every unreadable-manifest warning the scan wrote, as its structured fields. */
function unreadableWarnings(
  logger: Logger & { warns: Array<[string, unknown]> }
): Array<{ projectPath?: string; detail?: string }> {
  return logger.warns
    .map(([, fields]) => fields as { event?: string; projectPath?: string; detail?: string })
    .filter((fields) => fields?.event === 'mesh.identity.manifest_unreadable');
}

/**
 * Make `dir` something a discovery strategy detects — an `AGENTS.md` is enough
 * for the instruction-file strategy.
 */
async function makeDetectable(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'AGENTS.md'), '# agent', 'utf-8');
  return dir;
}

/** Every candidate path a scan of `root` yields, in the order it yields them. */
async function candidatePaths(mesh: MeshCore, root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const event of mesh.discover([root])) {
    if (event.type === 'candidate') paths.push(event.data.path);
  }
  return paths;
}

describe('a directory that already has an identity is never a candidate', () => {
  it('does not offer a REFUSED duplicate checkout as a new agent', async () => {
    const base = await makeTempDir();
    const primary = await makeDetectable(path.join(base, 'repo'));
    const copy = await makeDetectable(path.join(base, 'copy'));
    const manifest = makeManifest('01ANA0000000000000000000A');
    await writeManifest(primary, manifest);
    await writeManifest(copy, manifest);

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: recordingLogger() });
    const candidates = await candidatePaths(mesh, base);

    // The copy is refused — one row, at the primary — and it is offered to
    // nobody. `isRegistered` alone would have offered it: it has no row.
    expect(mesh.listWithPaths()).toHaveLength(1);
    expect(candidates).not.toContain(copy);
    expect(candidates).not.toContain(primary);

    mesh.close();
  });

  it('does not offer a directory whose manifest will not parse — it names it instead', async () => {
    const base = await makeTempDir();
    const broken = await makeDetectable(path.join(base, 'broken'));
    await fs.mkdir(path.join(broken, MANIFEST_DIR), { recursive: true });
    await fs.writeFile(path.join(broken, MANIFEST_DIR, MANIFEST_FILE), '{ not json', 'utf-8');

    const logger = recordingLogger();
    const mesh = new MeshCore({ db, defaultScanRoot: base, logger });
    const candidates = await candidatePaths(mesh, base);

    // Not importable and not offerable. The only affordance a scan used to give
    // was a Register click, which would have papered over the corruption by
    // overwriting a tracked file with a fresh id.
    expect(mesh.listWithPaths()).toHaveLength(0);
    expect(candidates).not.toContain(broken);
    // So the log is what makes the recovery — fix it or delete it — reachable,
    // and it has to carry the path AND what is wrong with the file.
    const named = unreadableWarnings(logger);
    expect(named.map((fields) => fields.projectPath)).toEqual([broken]);
    expect(named[0]!.detail).toBeTruthy();

    mesh.close();
  });

  it('names a manifest it could not READ, rather than leaving it invisible', async () => {
    // The gap this closes: `readManifest` is silent on an I/O failure, and the
    // directory is no longer offered as a candidate either — so an unreadable
    // manifest had nothing anywhere to say it existed. It is also the state a
    // person is least able to guess at, because nothing about the room or the
    // agent list changes.
    const base = await makeTempDir();
    const locked = await makeDetectable(path.join(base, 'locked'));
    await writeManifest(locked, makeManifest('01ANA0000000000000000000A'));
    const manifestFile = path.join(locked, MANIFEST_DIR, MANIFEST_FILE);
    await fs.chmod(manifestFile, 0o000);

    const logger = recordingLogger();
    const mesh = new MeshCore({ db, defaultScanRoot: base, logger });
    let candidates: string[];
    try {
      candidates = await candidatePaths(mesh, base);
    } finally {
      await fs.chmod(manifestFile, 0o600);
    }

    expect(candidates).not.toContain(locked);
    const named = unreadableWarnings(logger);
    expect(named.map((fields) => fields.projectPath)).toEqual([locked]);
    expect(named[0]!.detail).toBe('EACCES');

    mesh.close();
  });

  it('treats a `.dork/agent.json` that is a DIRECTORY as an identity, not a fresh project', async () => {
    // A broken install, not a new agent — and Register would fail inside
    // `writeManifest` anyway. It reads as unreadable, so it is refused AND named.
    const base = await makeTempDir();
    const odd = await makeDetectable(path.join(base, 'odd'));
    await fs.mkdir(path.join(odd, MANIFEST_DIR, MANIFEST_FILE), { recursive: true });

    const logger = recordingLogger();
    const mesh = new MeshCore({ db, defaultScanRoot: base, logger });
    const candidates = await candidatePaths(mesh, base);

    expect(candidates).not.toContain(odd);
    expect(unreadableWarnings(logger).map((fields) => fields.projectPath)).toContain(odd);

    mesh.close();
  });

  it('still offers an ordinary un-agented project', async () => {
    // The other half: this guard must not have quietly closed discovery.
    const base = await makeTempDir();
    const fresh = await makeDetectable(path.join(base, 'fresh'));

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: recordingLogger() });
    expect(await candidatePaths(mesh, base)).toContain(fresh);

    mesh.close();
  });
});

describe('a traversal is reproducible', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('walks a directory in sorted order, whatever order the filesystem lists it in', async () => {
    // **`readdir` is forced to lie, and it has to be.** `fs.readdir` order is
    // filesystem-dependent — the whole reason the sort exists — and on APFS it
    // comes back alphabetical already, so a fixture tree alone cannot tell a
    // sorted walk from an unsorted one. Reversing what the scanner is handed is
    // what makes this test fail when the sort is removed, which was checked by
    // removing it.
    const base = await makeTempDir();
    const created: string[] = [];
    for (const name of ['alpha', 'charlie', 'delta', 'yankee', 'zeta']) {
      created.push(await makeDetectable(path.join(base, name)));
    }

    type Readdir = (dir: unknown, options?: unknown) => Promise<unknown>;
    const realReaddir = fs.readdir.bind(fs) as unknown as Readdir;
    const reversing: Readdir = async (dir, options) => {
      const entries = await realReaddir(dir, options);
      return Array.isArray(entries) ? [...entries].reverse() : entries;
    };
    vi.spyOn(fs, 'readdir').mockImplementation(reversing as unknown as typeof fs.readdir);

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: recordingLogger() });
    const first = await candidatePaths(mesh, base);
    const second = await candidatePaths(mesh, base);

    expect(first).toEqual(created);
    // And identical across runs, which is the property the sort is for.
    expect(second).toEqual(first);

    mesh.close();
  });
});
