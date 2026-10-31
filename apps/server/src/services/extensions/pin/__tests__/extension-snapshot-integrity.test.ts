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

import type { ExtensionRecord } from '@dorkos/extension-api';
import { ensureSnapshot, snapshotRootOf } from '../extension-snapshots.js';
import { placeSnapshots } from '../extension-snapshot-placement.js';
import { grantsDigestOf } from '../extension-path-trust.js';
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

describe('files that change between the hash and the snapshot (DOR-3440)', () => {
  const manifest = {
    id: 'notes',
    name: 'N',
    version: '1.0.0',
    serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' },
  } as ExtensionRecord['manifest'];
  const copy = (): ExtensionRecord =>
    ({
      id: 'notes',
      origin: 'user',
      path: live,
      realPath: live,
      scope: 'local',
      currentDigest: digest,
      manifest,
    }) as ExtensionRecord;
  const approval = (pin?: string) => ({
    approvedToRun: ['notes'],
    approvedSources: {
      notes: {
        path: live,
        authorHome: tmp,
        grants: grantsDigestOf(manifest),
        ...(pin ? { digest: pin } : {}),
      },
    },
  });
  /** Edit the code the moment the copy starts, after the hash was taken. */
  const editDuringCopy = () => {
    const copyFile = fs.copyFile.bind(fs);
    vi.spyOn(fs, 'copyFile').mockImplementationOnce(async (from, to) => {
      await fs.writeFile(path.join(live, 'index.ts'), 'export function activate() { steal(); }');
      return copyFile(from, to);
    });
  };
  const expectNothingRuns = async (record: ExtensionRecord) => {
    expect(record).toMatchObject({ originProblem: 'changed' });
    expect(record.runPath).toBeUndefined();
    expect(record.pinnedDigest).toBeUndefined();
    await expect(fs.access(snapshotRootOf(dorkHome, digest)!)).rejects.toThrow();
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a pinned copy edited after the hash runs nothing', async () => {
    const record = copy();
    await fs.writeFile(path.join(live, 'index.ts'), 'export function activate() { steal(); }');
    await placeSnapshots(dorkHome, [record], approval(digest));
    await expectNothingRuns(record);
  });

  it('a pinned copy edited during the copy runs nothing', async () => {
    const record = copy();
    editDuringCopy();
    await placeSnapshots(dorkHome, [record], approval(digest));
    await expectNothingRuns(record);
  });

  it('a path-trust copy edited during the copy runs nothing', async () => {
    const record = copy();
    editDuringCopy();
    await placeSnapshots(dorkHome, [record], approval());
    await expectNothingRuns(record);
  });

  it('a pinned copy runs its snapshot, and an edit after that does not reach it', async () => {
    const record = copy();
    await placeSnapshots(dorkHome, [record], approval(digest));
    const root = snapshotRootOf(dorkHome, digest)!;
    expect(record.runPath).toBe(root);
    await fs.writeFile(path.join(live, 'index.ts'), 'export function activate() { steal(); }');
    expect(await fs.readFile(path.join(record.runPath!, 'index.ts'), 'utf8')).toBe(
      'export function activate() {}'
    );
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
