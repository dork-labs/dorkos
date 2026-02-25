import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { readManifest, writeManifest } from '../manifest.js';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

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
    ...overrides,
  };
}

// === Tests ===

describe('readManifest / writeManifest', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-manifest-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('round-trips: write a manifest and read it back with equal values', async () => {
    const projectDir = await makeTempDir();
    const manifest = makeManifest();

    await writeManifest(projectDir, manifest);
    const result = await readManifest(projectDir);

    expect(result).toEqual(manifest);
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

  it('returns null when the manifest fails Zod validation (missing required fields)', async () => {
    const projectDir = await makeTempDir();
    const dorkDir = path.join(projectDir, '.dork');
    await fs.mkdir(dorkDir, { recursive: true });
    // Missing required fields: id, name, runtime, registeredAt, registeredBy
    await fs.writeFile(
      path.join(dorkDir, 'agent.json'),
      JSON.stringify({ name: 'incomplete' }),
      'utf-8',
    );

    const result = await readManifest(projectDir);
    expect(result).toBeNull();
  });

  it('creates .dork/ directory if it does not exist', async () => {
    const projectDir = await makeTempDir();
    const manifest = makeManifest();

    // .dork/ does not exist yet
    await expect(fs.access(path.join(projectDir, '.dork'))).rejects.toThrow();

    await writeManifest(projectDir, manifest);

    // .dork/ should now exist
    await expect(fs.access(path.join(projectDir, '.dork'))).resolves.toBeUndefined();
  });

  it('uses atomic write (temp file + rename): file exists and is valid after write', async () => {
    const projectDir = await makeTempDir();
    const manifest = makeManifest();

    await writeManifest(projectDir, manifest);

    const manifestPath = path.join(projectDir, '.dork', 'agent.json');
    await expect(fs.access(manifestPath)).resolves.toBeUndefined();

    // Ensure no leftover temp files
    const dorkContents = await fs.readdir(path.join(projectDir, '.dork'));
    expect(dorkContents).toEqual(['agent.json']);
  });

  it('produces human-readable JSON with 2-space indentation and a trailing newline', async () => {
    const projectDir = await makeTempDir();
    const manifest = makeManifest();

    await writeManifest(projectDir, manifest);

    const raw = await fs.readFile(path.join(projectDir, '.dork', 'agent.json'), 'utf-8');

    // Should end with a newline
    expect(raw.endsWith('\n')).toBe(true);

    // Should be valid JSON that round-trips
    const parsed = JSON.parse(raw) as unknown;
    expect(parsed).toEqual(manifest);

    // Should contain 2-space indented lines (e.g., the "id" key)
    expect(raw).toContain('  "id"');
  });
});
