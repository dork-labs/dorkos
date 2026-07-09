import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { parseArchiveArgs, runArchive } from '../archive.js';

/**
 * Unit tests for the archive primitive: label parsing/validation, selective
 * `--shots` filtering, the immutability guard, and the archive manifest
 * projection. Uses a throwaway published-output fixture dir (`runArchive`
 * accepts an output root for exactly this), mirroring `overrides.test.ts`.
 *
 * @module capture/__tests__/archive
 */
let outputDir: string;

beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-archive-test-'));
});

afterEach(async () => {
  await fs.rm(outputDir, { recursive: true, force: true });
});

/** Write a minimal published set (manifest + asset files) into the fixture dir. */
async function publishFixture(): Promise<void> {
  const assets = [
    { file: 'cockpit-light.png', surface: 'cockpit', bytes: 3 },
    { file: 'topology-light.png', surface: 'topology', bytes: 3 },
    { file: 'topology-dark.webm', surface: 'topology', bytes: 3 },
  ];
  for (const a of assets) await fs.writeFile(path.join(outputDir, a.file), 'x');
  await fs.writeFile(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      generatedAt: '2026-07-09T00:00:00.000Z',
      runId: 'run-1',
      shots: [
        { id: 'cockpit', kind: 'still', frame: 'desktop', consumers: ['marketing'] },
        { id: 'topology', kind: 'loop', frame: 'desktop', consumers: ['marketing'] },
      ],
      assets,
    })
  );
}

describe('parseArchiveArgs', () => {
  it('parses a bare label', () => {
    expect(parseArchiveArgs(['v0.45.0'])).toEqual({ label: 'v0.45.0', shots: undefined });
  });

  it('parses --shots into a trimmed list', () => {
    expect(parseArchiveArgs(['v1', '--shots', ' a, b ,c '])).toEqual({
      label: 'v1',
      shots: ['a', 'b', 'c'],
    });
  });

  it('requires a label', () => {
    expect(() => parseArchiveArgs([])).toThrow(/requires a <label>/);
  });

  it('requires a value after --shots', () => {
    expect(() => parseArchiveArgs(['v1', '--shots'])).toThrow(/comma-separated/);
  });

  it('rejects labels with unsafe characters', () => {
    expect(() => parseArchiveArgs(['../escape'])).toThrow(/invalid archive label/);
    expect(() => parseArchiveArgs(['a b'])).toThrow(/invalid archive label/);
  });
});

describe('runArchive', () => {
  it('fails actionably when nothing is published', async () => {
    await expect(runArchive({ label: 'v1' }, outputDir)).rejects.toThrow(/no published manifest/);
  });

  it('archives the full published set with an archive manifest', async () => {
    await publishFixture();
    await runArchive({ label: 'v1' }, outputDir);
    const dest = path.join(outputDir, 'archive', 'v1');
    const files = (await fs.readdir(dest)).sort();
    expect(files).toEqual([
      'cockpit-light.png',
      'manifest.json',
      'topology-dark.webm',
      'topology-light.png',
    ]);
    const manifest = JSON.parse(await fs.readFile(path.join(dest, 'manifest.json'), 'utf8'));
    expect(manifest.label).toBe('v1');
    expect(manifest.count).toBe(3);
    expect(manifest.source).toEqual({
      schemaVersion: 2,
      generatedAt: '2026-07-09T00:00:00.000Z',
      runId: 'run-1',
    });
    expect(manifest.shots.map((s: { id: string }) => s.id).sort()).toEqual(['cockpit', 'topology']);
  });

  it('archives only the requested shots with --shots', async () => {
    await publishFixture();
    await runArchive({ label: 'v1', shots: ['topology'] }, outputDir);
    const dest = path.join(outputDir, 'archive', 'v1');
    const files = (await fs.readdir(dest)).sort();
    expect(files).toEqual(['manifest.json', 'topology-dark.webm', 'topology-light.png']);
    const manifest = JSON.parse(await fs.readFile(path.join(dest, 'manifest.json'), 'utf8'));
    expect(manifest.shots.map((s: { id: string }) => s.id)).toEqual(['topology']);
    expect(manifest.count).toBe(2);
  });

  it('refuses to overwrite an existing archive (immutability)', async () => {
    await publishFixture();
    await runArchive({ label: 'v1' }, outputDir);
    await expect(runArchive({ label: 'v1' }, outputDir)).rejects.toThrow(/already exists/);
  });

  it('fails when a requested shot has no published assets', async () => {
    await publishFixture();
    await expect(runArchive({ label: 'v1', shots: ['nope'] }, outputDir)).rejects.toThrow(
      /no published assets match shots/
    );
  });

  it('names the missing shot when the filter is only partially covered', async () => {
    await publishFixture();
    await expect(
      runArchive({ label: 'v1', shots: ['topology', 'ghost'] }, outputDir)
    ).rejects.toThrow(/no published assets for requested shot\(s\): ghost/);
  });
});
