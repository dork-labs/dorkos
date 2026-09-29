/**
 * A warm scan of several flow-sized plugin copies stays cheap (third security
 * review of DOR-2527, R2): whole-folder digests are reused while every file's
 * `(inode, size, mtime, ctime)` and every directory listing are unchanged, so
 * a warm scan walks and `lstat`s but reads no file.
 *
 * Each copy is shaped like the real flow plugin: about 1,200 files, most of
 * them in `node_modules`. The bound is deliberately generous (a loaded CI
 * box); the timing the review asked about is logged.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ExtensionDiscovery } from '../extension-discovery.js';
import type { ExtensionsConfig } from '../extension-enable-resolution.js';
import { installFolderDigest } from '../../marketplace/lib/install-digest.js';
import { recordProjectInstall } from '../../marketplace/lib/project-install-index.js';
import { logger } from '../../../lib/logger.js';

const COPIES = 5;
const FILES_PER_COPY = 1200;
const WARM_SCAN_BOUND_MS = 1500;

let tmp: string;
let dorkHome: string;
const roots: string[] = [];

beforeAll(async () => {
  vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-scan-perf-')));
  dorkHome = path.join(tmp, 'dork');
  const body = 'x'.repeat(2048);
  for (let c = 0; c < COPIES; c++) {
    const root = path.join(tmp, `repo-${c}`);
    const plugin = path.join(root, '.dork', 'plugins', 'flow');
    const ext = path.join(plugin, '.dork', 'extensions', 'flow');
    await fs.mkdir(ext, { recursive: true });
    await fs.writeFile(
      path.join(ext, 'extension.json'),
      JSON.stringify({ id: 'flow', name: 'Flow', version: `1.${c}.0` })
    );
    for (let f = 0; f < FILES_PER_COPY; f++) {
      const dir = path.join(plugin, 'node_modules', `pkg-${f % 60}`, 'lib');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `f${f}.js`), body);
    }
    const found = await installFolderDigest(plugin);
    if (found.kind !== 'digest') throw new Error(found.kind);
    await recordProjectInstall(dorkHome, {
      projectPath: root,
      installRoot: plugin,
      name: 'flow',
      source: 'dork-labs/marketplace',
      installDigest: found.digest,
    });
    roots.push(root);
  }
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('scanning several flow-sized copies', () => {
  it(`keeps a warm scan of ${COPIES} copies under ${WARM_SCAN_BOUND_MS}ms`, async () => {
    const discovery = new ExtensionDiscovery(dorkHome);
    const config: ExtensionsConfig = {
      enabled: [],
      disabled: [],
      approvedToRun: [],
      trustedSources: [{ source: 'dork-labs/marketplace', trustedAt: 'now' }],
    };

    const coldStart = performance.now();
    const cold = await discovery.discover(null, config, new Map(), roots);
    const coldMs = performance.now() - coldStart;

    const warmStart = performance.now();
    const warm = await discovery.discover(null, config, new Map(), roots);
    const warmMs = performance.now() - warmStart;

    process.stderr.write(
      `[scan timing] ${COPIES} copies x ${FILES_PER_COPY} files: cold ${coldMs.toFixed(0)}ms, ` +
        `warm ${warmMs.toFixed(0)}ms\n`
    );
    expect(cold.filter((r) => r.trustedOrigin)).toHaveLength(COPIES);
    expect(warm.filter((r) => r.trustedOrigin)).toHaveLength(COPIES);
    expect(warmMs).toBeLessThan(WARM_SCAN_BOUND_MS);
  }, 120_000);
});
