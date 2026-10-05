/**
 * Node's permission tree and the grants an isolated child gets (DOR-2686;
 * found by the packaged-desktop smoke on Node 24.18).
 *
 * Node 22.x and 24.x have a bug in how they store `--allow-fs-read` grants:
 * with three or more grants that start in different top-level folders
 * (`/Users/...` and `/private/...` on a Mac, `/home/...` and `/tmp/...` on
 * Linux), `/` itself becomes readable — `fs.readdirSync('/')` lists the root.
 * The old layout (bootstrap, bundle and files each granted where they lay)
 * hit it whenever the app and the temp folder sat on different roots, which
 * is exactly the packaged app on CI.
 *
 * The fix: stage everything the child reads into ONE run folder, so a child
 * only ever has two read grants (run folder and files folder), which never
 * trip the bug; and the self-check now refuses if ANY folder above a grant,
 * or `/`, is readable.
 *
 * Each case runs on the Node running the tests and on any extra Node binary
 * named in `DORKOS_TEST_NODE_BINARIES` (path-list), plus Node 24 from nvm
 * when present, so a Node-24-only regression shows up locally too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fork, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ancestorsOf, isolatedFilesDir, isolatedRunDir, selfCheckPassed } from '../grants.js';
import type { HelloMessage } from '../ipc-protocol.js';
import {
  cleanup,
  createHarness,
  makeHost,
  probe,
  startOk,
  type Harness,
} from './isolation-harness.js';

/** A file in the repository: a read grant on a different root than the temp folder. */
const REPO_FILE = fileURLToPath(import.meta.url);

/** The Node binaries to run every case on. */
function nodeBinaries(): string[] {
  const found = new Set<string>([process.execPath]);
  for (const bin of (process.env.DORKOS_TEST_NODE_BINARIES ?? '').split(path.delimiter)) {
    if (bin && existsSync(bin)) found.add(bin);
  }
  const nvm = process.env.NVM_DIR;
  if (nvm && existsSync(path.join(nvm, 'versions', 'node'))) {
    for (const version of readdirSync(path.join(nvm, 'versions', 'node'))) {
      const bin = path.join(nvm, 'versions', 'node', version, 'bin', 'node');
      if (version.startsWith('v24') && existsSync(bin)) found.add(bin);
    }
  }
  return [...found];
}

const BINARIES = nodeBinaries();

/** The Node version a binary reports. */
function versionOf(bin: string): string {
  return spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim();
}

describe.skipIf(process.platform === 'win32').each(BINARIES.map((bin) => [versionOf(bin), bin]))(
  'permission grants on Node %s',
  (_version, bin) => {
    let h: Harness;

    beforeEach(async () => {
      h = await createHarness();
    });

    afterEach(async () => {
      await cleanup(h);
    });

    // Purpose: whatever this Node does with three grants across roots, the
    // self-check sees it. If `/` lists, the report must refuse; this is the
    // exact shape that broke the packaged smoke.
    it('the self-check catches a root that three grants across roots make readable', async () => {
      const dir = path.join(h.tmp, 'grants');
      await fs.mkdir(dir);
      const bootstrap = path.join(dir, 'child.cjs');
      await fs.copyFile(h.bootstrap, bootstrap);
      const grants = [bootstrap, REPO_FILE, dir];
      const lists =
        spawnSync(
          bin,
          [
            '--permission',
            ...grants.map((g) => `--allow-fs-read=${g}`),
            '-e',
            "try { require('fs').readdirSync('/'); console.log('LIST') } catch { console.log('DENIED') }",
          ],
          { encoding: 'utf8' }
        ).stdout.trim() === 'LIST';
      if (!lists)
        console.info(`[permission-tree] ${bin}: three grants across roots no longer expose /`);
      const child = fork(bootstrap, [h.dorkHome, ...ancestorsOf(grants)], {
        execPath: bin,
        execArgv: ['--permission', ...grants.map((g) => `--allow-fs-read=${g}`)],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      try {
        const hello = (await new Promise((resolve) =>
          child.once('message', resolve)
        )) as HelloMessage;
        if (lists) {
          expect(
            hello.permission.fsReadRoot || hello.permission.readableAncestors.includes('/')
          ).toBe(true);
          expect(selfCheckPassed(hello)).toBe(false);
        }
      } finally {
        child.kill('SIGKILL');
      }
    });

    // Purpose: the real host's grants expose no folder above them — not `/`,
    // not the data directory, not any parent of the run or files folder —
    // when the extension's own folder sits on a different root (the repo).
    it('the host grants expose no folder above them', async () => {
      const host = makeHost(h, {
        id: 'tree',
        extensionDir: path.dirname(REPO_FILE),
        overrides: { execPath: bin, testSeams: { probes: true } },
      });
      await startOk(host);
      const above = ancestorsOf([
        isolatedRunDir(h.dorkHome, 'tree'),
        isolatedFilesDir(h.dorkHome, 'tree'),
      ]);
      expect(above).toContain('/');
      expect(await probe(host, 'readdirMany', above)).toEqual({ ok: true, value: [] });
      // The control: the run folder itself is readable, so the probe works.
      expect(await probe(host, 'readdirMany', [isolatedRunDir(h.dorkHome, 'tree')])).toMatchObject({
        ok: true,
        value: [expect.stringContaining('tree')],
      });
    });
  }
);
