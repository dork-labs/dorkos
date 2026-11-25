import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  readManifest,
  writeManifest,
  removeManifest,
  removeDorkDirectory,
  MANIFEST_DIR,
  MANIFEST_FILE,
} from '../manifest.js';
import type { AgentManifest } from '../mesh-schemas.js';

// === Helpers ===

function makeManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    workspace: { mode: 'home' },
    id: '01HV7KJZZZ0000000000000000',
    name: 'test-agent',
    description: 'A test agent',
    runtime: 'claude-code',
    capabilities: ['code-review', 'testing'],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-02-24T00:00:00.000Z',
    registeredBy: 'test-suite',
    personaEnabled: true,
    isSystem: false,
    mcpServers: [],
    ...overrides,
  };
}

describe('readManifest', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-manifest-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when .dork/agent.json does not exist', async () => {
    const projectDir = await makeTempDir();
    const result = await readManifest(projectDir);
    expect(result).toBeNull();
  });

  it('returns null when the file contains invalid JSON', async () => {
    const projectDir = await makeTempDir();
    const dorkDir = path.join(projectDir, '.dork');
    await fs.mkdir(dorkDir, { recursive: true });
    await fs.writeFile(path.join(dorkDir, 'agent.json'), 'not-valid-json', 'utf-8');

    const result = await readManifest(projectDir);
    expect(result).toBeNull();
  });

  it('returns null when JSON fails Zod validation (missing required fields)', async () => {
    const projectDir = await makeTempDir();
    const dorkDir = path.join(projectDir, '.dork');
    await fs.mkdir(dorkDir, { recursive: true });
    await fs.writeFile(
      path.join(dorkDir, 'agent.json'),
      JSON.stringify({ name: 'incomplete' }),
      'utf-8'
    );

    const result = await readManifest(projectDir);
    expect(result).toBeNull();
  });

  it('keeps the agent when a hand-edited execution setting is nonsense', async () => {
    // A typo in `effort` must cost that one field, not the agent: a null from
    // here reads as "no agent registered at this path" to every caller, so the
    // agent would drop out of the fleet, out of the mesh, and out of its rooms.
    const projectDir = await makeTempDir();
    const dorkDir = path.join(projectDir, '.dork');
    await fs.mkdir(dorkDir, { recursive: true });
    await fs.writeFile(
      path.join(dorkDir, 'agent.json'),
      JSON.stringify({ ...makeManifest({ model: 'sonnet' }), effort: 'ludicrous' }, null, 2),
      'utf-8'
    );

    const result = await readManifest(projectDir);
    expect(result?.name).toBe('test-agent');
    expect(result?.model).toBe('sonnet');
    expect(result?.effort).toBeUndefined();
  });
});

describe('writeManifest', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-manifest-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('uses atomic temp-file + rename pattern (no leftover temp files)', async () => {
    const projectDir = await makeTempDir();
    const manifest = makeManifest();

    await writeManifest(projectDir, manifest);

    const dorkContents = await fs.readdir(path.join(projectDir, '.dork'));
    expect(dorkContents).toEqual(['agent.json']);
  });

  it('throws and writes nothing when the manifest fails schema validation', async () => {
    const projectDir = await makeTempDir();
    // Invalid: unknown runtime value — would safeParse to null forever if written.
    const invalid = makeManifest({ runtime: 'gpt5' as AgentManifest['runtime'] });

    await expect(writeManifest(projectDir, invalid)).rejects.toThrow(/invalid agent manifest/i);

    // No .dork directory or file is created on a rejected write.
    await expect(fs.access(path.join(projectDir, '.dork'))).rejects.toThrow();
  });
});

describe('removeManifest', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-manifest-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('removes existing manifest file', async () => {
    const projectDir = await makeTempDir();
    const manifest = makeManifest();
    await writeManifest(projectDir, manifest);

    await removeManifest(projectDir);

    const result = await readManifest(projectDir);
    expect(result).toBeNull();
  });
});

describe('removeDorkDirectory', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-manifest-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns deleted file list when .dork directory exists', async () => {
    const projectDir = await makeTempDir();
    const manifest = makeManifest();
    await writeManifest(projectDir, manifest);

    // Add an extra file to the .dork directory
    await fs.writeFile(path.join(projectDir, '.dork', 'extra.txt'), 'data', 'utf-8');

    const deleted = await removeDorkDirectory(projectDir);

    expect(deleted).toEqual(
      expect.arrayContaining([
        path.join(MANIFEST_DIR, 'agent.json'),
        path.join(MANIFEST_DIR, 'extra.txt'),
      ])
    );
    expect(deleted).toHaveLength(2);

    // Directory should be gone
    await expect(fs.access(path.join(projectDir, '.dork'))).rejects.toThrow();
  });
});

describe('legacy budget key tolerance (DOR-265)', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-manifest-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Purpose: proves the zero-touch backward-compat contract from the
  // agent-budget-enforcement removal — old agent.json files that still carry
  // the retired `budget` key load fine forever (Zod strips unknown keys by
  // default), and the stale key is removed from disk on the manifest's next
  // write. No migration of on-disk files is required.
  it('strips a stale top-level budget key on read and removes it from disk on next write', async () => {
    const projectDir = await makeTempDir();
    const dorkDir = path.join(projectDir, '.dork');
    await fs.mkdir(dorkDir, { recursive: true });

    const legacyManifestJson = {
      ...makeManifest(),
      budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    };
    await fs.writeFile(
      path.join(dorkDir, 'agent.json'),
      JSON.stringify(legacyManifestJson, null, 2),
      'utf-8'
    );

    const warn = vi.fn();
    const result = await readManifest(projectDir, { warn });

    // Strip path, not the invalid-manifest path: safeParse succeeds, no warning.
    expect(result).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('budget');

    // The stripped in-memory manifest is what gets persisted on next write —
    // the stale key is gone from disk, with no special-case migration code.
    await writeManifest(projectDir, result!);
    const raw = await fs.readFile(path.join(dorkDir, 'agent.json'), 'utf-8');
    expect(raw).not.toContain('budget');
  });
});

describe('writeManifest cleanup on failure', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-manifest-temp-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves no temp file behind when the rename cannot land', async () => {
    const projectDir = await makeTempDir();
    const dorkDir = path.join(projectDir, MANIFEST_DIR);
    await fs.mkdir(dorkDir, { recursive: true });
    // A directory where agent.json goes makes the rename fail after the temp
    // file has already been written, which is the shape a full disk produces.
    await fs.mkdir(path.join(dorkDir, MANIFEST_FILE));

    await expect(writeManifest(projectDir, makeManifest())).rejects.toThrow();

    // No stray `.agent-<uuid>.tmp` left for the user to find.
    expect(await fs.readdir(dorkDir)).toEqual([MANIFEST_FILE]);
  });
});

describe('round-trip with new fields', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-manifest-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write, and reads back null, when an mcpServers entry is malformed', async () => {
    const projectDir = await makeTempDir();
    // A stdio entry with an empty command is invalid — the array is strict (no
    // `.catch`), so the whole manifest must fail rather than shed the server.
    // Built through `unknown` because the shape is deliberately off-schema.
    const bad = {
      ...makeManifest(),
      mcpServers: [
        {
          name: 'broken',
          enabled: true,
          connection: { transport: 'stdio', command: '' },
          addedAt: '2026-08-03T00:00:00.000Z',
          addedBy: 'dorian',
        },
      ],
    } as unknown as AgentManifest;

    await expect(writeManifest(projectDir, bad)).rejects.toThrow(/invalid agent manifest/i);

    // And if such a file somehow lands on disk, readManifest returns null
    // (present-but-invalid) rather than silently dropping the bad entry.
    const manifestPath = path.join(projectDir, MANIFEST_DIR, MANIFEST_FILE);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(bad), 'utf-8');
    const warn = vi.fn();
    expect(await readManifest(projectDir, { warn })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('workspace binding (spec `agent-workspace-binding` §3.1)', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-manifest-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // The migration guarantee: every manifest written before the field existed
  // keeps meaning what it already meant.
  it('a manifest with no workspace field reads as home', async () => {
    const projectDir = await makeTempDir();
    const { workspace: _dropped, ...legacy } = makeManifest();
    const manifestPath = path.join(projectDir, MANIFEST_DIR, MANIFEST_FILE);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(legacy), 'utf-8');

    const result = await readManifest(projectDir);

    expect(result?.workspace).toEqual({ mode: 'home' });
  });

  // `.catch()`-degraded, on the `model`/`effort` precedent. Refusing the parse
  // would cost the agent its whole presence in the fleet — `readManifest`
  // answers `null`, and every list, roster and router stops seeing it — over a
  // typo that changes no cwd, since an unreadable manifest already resolves to
  // the agent's own folder, which is exactly what `home` means.
  it('an unreadable binding reads as home instead of losing the agent', async () => {
    const projectDir = await makeTempDir();
    const manifestPath = path.join(projectDir, MANIFEST_DIR, MANIFEST_FILE);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ ...makeManifest(), workspace: { mode: 'ludicrous' } }),
      'utf-8'
    );
    const warn = vi.fn();

    const result = await readManifest(projectDir, { warn });

    expect(result).not.toBeNull();
    expect(result?.workspace).toEqual({ mode: 'home' });
    // Degrading is fine; degrading QUIETLY is not. The warning cannot come from
    // the schema — a function `.catch()` breaks JSON Schema generation for every
    // MCP tool that embeds the manifest — so `readManifest` says it instead.
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/workspace binding this build cannot read/)
    );
  });

  // Forward compatibility, which is the other half of the same decision: a mode
  // written by a NEWER build must not make the agent vanish on a downgrade. It
  // reads as `home` here and stays on disk verbatim, so the newer build still
  // finds what it wrote.
  it('keeps an unknown mode on disk while reading it as home', async () => {
    const projectDir = await makeTempDir();
    const warn = vi.fn();
    const future = {
      ...makeManifest(),
      workspace: { mode: 'room-worktree', roomId: 'r1' },
    } as unknown as AgentManifest;

    await writeManifest(projectDir, future);
    const reread = await readManifest(projectDir, { warn });
    const raw: unknown = JSON.parse(
      await fs.readFile(path.join(projectDir, MANIFEST_DIR, MANIFEST_FILE), 'utf-8')
    );

    expect(reread?.workspace).toEqual({ mode: 'home' });
    expect((raw as AgentManifest).workspace).toEqual({ mode: 'room-worktree', roomId: 'r1' });
    expect(warn).toHaveBeenCalled();
  });
});
