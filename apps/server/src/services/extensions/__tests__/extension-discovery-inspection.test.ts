import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ExtensionDiscovery } from '../extension-discovery.js';
import { inspectCopy, installRootOf } from '../extension-trusted-origin.js';
import { recordProjectInstall } from '../../marketplace/lib/project-install-index.js';
import { logger } from '../../../lib/logger.js';

vi.mock('../extension-trusted-origin.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../extension-trusted-origin.js')),
  inspectCopy: vi.fn(),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let tmp: string;
let home: string;
const roots: string[] = [];
const digest = `sha256:${'a'.repeat(64)}`;
const inspected = { folder: { kind: 'digest' as const, digest } };
const config = {
  enabled: [],
  disabled: [],
  approvedToRun: [],
  trustedSources: [{ source: 'dork-labs/marketplace', trustedAt: 'now' }],
};

beforeEach(async () => {
  vi.mocked(inspectCopy).mockReset();
  vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-inspection-')));
  home = path.join(tmp, 'dork');
  roots.length = 0;
  for (let i = 0; i < 8; i++) {
    const root = path.join(tmp, `repo-${i}`);
    const plugin = path.join(root, '.dork', 'plugins', 'flow');
    for (const id of ['flow', `other-${i}`]) {
      const extension = path.join(plugin, '.dork', 'extensions', id);
      await fs.mkdir(extension, { recursive: true });
      await fs.writeFile(
        path.join(extension, 'extension.json'),
        JSON.stringify({ id, name: id, version: `1.${i}.0` })
      );
    }
    await recordProjectInstall(home, {
      projectPath: root,
      installRoot: plugin,
      name: 'flow',
      source: 'dork-labs/marketplace',
      installDigest: digest,
    });
    roots.push(root);
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('independent plugin-copy inspection', () => {
  it('overlaps independent roots with at most four inspections, deduplicates copies and retains newest-source precedence', async () => {
    const firstStarted = deferred();
    const firstRelease = deferred();
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    vi.mocked(inspectCopy).mockImplementation(async (copy) => {
      const root = installRootOf(copy.path);
      started.push(root);
      active++;
      peak = Math.max(peak, active);
      try {
        if (root.includes('repo-0')) {
          firstStarted.resolve();
          await firstRelease.promise;
        } else await Promise.resolve();
        return inspected;
      } finally {
        active--;
      }
    });
    const work = new ExtensionDiscovery(home).discover(
      null,
      config,
      new Map(),
      [...roots].reverse()
    );
    try {
      await firstStarted.promise;
      for (let i = 0; i < 32; i++) await Promise.resolve();
      expect(started.length).toBeGreaterThan(1);
      expect(peak).toBe(4);
      expect(active).toBe(1);
    } finally {
      firstRelease.resolve();
      await work;
    }
    const records = await work;
    expect(peak).toBeLessThanOrEqual(4);
    expect(active).toBe(0);
    expect(started).toHaveLength(8);
    expect(new Set(started).size).toBe(8);
    const family = records.filter((record) => record.id === 'flow');
    expect(family).toHaveLength(8);
    expect(family.find((record) => !record.shadowedBy)?.manifest.version).toBe('1.7.0');
    expect(family.every((record) => record.trustedOrigin?.source === 'dork-labs/marketplace')).toBe(
      true
    );
    expect(
      records.filter((record) => record.id.startsWith('other-')).map((record) => record.id)
    ).toEqual(roots.map((_, i) => `other-${i}`));
  });
  it('drains started inspections and preserves the first input-ordered failure even when its reason is undefined', async () => {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const firstRelease = deferred();
    const secondRelease = deferred();
    const later = new Error('Later input failed first');
    let active = 0;
    const started: string[] = [];
    vi.mocked(inspectCopy).mockImplementation(async (copy) => {
      const root = installRootOf(copy.path);
      started.push(root);
      active++;
      try {
        if (root.includes('repo-0')) {
          firstStarted.resolve();
          await firstRelease.promise;
          throw undefined;
        }
        if (root.includes('repo-1')) {
          secondStarted.resolve();
          await secondRelease.promise;
          return inspected;
        }
        if (root.includes('repo-2')) throw later;
        return inspected;
      } finally {
        active--;
      }
    });
    let settled = false;
    const work = new ExtensionDiscovery(home).discover(null, config, new Map(), roots).then(
      () => {
        settled = true;
        return { rejected: false, reason: undefined };
      },
      (reason: unknown) => {
        settled = true;
        return { rejected: true, reason };
      }
    );
    try {
      await firstStarted.promise;
      for (let i = 0; i < 32; i++) await Promise.resolve();
      expect(started.some((root) => root.includes('repo-1'))).toBe(true);
      await secondStarted.promise;
      firstRelease.resolve();
      for (let i = 0; i < 32; i++) await Promise.resolve();
      expect(settled).toBe(false);
      expect(active).toBe(1);
    } finally {
      firstRelease.resolve();
      secondRelease.resolve();
      await work;
    }
    expect(await work).toEqual({ rejected: true, reason: undefined });
    expect(active).toBe(0);
    expect(started).toHaveLength(8);
  });
});
