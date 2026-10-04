import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { IsolatedExtensionHost } from '../../server/src/services/extensions/isolation/isolated-host';

/**
 * The packaged-desktop proof for isolated extensions (DOR-2686 task 3.6).
 *
 * In the packaged app the server runs in an Electron `utilityProcess`, whose
 * `process.execPath` is the app's own helper binary, so every isolated
 * extension is forked on THAT binary with `ELECTRON_RUN_AS_NODE=1`, from the
 * `extension-child.cjs` the build unpacked beside `app.asar`. Whether that
 * Node honours `--permission` is the open question this step answers for the
 * build that was just packaged: it forks the packaged child on the packaged
 * helper, through the real `IsolatedExtensionHost`, and requires
 *
 * - the self-check to pass (the permission model on, the positive control
 *   true, and child processes, workers, addons, WASI and writing `/` off);
 * - a read of DorkOS's data directory to be denied by Node;
 * - a connection to a listening but undeclared port to be refused by the
 *   network guard, with the server seeing no connection.
 *
 * If Electron ignored the flags, the self-check fails and so does this step;
 * the runtime refuses to run isolated extensions in that case anyway (fail
 * closed), and that is a finding to report, never a check to weaken.
 *
 * What it does not reproduce: the `utilityProcess` parent itself. The host
 * here is plain Node; the child's binary, flags, environment and bootstrap
 * are the ones the packaged server uses.
 */

/** A probe bundle: CommonJS, exactly what the compiler emits for a server entry. */
const PROBE_BUNDLE = `
'use strict';
const fs = require('fs');
async function attempt(fn) {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, code: (e && e.code) || (e && e.cause && e.cause.code) || null, message: String(e && e.message) }; }
}
exports.probes = {
  versions: () => attempt(() => ({ node: process.versions.node, electron: process.versions.electron || null })),
  readFile: (p) => attempt(() => fs.readFileSync(p, 'utf8')),
  fetch: (url) => attempt(async () => (await fetch(url)).status),
};
`;

/** A probe's report. */
interface Report {
  ok: boolean;
  value?: unknown;
  code?: string | null;
  message?: string;
}

/**
 * The helper binary Electron's utility processes run on, inside a `.app`.
 *
 * @param appPath - The packaged `.app` bundle.
 */
function helperBinary(appPath: string): string {
  const name = path.basename(appPath, '.app');
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');
  const exact = path.join(frameworks, `${name} Helper.app`, 'Contents', 'MacOS', `${name} Helper`);
  if (existsSync(exact)) return exact;
  const found = readdirSync(frameworks).find((entry) => /^.+ Helper\.app$/.test(entry));
  if (!found) throw new Error(`No helper app under ${frameworks}.`);
  return path.join(frameworks, found, 'Contents', 'MacOS', found.replace(/\.app$/, ''));
}

/**
 * Prove the packaged app runs isolated extensions with their limits on.
 *
 * @param appPath - The packaged `.app` bundle.
 * @returns A one-line summary for the smoke log.
 */
export async function assertExtensionIsolation(appPath: string): Promise<string> {
  const child = path.join(
    appPath,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'dist',
    'server',
    'extension-child.cjs'
  );
  if (!existsSync(child)) {
    throw new Error(
      `The packaged app has no unpacked extension child at ${child}. electron-builder.yml must ` +
        `asarUnpack dist/server/extension-child.cjs, and build-server.ts must emit it.`
    );
  }
  const helper = helperBinary(appPath);
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dorkos-smoke-isolation-')));
  const dorkHome = path.join(tmp, '.dork');
  const bundle = path.join(tmp, 'probe.js');
  writeFileSync(bundle, PROBE_BUNDLE);
  const logs: string[] = [];
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const host = new IsolatedExtensionHost({
    extensionId: 'smoke-isolation',
    displayName: 'Smoke isolation',
    bundlePath: bundle,
    extensionDir: tmp,
    dorkHome,
    isolation: {
      runtime: 'subprocess',
      net: [],
      run: [],
      resolvedRun: [],
      agents: false,
      memoryMb: 128,
    },
    dorkosPort: 1,
    bootstrapPath: child,
    execPath: helper,
    electronRunAsNode: true,
    logger: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
    testSeams: { probes: true },
  });
  try {
    const started = await host.start();
    if (!started.ok) {
      throw new Error(
        `The packaged app could not start an isolated extension with its limits on ` +
          `(${started.code}). If the self-check failed, Electron's Node ignored --permission in ` +
          `run-as-node mode — report it; do not weaken the check.\n${logs.join('\n')}`
      );
    }
    const versions = (await host.probe('versions')) as Report;
    const electron =
      (versions.value as { electron: string | null; node: string } | undefined) ?? null;
    if (!electron?.electron) {
      throw new Error(`The isolated child did not run on Electron: ${JSON.stringify(versions)}`);
    }
    const read = (await host.probe('readFile', path.join(dorkHome, 'config.json'))) as Report;
    if (read.ok || read.code !== 'ERR_ACCESS_DENIED') {
      throw new Error(`Reading DorkOS's data directory was not denied: ${JSON.stringify(read)}`);
    }
    const fetched = (await host.probe('fetch', `http://127.0.0.1:${port}/`)) as Report;
    if (fetched.ok || fetched.code !== 'ERR_EXTENSION_NET_DENIED' || accepted !== 0) {
      throw new Error(
        `An undeclared connection was not refused: ${JSON.stringify(fetched)}, ${accepted} accepted`
      );
    }
    return `Electron ${electron.electron} (Node ${electron.node}) on ${path.basename(helper)}: self-check passed, data dir read denied, undeclared connection refused`;
  } finally {
    await host.stop();
    await new Promise((resolve) => server.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  }
}
