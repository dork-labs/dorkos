/** Explicit disposable Chrome factory. Importing this module launches nothing. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { bounded, ownedChromeCleanup } from '../owned-chrome-cleanup.js';
import { createSharedNativeFixture, type NativePhase } from './fixture.js';
import { json, writeJson, sha } from './resources.js';
export interface ChromeHostOptions {
  surface: 'cli' | 'desktop';
  root: string;
  sandbox: string;
  fixtureHome: string;
  output: string;
  environment: NodeJS.ProcessEnv;
  deadline: number;
  attest(): Promise<unknown>;
  stage<T>(label: string, run: () => Promise<T>): Promise<T>;
  poll<T>(label: string, read: () => Promise<T | undefined>): Promise<T>;
  registerClose(close: () => Promise<void>): void;
  record(name: string, value: unknown): void;
}
/** Launch one owned disposable Chrome and emit exact PID/profile operator admission. */
export async function createChromeHost(o: ChromeHostOptions) {
  const fixture = await o.stage('Create shared fixture', async () => {
    const value = await createSharedNativeFixture({ sandbox: o.sandbox });
    o.registerClose(() => value.close());
    assert(Date.now() < o.deadline, 'Late shared fixture fenced');
    return value;
  });
  const profile = path.join(o.fixtureHome, 'Library/Application Support/Google/Chrome');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(profile), profile);
  const chromeLog = path.join(o.output, 'owned-native-chrome.log');
  const log = createWriteStream(chromeLog, { flags: 'wx', mode: 0o600 });
  o.registerClose(() =>
    bounded(new Promise<void>((resolve) => log.end(resolve)), 2000, 'Chrome log close')
  );
  await o.attest();
  const executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const chrome = spawn(
    executable,
    [
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--new-window',
      'chrome://extensions/',
    ],
    { env: o.environment, cwd: o.sandbox, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let chromeError: Error | undefined;
  chrome.once('error', (error) => {
    chromeError = error;
  });
  const chromeClosed = new Promise<void>((resolve) => chrome.once('close', () => resolve()));
  chrome.stdout!.pipe(log, { end: false });
  chrome.stderr!.pipe(log, { end: false });
  assert(chrome.pid, 'Owned Chrome PID required');
  const owner = ownedChromeCleanup(chrome.pid, profile);
  const census: { timer?: ReturnType<typeof setInterval> } = {};
  o.registerClose(async () => {
    clearInterval(census.timer);
    await bounded(owner.close(), 60000, 'Owned Chrome closure');
    await bounded(chromeClosed, 2000, 'Chrome stdio closure');
  });
  await owner.capture();
  census.timer = setInterval(() => {
    void owner.capture().catch(() => undefined);
  }, 500);
  const alive = async () => {
    assert(!chromeError, String(chromeError));
    assert.equal(chrome.exitCode, null);
    assert.equal(chrome.signalCode, null);
    await owner.capture();
  };
  const admission = await json(path.join(o.output, 'admission.json'));
  const rows = (
    await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command='], {
      timeout: 2000,
      maxBuffer: 4194304,
    })
  ).stdout;
  const match = rows
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/))
    .find((m) => m && Number(m[1]) === chrome.pid);
  assert(match && Number(match[2]) === process.pid && Number(match[3]) === chrome.pid);
  assert(
    match[5]!.startsWith(executable + ' ') && match[5]!.includes('--user-data-dir=' + profile)
  );
  await writeJson(path.join(o.output, 'operator-admission.json'), {
    schemaVersion: 1,
    surface: o.surface,
    root: o.root,
    output: o.output,
    sandbox: o.sandbox,
    profile,
    chrome: {
      pid: chrome.pid,
      pgid: Number(match[3]),
      identity: match[1] + ':' + match[4] + ':' + match[5],
      executable,
    },
    proof: { pid: process.pid, deadlineEpochMs: o.deadline },
    lease: admission.lease,
    chromeLog,
    fixture: {
      extensionDirectory: fixture.extensionDirectory,
      beforeAttachUrl: fixture.beforeAttachUrl,
      duringAttachUrl: fixture.duringAttachUrl,
      afterDetachUrl: fixture.afterDetachUrl,
    },
    extension: {
      manifestSha256: await sha(path.join(fixture.extensionDirectory, 'manifest.json')),
      scriptSha256: await sha(path.join(fixture.extensionDirectory, 'content.js')),
      scriptRelativePath: 'content.js',
    },
  });
  o.record('chrome', { pid: chrome.pid, profile, remoteDebuggingLaunchFlags: false });
  console.log(
    JSON.stringify({
      stage: 'manual-owned-extension',
      admission: path.join(o.output, 'operator-admission.json'),
      pid: chrome.pid,
      profile,
      extensionDirectory: fixture.extensionDirectory,
      beforeAttachUrl: fixture.beforeAttachUrl,
      instructions:
        'Load unpacked only in this owned Chrome, open beforeAttachUrl in its tab, enable chrome://inspect/#remote-debugging, then approve its native connection dialog.',
    })
  );
  const extensionProbe = (phase: NativePhase) =>
    o.poll('Extension ' + phase, async () => {
      await alive();
      return fixture.probe(phase);
    });
  await extensionProbe('before-attach');
  await o.poll('Owned Chrome native setting', async () => {
    try {
      const file = path.join(profile, 'DevToolsActivePort'),
        metadata = await lstat(file);
      assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size < 4096);
      assert.equal(await realpath(file), file);
      await readFile(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    }
  });
  return {
    fixture,
    chrome,
    profile,
    alive,
    extensionProbe,
    humanAfterDetachSameTab: async (selectedId: string) => {
      await o.attest();
      console.log(
        JSON.stringify({
          stage: 'manual-same-owned-tab-after-detach',
          pid: chrome.pid,
          selectedId,
          url: fixture.afterDetachUrl,
          instructions: 'Navigate the SAME selected owned tab to this fresh URL; keep that tab.',
        })
      );
      await extensionProbe('after-detach');
      fixture.assertSameTabWitness('after-detach');
    },
  };
}
