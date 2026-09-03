import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { afterEach, describe, it, expect } from 'vitest';
import { assertPublishedSetComplete, publishWithRollback } from '../process.js';
import { SHOTS } from '../shots.js';
import type { AssetEntry } from '../optimize.js';

/**
 * Unit tests for the publish-completeness backstop — the record phase soldiers
 * on past a failed drive, so the process phase must refuse to publish a set
 * with holes in it — and for the rollback that makes that refusal free.
 *
 * @module capture/__tests__/process
 */

/** Build the full expected published set straight from the registry. */
function completeSet(): AssetEntry[] {
  const entry = (file: string, surface: string): AssetEntry => ({
    file,
    surface,
    theme: file.includes('-dark') ? 'dark' : 'light',
    kind: file.endsWith('.webm') ? 'loop' : 'still',
    width: 1280,
    height: 800,
    bytes: 1,
  });
  return SHOTS.flatMap((shot) => {
    const assets = [entry(`${shot.id}-light.png`, shot.id)];
    if (shot.kind === 'loop') {
      assets.push(entry(`${shot.id}-dark.webm`, shot.id), entry(`${shot.id}-dark.png`, shot.id));
    }
    return assets;
  });
}

describe('assertPublishedSetComplete', () => {
  it('accepts a set covering every registered shot', () => {
    expect(() => assertPublishedSetComplete(completeSet())).not.toThrow();
  });

  it('rejects a set missing a still, naming the file', () => {
    const set = completeSet().filter((a) => a.file !== 'cockpit-light.png');
    expect(() => assertPublishedSetComplete(set)).toThrowError(/cockpit-light\.png/);
  });

  it('rejects a set missing a loop or its poster', () => {
    const set = completeSet().filter((a) => a.file !== 'canvas-dark.webm');
    expect(() => assertPublishedSetComplete(set)).toThrowError(/canvas-dark\.webm/);
    const noPoster = completeSet().filter((a) => a.file !== 'canvas-dark.png');
    expect(() => assertPublishedSetComplete(noPoster)).toThrowError(/canvas-dark\.png/);
  });

  it('lists every gap at once so one re-record fixes them all', () => {
    const set = completeSet().filter(
      (a) => a.file !== 'cockpit-light.png' && a.file !== 'canvas-dark.webm'
    );
    expect(() => assertPublishedSetComplete(set)).toThrowError(
      /cockpit-light\.png.*canvas-dark\.webm|canvas-dark\.webm.*cockpit-light\.png/s
    );
  });
});

describe('publishWithRollback', () => {
  const dirs: string[] = [];

  /** A temp output dir holding a published set, an archive, and a stray file. */
  async function seededOutputDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-publish-'));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, 'cockpit-light.png'), 'OLD cockpit');
    await fs.writeFile(path.join(dir, 'canvas-dark.webm'), 'OLD canvas loop');
    await fs.writeFile(path.join(dir, 'manifest.json'), '{"count":2}\n');
    await fs.mkdir(path.join(dir, 'archive', 'v0.66.0'), { recursive: true });
    await fs.writeFile(path.join(dir, 'archive', 'v0.66.0', 'cockpit-light.png'), 'ARCHIVED');
    await fs.writeFile(path.join(dir, 'README.md'), 'not a shot');
    return dir;
  }

  /** Every entry in `dir`, sorted, so a listing compares deterministically. */
  async function listing(dir: string): Promise<string[]> {
    return (await fs.readdir(dir)).sort();
  }

  afterEach(async () => {
    for (const dir of dirs.splice(0, dirs.length)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves the previously published set intact when the completeness check throws', async () => {
    const dir = await seededOutputDir();
    const before = await listing(dir);

    // Exactly the shape of a run that lost one drive: the phase has already
    // written stills into the output dir by the time the backstop fires.
    await expect(
      publishWithRollback(async () => {
        await fs.writeFile(path.join(dir, 'cockpit-light.png'), 'NEW cockpit');
        await fs.writeFile(path.join(dir, 'agents-light.png'), 'NEW agents');
        assertPublishedSetComplete(completeSet().filter((a) => a.file !== 'canvas-dark.webm'));
      }, dir)
    ).rejects.toThrowError(/canvas-dark\.webm/);

    expect(await listing(dir)).toEqual(before);
    expect(await fs.readFile(path.join(dir, 'cockpit-light.png'), 'utf8')).toBe('OLD cockpit');
    expect(await fs.readFile(path.join(dir, 'canvas-dark.webm'), 'utf8')).toBe('OLD canvas loop');
    expect(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')).toBe('{"count":2}\n');
    // The half-written new set is gone rather than mixed in with the old one.
    expect(before).not.toContain('agents-light.png');
  });

  it('empties the published files before the publish writes, and keeps the rest', async () => {
    const dir = await seededOutputDir();
    let seen: string[] = [];

    await publishWithRollback(async () => {
      seen = await listing(dir);
      await fs.writeFile(path.join(dir, 'cockpit-light.png'), 'NEW cockpit');
    }, dir);

    // The publish starts from a clean slate — no stale shot survives it — while
    // `archive/` and anything a human left beside it are never touched.
    expect(seen).not.toContain('canvas-dark.webm');
    expect(seen).not.toContain('manifest.json');
    expect(seen).toContain('archive');
    expect(seen).toContain('README.md');
    expect(await listing(dir)).toEqual(['README.md', 'archive', 'cockpit-light.png']);
    expect(
      await fs.readFile(path.join(dir, 'archive', 'v0.66.0', 'cockpit-light.png'), 'utf8')
    ).toBe('ARCHIVED');
  });

  it('reclaims its own stale parking directory, and never another run’s', async () => {
    const dir = await seededOutputDir();
    const own = path.join(dir, `.publish-backup-${process.pid}`);
    const foreign = path.join(dir, '.publish-backup-999999');
    await fs.mkdir(own, { recursive: true });
    await fs.writeFile(path.join(own, 'cockpit-light.png'), 'RECYCLED-PID LEFTOVER');
    await fs.mkdir(foreign, { recursive: true });
    await fs.writeFile(path.join(foreign, 'topology-light.png'), 'ANOTHER RUN, ONLY COPY');

    await publishWithRollback(async () => {
      await fs.writeFile(path.join(dir, 'cockpit-light.png'), 'NEW cockpit');
    }, dir);

    // Ours was reclaimed, and never shadowed the set actually being published…
    expect(await fs.readFile(path.join(dir, 'cockpit-light.png'), 'utf8')).toBe('NEW cockpit');
    expect(await listing(dir)).not.toContain(path.basename(own));
    // …while the other run's parked media — which a single fixed backup name
    // deleted outright, and which may be the only copy left of it — is untouched.
    expect(await fs.readFile(path.join(foreign, 'topology-light.png'), 'utf8')).toBe(
      'ANOTHER RUN, ONLY COPY'
    );
  });

  it('keeps the backup and names both failures when the set cannot be put back', async () => {
    const dir = await seededOutputDir();
    const backupDir = path.join(dir, `.publish-backup-${process.pid}`);
    const publishError = new Error('drive failed');

    // A parked file goes missing while the publish is running, so the restore
    // genuinely cannot put it back — a real rename failure, not a stubbed one.
    const caught = await publishWithRollback(async () => {
      await fs.rm(path.join(backupDir, 'canvas-dark.webm'));
      throw publishError;
    }, dir).then(
      () => new Error('publish unexpectedly succeeded'),
      (err: unknown) => (err instanceof Error ? err : new Error(String(err)))
    );

    // Both halves of the story survive: what could not be restored, where it
    // is, and — through `cause`, which the old `finally` used to swallow — what
    // actually failed in the first place.
    expect(caught.message).toContain('canvas-dark.webm');
    expect(caught.message).toContain(backupDir);
    expect(caught.message).toContain('drive failed');
    expect(caught.cause).toBe(publishError);

    // Everything restorable was restored: one bad file strands only itself.
    expect(await fs.readFile(path.join(dir, 'cockpit-light.png'), 'utf8')).toBe('OLD cockpit');
    expect(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')).toBe('{"count":2}\n');
    // And the parking directory outlives the run, because a backup that did not
    // finish restoring is the only copy of whatever is still in it.
    expect(await listing(dir)).toContain(path.basename(backupDir));
  });
});
