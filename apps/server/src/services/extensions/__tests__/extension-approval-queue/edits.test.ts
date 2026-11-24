import {
  state,
  h,
  server,
  EXT_ID,
  broadcasts,
  approvalArrivals,
  historyRows,
  extensionDir,
  installPlugin,
  card,
  pending,
} from './harness.js';
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from '@dorkos/test-utils/supertest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { ExtensionServerLifecycle } from '../../extension-server-lifecycle.js';
import { ExtensionFileWatcher } from '../../copies/extension-file-watcher.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { noteScaffoldTrusted } from '../../pin/path-trust-edits.js';
import { grantsDigestOf, bundleDigestOf } from '../../pin/extension-path-trust.js';
import { liveDigestOf } from '../../pin/extension-content-pin.js';

describe('a waiting copy whose folder is gone', () => {
  it('retires the card on a native delete signal before discovery runs', async () => {
    await installPlugin();
    const refresh = vi.fn();
    const watcher = new ExtensionFileWatcher({
      source: {
        dorkHome: h.dorkHome,
        listRecords: () => h.manager.listRecords(),
        onChange: (listener) => h.manager.onChange(listener),
        requestRefresh: refresh,
        whenIdle: async () => undefined,
      },
      presenceChanged: () => {
        void h.queue.sync();
      },
    });
    try {
      await watcher.start();
      await vi.waitFor(() => expect(refresh).toHaveBeenCalled(), { timeout: 10_000 });
      await h.queue.sync();
      refresh.mockClear();
      fs.rmSync(extensionDir('flow'), { recursive: true });

      await vi.waitFor(() => expect(broadcasts('standing_resolved')).toHaveLength(1), {
        timeout: 10_000,
      });
      expect(await pending()).toEqual([]);
      expect(h.manager.listRecords()).toHaveLength(1);
      expect(refresh).toHaveBeenCalledWith({ establishBaseline: false });
      expect(historyRows()).toEqual([]);
    } finally {
      await watcher.stop();
    }
  });

  it('refuses an approval for a vanished folder without changing its approval', async () => {
    await installPlugin();
    const shown = card();
    const before = structuredClone(state.extensions);
    fs.rmSync(extensionDir('flow'), { recursive: true });

    // The manager checks presence even without a supplied digest.
    await expect(h.manager.approveToRun(EXT_ID)).rejects.toMatchObject({ reason: 'stale' });

    const response = await request(server).post(`/api/extensions/${EXT_ID}/approve`).send(shown);

    expect(response.status).toBe(412);
    expect(response.body).toMatchObject({ code: 'precondition_failed' });
    expect(state.extensions).toEqual(before);
    expect(await pending()).toEqual([]);
  });
});

it('leaves the live list and retires its arrival without a discovery pass', async () => {
  await installPlugin();
  expect(await pending()).toHaveLength(1);
  fs.rmSync(extensionDir('flow'), { recursive: true });

  expect(await pending()).toEqual([]);
  await h.queue.sync();

  expect(h.manager.listRecords()).toHaveLength(1);
  expect(broadcasts('standing_resolved')).toHaveLength(1);
  expect(historyRows()).toEqual([]);
});

describe('an approved copy changed outside file tools', () => {
  it('requires readable approved files when client compilation is pending', async () => {
    const author = path.join(h.dorkHome, 'agents', 'rowan');
    const folder = path.join(author, '.dork', 'extensions', 'desk');
    const manifest = {
      id: 'desk',
      name: 'Desk',
      version: '1.0.0',
      serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' as const },
    };
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'extension.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(folder, 'server.ts'), 'export default () => {};');
    fs.writeFileSync(path.join(folder, 'index.ts'), 'export function activate() {}');
    const digest = await liveDigestOf({ path: folder });
    expect(await noteScaffoldTrusted(h.dorkHome, 'desk', { targetDir: folder, digest })).toBe(true);
    state.extensions.enabled = ['desk'];
    state.extensions.approvedToRun = ['desk'];
    state.extensions.approvedSources = {
      desk: { path: folder, authorHome: author, grants: grantsDigestOf(manifest) },
    };
    h.manager.followProjects({ roots: async () => [author], onChange: () => () => undefined });
    await h.manager.reload();
    await h.queue.sync();
    h.manager.get('desk')!.bundleReady = false;
    const before = structuredClone(state.extensions);
    // The first presence check succeeds; the subsequent digest finds no source files.
    vi.spyOn(fs.promises, 'stat').mockImplementationOnce(async (target) => {
      expect(target).toBe(folder);
      fs.rmSync(folder, { recursive: true });
      return { isDirectory: () => true } as never;
    });

    await expect(h.manager.approveToRun('desk')).rejects.toMatchObject({ reason: 'unpinnable' });
    expect(state.extensions).toEqual(before);
  });

  it('holds an author copy with no saved baseline until a person approves its exact files', async () => {
    const runtime = new FakeAgentRuntime();
    vi.spyOn(runtimeRegistry, 'getAllCapabilities').mockReturnValue({
      [runtimeRegistry.getDefaultType()]: runtime.getCapabilities(),
    });
    const author = path.join(h.dorkHome, 'agents', 'rowan');
    const folder = path.join(author, '.dork', 'extensions', 'desk');
    const manifest = {
      id: 'desk',
      name: 'Desk',
      version: '1.0.0',
      serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' as const },
    };
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'extension.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(folder, 'server.ts'), 'export default () => {};');
    fs.writeFileSync(path.join(folder, 'index.ts'), 'export function activate() {}');
    state.extensions.enabled = ['desk'];
    state.extensions.approvedToRun = ['desk'];
    state.extensions.approvedSources = {
      desk: { path: folder, authorHome: author, grants: grantsDigestOf(manifest) },
    };
    h.manager.followProjects({ roots: async () => [author], onChange: () => () => undefined });
    await h.manager.reload();
    await h.queue.sync();
    const record = h.manager.listPublic().find((copy) => copy.id === 'desk')!;
    expect(record.approvedToRun).toBe(false);
    expect(await pending()).toHaveLength(1);
    expect(approvalArrivals()).toHaveLength(1);

    const response = await request(server).post('/api/extensions/desk/approve').send({
      version: record.manifest.version,
      expectedDigest: record.digest,
    });
    expect(response.status).toBe(200);
    await h.queue.sync();
    expect(await pending()).toEqual([]);
    const seen = JSON.parse(
      fs.readFileSync(path.join(h.dorkHome, 'extension-data', 'path-trust-seen.json'), 'utf8')
    );
    expect(seen.trusted.desk.digest).toBe(record.digest);
    expect(seen.untied).not.toContain('desk');
  });

  it('stops a plain fs.writeFile server edit and raises exactly one approval card', async () => {
    const runtime = new FakeAgentRuntime();
    vi.spyOn(runtimeRegistry, 'getAllCapabilities').mockReturnValue({
      [runtimeRegistry.getDefaultType()]: runtime.getCapabilities(),
    });
    const author = path.join(h.dorkHome, 'agents', 'rowan');
    const folder = path.join(author, '.dork', 'extensions', 'desk');
    const manifest = {
      id: 'desk',
      name: 'Desk',
      version: '1.0.0',
      serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' as const },
    };
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'extension.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(folder, 'server.ts'), 'export default () => {};');
    fs.writeFileSync(path.join(folder, 'index.ts'), 'export function activate() {}');
    fs.mkdirSync(path.join(folder, 'src'));
    fs.writeFileSync(path.join(folder, 'src', 'nested.ts'), 'export const value = 1;');
    const digest = await liveDigestOf({ path: folder });
    expect(await noteScaffoldTrusted(h.dorkHome, 'desk', { targetDir: folder, digest })).toBe(true);
    state.extensions.enabled = ['desk'];
    state.extensions.approvedToRun = ['desk'];
    state.extensions.approvedSources = {
      desk: {
        path: folder,
        authorHome: author,
        grants: grantsDigestOf(manifest),
        clientDigest: bundleDigestOf('export function activate() {}'),
      },
    };
    h.manager.followProjects({ roots: async () => [author], onChange: () => () => undefined });
    await h.manager.reload();
    await h.queue.sync();
    expect(h.manager.listPublic().find((copy) => copy.id === 'desk')?.approvedToRun).toBe(true);
    expect(await pending()).toEqual([]);
    const lifecycle = vi.mocked(ExtensionServerLifecycle).mock.results.at(-1);
    if (lifecycle?.type !== 'return') throw new Error('Missing test lifecycle');
    const refresh = vi.spyOn(h.manager, 'requestRefresh');
    try {
      await h.manager.startFileWatcher();
      // Wait for ready's catch-up pass before measuring the outside write.
      await vi.waitFor(() => expect(refresh).toHaveBeenCalled(), { timeout: 10_000 });
      await h.manager.whenIdle();
      await h.queue.sync();
      vi.mocked(lifecycle.value.shutdown).mockClear();
      refresh.mockClear();
      h.sent = [];

      await fs.promises.writeFile(
        path.join(folder, 'server.ts'),
        'export default () => "changed";'
      );

      await vi.waitFor(
        () => {
          expect(h.manager.listPublic().find((copy) => copy.id === 'desk')?.approvedToRun).toBe(
            false
          );
        },
        { timeout: 10_000 }
      );
      await h.queue.sync();
      expect(lifecycle.value.shutdown).toHaveBeenCalledWith('desk');
      expect(await pending()).toHaveLength(1);
      expect(approvalArrivals()).toHaveLength(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      const seen = JSON.parse(
        fs.readFileSync(path.join(h.dorkHome, 'extension-data', 'path-trust-seen.json'), 'utf8')
      );
      expect(seen.untied).toContain('desk');
      expect(await h.manager.readBundle('desk')).toBeNull();

      const held = h.manager.listPublic().find((copy) => copy.id === 'desk')!;
      const allow = await request(server).post('/api/extensions/desk/approve').send({
        version: held.manifest.version,
        expectedDigest: held.digest,
      });
      expect(allow.status).toBe(200);
      await h.manager.whenIdle();
      await h.queue.sync();
      expect(await pending()).toEqual([]);
      h.sent = [];
      refresh.mockClear();
      const beforeBurst = h.manager.listPublic().find((copy) => copy.id === 'desk')?.digest;
      await Promise.all([
        fs.promises.writeFile(path.join(folder, 'server.ts'), 'export default () => "again";'),
        fs.promises.writeFile(
          path.join(folder, 'index.ts'),
          'export function activate() { return 2; }'
        ),
        fs.promises.writeFile(
          path.join(folder, 'src', 'replacement.tmp'),
          'export const value = 2;'
        ),
      ]);
      await fs.promises.rename(
        path.join(folder, 'src', 'replacement.tmp'),
        path.join(folder, 'src', 'nested.ts')
      );
      await vi.waitFor(
        () => {
          expect(h.manager.listPublic().find((copy) => copy.id === 'desk')?.digest).not.toBe(
            beforeBurst
          );
        },
        { timeout: 10_000 }
      );
      await h.queue.sync();
      expect(await pending()).toHaveLength(1);
      expect(approvalArrivals()).toHaveLength(1);
      expect(refresh).toHaveBeenCalledTimes(1);

      const repairedDigest = h.manager.listPublic().find((copy) => copy.id === 'desk')?.digest;
      expect(repairedDigest).toBeTruthy();
      const link = path.join(folder, 'temporary-link');
      await fs.promises.symlink(path.join(folder, 'server.ts'), link);
      await vi.waitFor(
        () => {
          expect(h.manager.listPublic().find((copy) => copy.id === 'desk')?.digest).toBeUndefined();
        },
        { timeout: 10_000 }
      );
      await fs.promises.unlink(link);
      await vi.waitFor(
        () => {
          expect(h.manager.listPublic().find((copy) => copy.id === 'desk')?.digest).toBe(
            repairedDigest
          );
        },
        { timeout: 10_000 }
      );
    } finally {
      await h.manager.stopFileWatcher();
    }
  });
});
