/**
 * Tests that listing installed Shapes never reads the marketplace install
 * engine's own siblings as Shapes (DOR-2273): a crash-left backup carries the
 * previous install's valid manifest, and read as a Shape it is one Shape
 * listed twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../core/config-manager.js', () => ({ configManager: { get: vi.fn() } }));

const { listInstalledShapeManifests, listInstalledShapes } = await import('../shape-services.js');

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../marketplace/fixtures/valid-shape'
);

describe('listing installed Shapes', () => {
  let dorkHome: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'shape-listing-'));
    const shapes = path.join(dorkHome, 'shapes');
    await cp(FIXTURE, path.join(shapes, 'valid-shape'), { recursive: true });
    for (const sibling of [
      `valid-shape.dorkos-bak-${Date.now()}-${randomUUID()}`,
      `valid-shape.dorkos-bak-${Date.now()}-${process.pid}-1-abcdef01-${randomUUID()}.committed`,
    ]) {
      await cp(FIXTURE, path.join(shapes, sibling), { recursive: true });
    }
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('lists each installed Shape once', async () => {
    expect(await listInstalledShapeManifests(dorkHome)).toHaveLength(1);
    expect(await listInstalledShapes(dorkHome, null)).toHaveLength(1);
  });
});
