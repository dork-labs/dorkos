import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { readManifest, writeManifest, removeManifest, MANIFEST_DIR, MANIFEST_FILE } from '../manifest.js';
import type { AgentManifest } from '../mesh-schemas.js';

// === Helpers ===

function makeManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    id: '01HV7KJZZZ0000000000000000',
    name: 'test-agent',
    description: 'A test agent',
    runtime: 'claude-code',
    capabilities: ['code-review', 'testing'],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    registeredAt: '2026-02-24T00:00:00.000Z',
    registeredBy: 'test-suite',
    personaEnabled: true,
    enabledToolGroups: {},
    ...overrides,
  };
}

// === Tests ===

describe('manifest constants', () => {
  it('exports MANIFEST_DIR as ".dork"', () => {
    expect(MANIFEST_DIR).toBe('.dork');
  });

  it('exports MANIFEST_FILE as "agent.json"', () => {
    expect(MANIFEST_FILE).toBe('agent.json');
  });
});

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
      'utf-8',
    );

    const result = await readManifest(projectDir);
    expect(result).toBeNull();
  });

  it('returns parsed manifest for a valid file', async () => {
    const projectDir = await makeTempDir();
    const manifest = makeManifest();
    const dorkDir = path.join(projectDir, '.dork');
    await fs.mkdir(dorkDir, { recursive: true });
    await fs.writeFile(
      path.join(dorkDir, 'agent.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    const result = await readManifest(projectDir);
    expect(result).toEqual(manifest);
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

  it('creates .dork directory if it does not exist', async () => {
    const projectDir = await makeTempDir();
    const manifest = makeManifest();

    await expect(fs.access(path.join(projectDir, '.dork'))).rejects.toThrow();
    await writeManifest(projectDir, manifest);
    await expect(fs.access(path.join(projectDir, '.dork'))).resolves.toBeUndefined();
  });

  it('uses atomic temp-file + rename pattern (no leftover temp files)', async () => {
    const projectDir = await makeTempDir();
    const manifest = makeManifest();

    await writeManifest(projectDir, manifest);

    const dorkContents = await fs.readdir(path.join(projectDir, '.dork'));
    expect(dorkContents).toEqual(['agent.json']);
  });

  it('produces JSON with 2-space indentation and trailing newline', async () => {
    const projectDir = await makeTempDir();
    const manifest = makeManifest();

    await writeManifest(projectDir, manifest);

    const raw = await fs.readFile(path.join(projectDir, '.dork', 'agent.json'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  "id"');
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

  it('is best-effort and does not throw when file is missing', async () => {
    const projectDir = await makeTempDir();
    await expect(removeManifest(projectDir)).resolves.toBeUndefined();
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

  it('round-trips a manifest with persona, color, and icon fields', async () => {
    const projectDir = await makeTempDir();
    const manifest = makeManifest({
      persona: 'You are backend-bot, an expert in REST API design.',
      personaEnabled: true,
      color: '#6366f1',
      icon: '\u{1F916}',
    });

    await writeManifest(projectDir, manifest);
    const result = await readManifest(projectDir);

    expect(result).toEqual(manifest);
  });

  it('round-trips a basic manifest (personaEnabled defaults to true)', async () => {
    const projectDir = await makeTempDir();
    const manifest = makeManifest();

    await writeManifest(projectDir, manifest);
    const result = await readManifest(projectDir);

    expect(result).toEqual(manifest);
  });
});
