/**
 * Removing an extension from Settings and forgetting an approval whose folder
 * is gone (DOR-3541, DOR-3372). Purpose: a removed extension leaves no folder
 * and no approval behind, so nothing put back at that path inherits an old
 * yes; and Remove never deletes a folder DorkOS did not put there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionRecord } from '@dorkos/extension-api';

const stored = vi.hoisted(() => ({ extensions: {} as Record<string, unknown> }));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: () => stored.extensions,
    set: (_key: string, value: unknown) => {
      stored.extensions = value as Record<string, unknown>;
    },
  },
}));
vi.mock('../../../core/operator/config-write.js', () => ({ logConfigWrite: vi.fn() }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  forgetStaleApproval,
  listStaleApprovals,
  removeExtension,
  type RemovalManager,
} from '../extension-removal.js';

let home: string;

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-removal-')));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/** A copy on disk, at `<dir>/<id>`, with its manifest. */
async function copyAt(dir: string, id: string, overrides: Partial<ExtensionRecord> = {}) {
  const folder = path.join(dir, id);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'extension.json'), JSON.stringify({ id }));
  return {
    id,
    manifest: { id, name: id.toUpperCase(), version: '1.0.0' },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    path: folder,
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    ...overrides,
  } as ExtensionRecord;
}

/** A manager over these records, whose forget drops the approval keys as the real one does. */
function managerOf(
  records: ExtensionRecord[]
): RemovalManager & { reload: ReturnType<typeof vi.fn> } {
  return {
    dorkHome: home,
    get: (id: string) => records.find((record) => record.id === id),
    listRecords: () => records,
    listShadowedPublic: () => [],
    reload: vi.fn(async () => []),
    forgetRunApproval: vi.fn(async (id: string) => {
      const ext = stored.extensions as {
        approvedToRun: string[];
        approvedSources: Record<string, unknown>;
        approvedPermissions: Record<string, unknown>;
      };
      const { [id]: _s, ...sources } = ext.approvedSources;
      const { [id]: _p, ...permissions } = ext.approvedPermissions;
      stored.extensions = {
        ...ext,
        approvedToRun: ext.approvedToRun.filter((eid) => eid !== id),
        approvedSources: sources,
        approvedPermissions: permissions,
      };
    }),
  } as unknown as RemovalManager & { reload: ReturnType<typeof vi.fn> };
}

function approve(...ids: string[]) {
  stored.extensions = {
    enabled: [],
    disabled: [],
    approvedToRun: ids,
    approvedSources: Object.fromEntries(ids.map((id) => [id, { path: `/gone/${id}` }])),
    approvedPermissions: Object.fromEntries(ids.map((id) => [id, { runtime: 'in-process' }])),
    dismissedApprovals: {},
  };
}

describe('removeExtension', () => {
  it('deletes the folder and every approval for it, then rescans', async () => {
    approve('ledger');
    const record = await copyAt(path.join(home, 'extensions'), 'ledger');
    (stored.extensions as { disabled: string[] }).disabled = ['ledger'];
    const manager = managerOf([record]);

    const result = await removeExtension(manager, 'ledger');

    expect(result).toEqual({ ok: true, name: 'LEDGER', path: record.path });
    await expect(fs.stat(record.path)).rejects.toThrow();
    const ext = stored.extensions as Record<string, unknown>;
    expect(ext.approvedToRun).toEqual([]);
    expect(ext.approvedSources).toEqual({});
    expect(ext.approvedPermissions).toEqual({});
    expect(ext.disabled).toEqual([]);
    // Approvals go before the folder, so a failed delete still asks again.
    expect(manager.forgetRunApproval).toHaveBeenCalledWith('ledger', record.path);
    expect(manager.reload).toHaveBeenCalled();
  });

  it('removes a project or agent copy under .dork/extensions', async () => {
    approve();
    const record = await copyAt(path.join(home, 'project', '.dork', 'extensions'), 'notes');
    const result = await removeExtension(managerOf([record]), 'notes');
    expect(result.ok).toBe(true);
    await expect(fs.stat(record.path)).rejects.toThrow();
  });

  it.each([
    ['core', { origin: 'core' as const }],
    ['plugin', { sourcePlugin: 'marketing' }],
    ['dev_link', { devLink: { path: '/work/notes' } }],
  ])('refuses a %s copy and leaves it alone', async (reason, overrides) => {
    approve('notes');
    const record = await copyAt(path.join(home, 'extensions'), 'notes', overrides);
    const result = await removeExtension(managerOf([record]), 'notes');
    expect(result).toEqual({ ok: false, reason });
    await expect(fs.stat(record.path)).resolves.toBeTruthy();
    expect((stored.extensions as { approvedToRun: string[] }).approvedToRun).toEqual(['notes']);
  });

  it('refuses a folder DorkOS would not have put there', async () => {
    approve();
    const record = await copyAt(path.join(home, 'somewhere-else'), 'notes');
    expect(await removeExtension(managerOf([record]), 'notes')).toEqual({
      ok: false,
      reason: 'unexpected_folder',
    });
    await expect(fs.stat(record.path)).resolves.toBeTruthy();
  });

  it('refuses a folder reached through a symbolic link', async () => {
    approve();
    const real = await copyAt(path.join(home, 'elsewhere'), 'notes');
    await fs.mkdir(path.join(home, 'extensions'), { recursive: true });
    const link = path.join(home, 'extensions', 'notes');
    await fs.symlink(real.path, link);
    const result = await removeExtension(managerOf([{ ...real, path: link }]), 'notes');
    expect(result).toEqual({ ok: false, reason: 'unexpected_folder' });
    await expect(fs.stat(real.path)).resolves.toBeTruthy();
  });

  it('answers not_found for an id that is not installed', async () => {
    approve();
    expect(await removeExtension(managerOf([]), 'ghost')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('stale approvals', () => {
  it('lists approvals whose extension is installed nowhere', async () => {
    approve('gone', 'here');
    const here = await copyAt(path.join(home, 'extensions'), 'here');
    expect(listStaleApprovals(managerOf([here]))).toEqual([
      { id: 'gone', path: '/gone/gone', plugin: null },
    ]);
  });

  it('forgets a stale approval and its "Not now"', async () => {
    approve('gone');
    (stored.extensions as { dismissedApprovals: Record<string, unknown> }).dismissedApprovals = {
      gone: { path: '/gone/gone', version: '1.0.0' },
    };
    const manager = managerOf([]);
    expect(await forgetStaleApproval(manager, 'gone')).toEqual({ ok: true });
    expect(listStaleApprovals(manager)).toEqual([]);
    expect((stored.extensions as { dismissedApprovals: object }).dismissedApprovals).toEqual({});
  });

  it('refuses to forget one that is still installed', async () => {
    approve('here');
    const here = await copyAt(path.join(home, 'extensions'), 'here');
    expect(await forgetStaleApproval(managerOf([here]), 'here')).toEqual({
      ok: false,
      reason: 'installed',
    });
    expect((stored.extensions as { approvedToRun: string[] }).approvedToRun).toEqual(['here']);
  });
});
