/**
 * Isolation on Electron's own Node (DOR-2686 task 3.6).
 *
 * The packaged desktop app's server runs in an Electron `utilityProcess`, so
 * the child it forks runs on an Electron binary with `ELECTRON_RUN_AS_NODE=1`,
 * not on a stock Node. Whether that Node honours `--permission` is exactly
 * what the self-check exists to find out, and this suite asks it directly:
 * the REAL child bootstrap, forked on the Electron binary the desktop app
 * depends on, must pass the self-check and then show the same refusals the
 * stock-Node suites assert.
 *
 * What this does NOT prove: the signed, packaged app. That binary is the
 * same Electron build with a different name, an ASAR archive and code
 * signing; `apps/desktop/scripts/smoke-packaged.ts` runs the same check
 * against the packaged app's own helper binary in the desktop-smoke job.
 *
 * Skips, saying why, when the Electron binary is not installed or cannot run
 * as plain Node on this machine (a headless Linux runner without its
 * libraries). When it runs, every assertion can fail.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanup,
  countingServer,
  createHarness,
  makeHost,
  probe,
  startOk,
  type Harness,
} from './isolation-harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../..');

/** The Electron binary the desktop app depends on, if it runs as Node here. */
function electronBinary(): { path: string | null; why: string } {
  let binary: string;
  try {
    const requireFromDesktop = createRequire(path.join(ROOT, 'apps/desktop/package.json'));
    binary = requireFromDesktop('electron') as unknown as string;
  } catch {
    return { path: null, why: 'electron is not installed' };
  }
  const probeRun = spawnSync(binary, ['-e', 'process.stdout.write(process.versions.electron)'], {
    env: { ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (probeRun.status !== 0 || !probeRun.stdout) {
    return {
      path: null,
      why: `electron cannot run as Node here (${probeRun.stderr || probeRun.error})`,
    };
  }
  return { path: binary, why: `Electron ${probeRun.stdout}` };
}

const electron = electronBinary();
console.info(`[electron-run-as-node] ${electron.path ? 'running on' : 'skipped:'} ${electron.why}`);

describe.skipIf(!electron.path)('isolation on Electron run-as-node', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await cleanup(h);
  });

  // Purpose: Electron's Node honours --permission in run-as-node mode, so the
  // self-check passes; and the limits are real there, not just reported.
  it('passes the self-check and enforces the same limits', async () => {
    const server = await countingServer(h);
    const config = path.join(h.dorkHome, 'config.json');
    await fs.writeFile(config, '{}');
    const host = makeHost(h, {
      net: [],
      overrides: {
        execPath: electron.path!,
        electronRunAsNode: true,
        testSeams: { probes: true },
      },
    });
    await startOk(host);
    const versions = await probe(host, 'versions');
    expect((versions.value as { electron: string | null }).electron).toBeTruthy();
    expect(await probe(host, 'readFile', config)).toMatchObject({
      ok: false,
      code: 'ERR_ACCESS_DENIED',
    });
    expect(await probe(host, 'realExecSync')).toMatchObject({
      ok: false,
      code: 'ERR_ACCESS_DENIED',
    });
    expect(await probe(host, 'worker')).toMatchObject({ ok: false, code: 'ERR_ACCESS_DENIED' });
    expect(await probe(host, 'binding')).toMatchObject({ ok: false, code: 'ERR_ACCESS_DENIED' });
    expect(await probe(host, 'fetch', `http://127.0.0.1:${server.port}/`)).toMatchObject({
      ok: false,
      code: 'ERR_EXTENSION_NET_DENIED',
    });
    expect(server.count()).toBe(0);
  }, 30_000);

  // Purpose: the fail-closed path on Electron too — without the model, refused.
  it('refuses on Electron without the permission model', async () => {
    const host = makeHost(h, {
      overrides: {
        execPath: electron.path!,
        electronRunAsNode: true,
        testSeams: { probes: true, omitPermission: true },
      },
    });
    expect(await host.start()).toMatchObject({ ok: false, code: 'isolation_unavailable' });
  }, 30_000);
});
