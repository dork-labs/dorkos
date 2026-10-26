/**
 * A snapshot is used only while it holds the files it is named by (DOR-3068):
 * one edited after it was made, or planted before it ever was, is rebuilt from
 * the approved files or refused.
 *
 * @module services/extensions/pin/__tests__/extension-snapshot-integrity
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ensureSnapshot, snapshotRootOf } from '../extension-snapshots.js';
import { stillPinned } from '../../extension-plugin-guard.js';
import { installFolderDigest } from '../../../marketplace/lib/install-digest.js';

let tmp: string;
let dorkHome: string;
let live: string;
let digest: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-integrity-')));
  dorkHome = path.join(tmp, 'dork');
  live = path.join(dorkHome, 'extensions', 'notes');
  await fs.mkdir(live, { recursive: true });
  await fs.writeFile(
    path.join(live, 'extension.json'),
    '{"id":"notes","name":"N","version":"1.0.0"}'
  );
  await fs.writeFile(path.join(live, 'index.ts'), 'export function activate() {}');
  const found = await installFolderDigest(live);
  if (found.kind !== 'digest') throw new Error('expected a digest');
  digest = found.digest;
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('ensureSnapshot', () => {
  it('rebuilds a snapshot whose files were edited after it was made', async () => {
    const root = (await ensureSnapshot(dorkHome, live, digest))!;
    await fs.writeFile(path.join(root, 'index.ts'), 'export function activate() { steal(); }');
    expect(await ensureSnapshot(dorkHome, live, digest)).toBe(root);
    expect(await fs.readFile(path.join(root, 'index.ts'), 'utf8')).toBe(
      'export function activate() {}'
    );
  });

  it('replaces a folder planted under the digest’s name before any snapshot existed', async () => {
    const root = snapshotRootOf(dorkHome, digest)!;
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'index.ts'), 'export function activate() { steal(); }');
    expect(await ensureSnapshot(dorkHome, live, digest)).toBe(root);
    expect(await fs.readFile(path.join(root, 'index.ts'), 'utf8')).toBe(
      'export function activate() {}'
    );
  });

  it('refuses when neither the snapshot nor the live folder holds the approved files', async () => {
    const root = (await ensureSnapshot(dorkHome, live, digest))!;
    await fs.writeFile(path.join(root, 'index.ts'), 'planted');
    await fs.writeFile(path.join(live, 'index.ts'), 'edited');
    expect(await ensureSnapshot(dorkHome, live, digest)).toBeNull();
  });
});

describe('a folder with npm links (DOR-3068)', () => {
  it('snapshots an in-folder link as the same link, so the copy matches its digest', async () => {
    await fs.mkdir(path.join(live, 'node_modules', '.bin'), { recursive: true });
    await fs.mkdir(path.join(live, 'node_modules', 'tool'), { recursive: true });
    await fs.writeFile(path.join(live, 'node_modules', 'tool', 'cli.js'), 'run()');
    await fs.symlink('../tool/cli.js', path.join(live, 'node_modules', '.bin', 'tool'));
    const found = await installFolderDigest(live);
    if (found.kind !== 'digest') throw new Error(found.kind);

    const root = (await ensureSnapshot(dorkHome, live, found.digest))!;
    expect(root).not.toBeNull();
    expect(await fs.readlink(path.join(root, 'node_modules', '.bin', 'tool'))).toBe(
      '../tool/cli.js'
    );
  });
});

describe('stillPinned', () => {
  it('re-hashes the snapshot a copy runs from, and refuses one edited since', async () => {
    const root = (await ensureSnapshot(dorkHome, live, digest))!;
    const record = { path: live, runPath: root, pinnedDigest: digest };
    expect(await stillPinned(record)).toBe(true);
    await fs.writeFile(path.join(root, 'index.ts'), 'export function activate() { steal(); }');
    expect(await stillPinned(record)).toBe(false);
  });
});
