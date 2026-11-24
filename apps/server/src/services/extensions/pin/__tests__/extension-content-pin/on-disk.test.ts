import { stored, ISOLATED, IN_PROCESS, copy, digestNow } from './harness.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type ExtensionManifest } from '@dorkos/extension-api';
import { grantsDigestOf } from '../../extension-path-trust.js';
import { mayRunExtensionCode, type ExtensionApprovals } from '../../../extension-load-policy.js';
import {
  changedFilesSince,
  liveDigestOf,
  pinStillHolds,
  UNPINNABLE_SENTENCE,
  UNREADABLE_SENTENCE,
  whyUnpinnable,
} from '../../extension-content-pin.js';
import { approveNewScaffold } from '../../extension-scaffold-approval.js';
import { ExtensionDiscovery } from '../../../extension-discovery.js';
import { ensureSnapshot } from '../../extension-snapshots.js';

describe('on disk', () => {
  let tmp: string;
  let dorkHome: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-content-pin-')));
    dorkHome = path.join(tmp, 'dork');
    stored.extensions = { enabled: [], disabled: [], approvedToRun: [] };
    stored.permissions = { preset: 'trusted' };
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeExtension(dir: string, manifest: ExtensionManifest): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(dir, 'index.ts'), 'export function activate() {}');
    await fs.writeFile(path.join(dir, 'server.ts'), 'export default () => {};');
  }

  it('digests every direct copy, global and local, and reads its real path', async () => {
    const globalDir = path.join(dorkHome, 'extensions', 'g-ext');
    const project = path.join(tmp, 'project');
    const localDir = path.join(project, '.dork', 'extensions', 'l-ext');
    await writeExtension(globalDir, { ...IN_PROCESS, id: 'g-ext' });
    await writeExtension(localDir, { ...IN_PROCESS, id: 'l-ext' });

    const records = await new ExtensionDiscovery(dorkHome).discover(
      project,
      { enabled: [], disabled: [], approvedToRun: [] },
      new Map()
    );
    const g = records.find((r) => r.id === 'g-ext')!;
    const l = records.find((r) => r.id === 'l-ext')!;
    expect(g.currentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(l.currentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(g.realPath).toBe(globalDir);
    expect(l.realPath).toBe(localDir);

    // An edit changes the digest the next scan reads.
    await fs.writeFile(path.join(localDir, 'index.ts'), 'export function activate() { /* x */ }');
    const again = await new ExtensionDiscovery(dorkHome).discover(
      project,
      { enabled: [], disabled: [], approvedToRun: [] },
      new Map()
    );
    expect(again.find((r) => r.id === 'l-ext')!.currentDigest).not.toBe(l.currentDigest);
  });

  it('reads a linked folder’s real path, so it cannot borrow its author’s folder', async () => {
    const home = path.join(tmp, 'agent-a');
    const outside = path.join(tmp, 'outside', 'notes');
    await writeExtension(outside, ISOLATED);
    await fs.mkdir(path.join(home, '.dork', 'extensions'), { recursive: true });
    await fs.symlink(outside, path.join(home, '.dork', 'extensions', 'notes'));

    const [record] = await new ExtensionDiscovery(dorkHome).discover(
      home,
      { enabled: [], disabled: [], approvedToRun: [] },
      new Map()
    );
    expect(record!.realPath).toBe(outside);
    const approvals: ExtensionApprovals = {
      approvedToRun: ['notes'],
      approvedSources: {
        notes: { path: record!.path, authorHome: home, grants: grantsDigestOf(ISOLATED) },
      },
    };
    expect(mayRunExtensionCode({ ...record!, origin: 'user' }, approvals)).toBe(false);
  });

  it('refuses a pinned copy at load as soon as its live files change', async () => {
    const dir = path.join(dorkHome, 'extensions', 'notes');
    await writeExtension(dir, IN_PROCESS);
    const record = copy({ path: dir, realPath: dir, manifest: IN_PROCESS });
    record.currentDigest = (await liveDigestOf(record))!;
    const approvals: ExtensionApprovals = {
      approvedToRun: ['notes'],
      approvedSources: { notes: { path: dir, digest: record.currentDigest } },
    };
    expect(await pinStillHolds(record, approvals)).toBe(true);
    expect(mayRunExtensionCode(record, approvals)).toBe(true);

    await fs.writeFile(path.join(dir, 'server.ts'), 'export default () => { /* edited */ };');
    expect(await pinStillHolds(record, approvals)).toBe(false);
    expect(mayRunExtensionCode(record, approvals)).toBe(false);
    expect(record.runPath).toBeUndefined();
  });

  it('says in plain words why a copy cannot be approved: a link out, or files it cannot read', async () => {
    const dir = path.join(tmp, 'linked-out');
    await writeExtension(dir, IN_PROCESS);
    await fs.writeFile(path.join(tmp, 'evil.js'), 'steal()');
    await fs.symlink(path.join(tmp, 'evil.js'), path.join(dir, 'evil.js'));
    expect(await whyUnpinnable({ path: dir })).toBe(UNPINNABLE_SENTENCE);
    expect(await whyUnpinnable({ path: path.join(tmp, 'gone') })).toBe(UNREADABLE_SENTENCE);
  });

  it('names the files that changed since the approved snapshot, never their contents', async () => {
    const dir = path.join(dorkHome, 'extensions', 'notes');
    await writeExtension(dir, IN_PROCESS);
    const record = copy({ path: dir });
    const approved = (await liveDigestOf(record))!;
    expect(await ensureSnapshot(dorkHome, dir, approved)).not.toBeNull();

    await fs.writeFile(path.join(dir, 'server.ts'), 'secret-new-code');
    await fs.writeFile(path.join(dir, 'extra.ts'), 'more');
    await fs.rm(path.join(dir, 'index.ts'));

    expect(await changedFilesSince(dorkHome, record, approved)).toEqual([
      'extra.ts',
      'index.ts',
      'server.ts',
    ]);
  });

  it('records the creating agent’s folder, and pins an in-process scaffold to its files', async () => {
    const home = path.join(tmp, 'agent-a');
    const isolatedDir = path.join(home, '.dork', 'extensions', 'notes');
    await writeExtension(isolatedDir, ISOLATED);
    await approveNewScaffold(
      dorkHome,
      'notes',
      {
        targetDir: isolatedDir,
        manifest: ISOLATED,
        scope: 'local',
        digest: await digestNow(isolatedDir),
      },
      home
    );
    const isolatedSource = (stored.extensions.approvedSources as Record<string, unknown>).notes;
    expect(isolatedSource).toMatchObject({ authorHome: home, grants: grantsDigestOf(ISOLATED) });
    expect(isolatedSource).not.toHaveProperty('digest');

    const globalDir = path.join(dorkHome, 'extensions', 'card');
    await writeExtension(globalDir, { ...IN_PROCESS, id: 'card' });
    await approveNewScaffold(
      dorkHome,
      'card',
      {
        targetDir: globalDir,
        manifest: { ...IN_PROCESS, id: 'card' },
        digest: await digestNow(globalDir),
      },
      home
    );
    expect((stored.extensions.approvedSources as Record<string, unknown>).card).toMatchObject({
      digest: expect.stringMatching(/^sha256:/),
    });
  });
});
