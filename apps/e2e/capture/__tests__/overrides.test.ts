import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { autoSkippedShotIds, discoverOverrides } from '../overrides.js';

/**
 * Unit tests for override discovery and validation. Uses a throwaway fixture
 * directory (the discover/skip functions accept a root for exactly this) so no
 * real committed override is needed.
 *
 * @module capture/__tests__/overrides
 */
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-overrides-test-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Write a fixture override dir under the test root. */
async function fixture(id: string, files: Record<string, string>): Promise<void> {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content);
  }
}

describe('discoverOverrides', () => {
  it('returns nothing when the overrides dir is empty', async () => {
    expect(await discoverOverrides(root)).toEqual([]);
  });

  it('discovers a still override with its provenance', async () => {
    await fixture('cockpit', {
      'still-light.png': 'x',
      'override.json': JSON.stringify({ reason: 'hand-tuned hero', capturedBy: 'design' }),
    });
    const found = await discoverOverrides(root);
    expect(found).toHaveLength(1);
    expect(found[0]!.shot.id).toBe('cockpit');
    expect(found[0]!.stillPath).toBeDefined();
    expect(found[0]!.loopPath).toBeUndefined();
    expect(found[0]!.meta.reason).toBe('hand-tuned hero');
  });

  it('discovers a loop override on a loop shot', async () => {
    await fixture('topology', { 'loop-dark.mp4': 'x' });
    const found = await discoverOverrides(root);
    expect(found[0]!.loopPath?.endsWith('loop-dark.mp4')).toBe(true);
  });

  it('ignores a directory with no media files', async () => {
    await fixture('cockpit', { 'override.json': '{}' });
    expect(await discoverOverrides(root)).toEqual([]);
  });

  it('rejects an unknown shot id', async () => {
    await fixture('not-a-shot', { 'still-light.png': 'x' });
    await expect(discoverOverrides(root)).rejects.toThrow(/does not match any registered shot/);
  });

  it('rejects a loop override on a still-only shot', async () => {
    await fixture('cockpit', { 'loop-dark.webm': 'x' });
    await expect(discoverOverrides(root)).rejects.toThrow(/still-only shot/);
  });
});

describe('autoSkippedShotIds', () => {
  it('collects shots whose override.json sets skipAuto', async () => {
    await fixture('agent-discovery', {
      'loop-dark.mov': 'x',
      'override.json': JSON.stringify({ skipAuto: true }),
    });
    await fixture('cockpit', { 'still-light.png': 'x' });
    const skipped = await autoSkippedShotIds(root);
    expect(skipped.has('agent-discovery')).toBe(true);
    expect(skipped.has('cockpit')).toBe(false);
  });
});
