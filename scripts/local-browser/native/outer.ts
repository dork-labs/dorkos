/** Shared900-second native proof owner; no artifact build, repair or implicit input selection. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream, constants as fsConstants } from 'node:fs';
import { mkdir, mkdtemp, realpath, open, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { installedCliEnvironment } from '../installed-cli-ui.js';
import { bounded, ownedChromeCleanup } from '../owned-chrome-cleanup.js';
import { json, writeJson } from './resources.js';
import { root, type NativeOptions } from './options.js';
const exec = promisify(execFile);
/** Own the native worker deadline, exact process cleanup and shared lane retention. */
export async function runNativeOuter(options: NativeOptions) {
  const totalDeadline = Date.now() + 900000;
  assert.equal(process.platform, 'darwin', 'This draft qualifies macOS Chrome only');
  assert(!process.versions.electron, 'Use the system Node tsx host, never Electron-as-Node');
  const receiptPath = options.receipt;
  const common = (
    await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: root,
      timeout: 2000,
    })
  ).stdout.trim();
  const lanePath =
    // eslint-disable-next-line no-restricted-syntax -- Standalone proof reads the explicit shared-lane path from its host environment.
    process.env.LOCAL_BROWSER_LANE_FILE ??
    path.join(path.dirname(path.dirname(common)), '.workspace/shared-local-heavy-producer.lock');
  const laneHandle = await open(lanePath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  assert.equal(await realpath(lanePath), lanePath);
  const laneStat = await laneHandle.stat();
  assert(laneStat.isFile());
  async function laneText() {
    const stat = await laneHandle.stat();
    assert(stat.size < 65536);
    const bytes = Buffer.alloc(stat.size);
    const read = await laneHandle.read(bytes, 0, bytes.length, 0);
    assert.equal(read.bytesRead, bytes.length);
    return bytes.toString('utf8');
  }
  const originalLaneText = await laneText();
  const lane = JSON.parse(originalLaneText);
  assert.equal(lane.root, root);
  assert(lane.scope.includes('native-proof'));
  const census = (await exec('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 2000 })).stdout;
  const parents = new Map(
    census.split('\n').flatMap((line) => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
      return m ? [[Number(m[1]), Number(m[2])] as [number, number]] : [];
    })
  );
  const ancestors = new Set<number>();
  let ancestor = process.pid;
  while (parents.has(ancestor) && !ancestors.has(ancestor)) {
    ancestors.add(ancestor);
    ancestor = parents.get(ancestor)!;
  }
  assert(ancestors.has(lane.pid), 'Lane marker owner must be this invocation ancestor');
  async function holdUnconfirmedLane() {
    const current = await lstat(lanePath);
    assert(
      current.isFile() &&
        !current.isSymbolicLink() &&
        current.ino === laneStat.ino &&
        current.dev === laneStat.dev,
      'Never change a replaced or foreign lane marker'
    );
    assert.equal(await laneText(), originalLaneText, 'Never change another producer marker text');
    const held = JSON.stringify({
      ...lane,
      status: 'owned-physical-closure-unconfirmed',
      output,
      sandbox,
      unconfirmedGroups: [{ pid: child.pid, fixture: sandbox }],
    });
    const bytes = Buffer.from(held);
    const written = await laneHandle.write(bytes, 0, bytes.length, 0);
    assert.equal(written.bytesWritten, bytes.length);
    await laneHandle.truncate(bytes.length);
    await laneHandle.sync();
    const after = await lstat(lanePath);
    assert(
      after.ino === laneStat.ino && after.dev === laneStat.dev,
      'Lane changed during hold; never unlink its replacement'
    );
    return { path: lanePath, inode: laneStat.ino, status: 'owned-physical-closure-unconfirmed' };
  }
  const output = path.join(
    root,
    '.dork/local-browser/native-proof',
    String(Date.now()) + '-' + randomUUID()
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  const sandbox = await realpath(
    await mkdtemp(path.join(tmpdir(), 'dorkos-native-proof-' + options.surface + '-'))
  );
  const home = path.join(sandbox, 'home'),
    data = path.join(sandbox, 'data'),
    cache = path.join(sandbox, 'cache');
  for (const directory of [home, data, cache]) await mkdir(directory, { mode: 0o700 });
  // eslint-disable-next-line no-restricted-syntax -- Standalone proof reads the host boundary, then sanitizes child environments or records source custody.
  const env = installedCliEnvironment(process.env, {
    fixtureHome: home,
    dataDirectory: data,
    browserCache: cache,
  });
  const log = createWriteStream(path.join(output, 'worker.log'), { flags: 'wx', mode: 0o600 });
  const workerCeiling = Math.max(1, Math.min(810000, totalDeadline - Date.now() - 90000));
  const operationDeadline =
    Date.now() +
    Math.min(
      options.surface === 'cli' ? 730000 : 720000,
      workerCeiling - (options.surface === 'cli' ? 80000 : 90000)
    );
  assert(operationDeadline > Date.now());
  await writeJson(path.join(output, 'admission.json'), {
    root,
    output,
    sandbox,
    options,
    outerPid: process.pid,
    operationDeadline,
    lease: {
      path: lanePath,
      device: laneStat.dev,
      inode: laneStat.ino,
      sha256: createHash('sha256').update(originalLaneText).digest('hex'),
      ownerPid: lane.pid,
      scope: lane.scope,
    },
  });
  const forwarded = ['--surface', options.surface, '--receipt', receiptPath];
  if (options.candidate) forwarded.push('--candidate', options.candidate);
  if (options.runtimeReceipt) forwarded.push('--runtime-receipt', options.runtimeReceipt);
  if (options.mechanismReceipt) forwarded.push('--mechanism-receipt', options.mechanismReceipt);
  if (options.mechanismOnly) forwarded.push('--mechanism-only');
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      path.join(root, 'scripts/local-browser/native-consent-proof.ts'),
      '--worker',
      ...forwarded,
      '--sandbox',
      sandbox,
      '--output',
      output,
    ],
    { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  void exit.catch(() => undefined);
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  assert(child.pid);
  const owner = ownedChromeCleanup(child.pid, sandbox);
  const outerReceipt: Record<string, unknown> = {
    status: 'failed',
    input: options,
    output,
    sandbox,
    budgetSeconds: 900,
    workerCeilingSeconds: 810,
    cleanupReserveSeconds: 90,
    personalBrowserTouched: false,
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await owner.capture();
    timer = setInterval(() => {
      void owner.capture().catch(() => undefined);
    }, 500);
    const code = await bounded(
      exit,
      Math.max(1, Math.min(810000, totalDeadline - Date.now() - 90000)),
      'Native artifact worker'
    );
    assert.equal(code, 0);
    const inner = await json(path.join(output, 'worker-receipt.json'));
    const expected =
      options.surface === 'cli'
        ? 'passed-installed-cli-native-chrome'
        : options.mechanismOnly
          ? 'passed-owned-normal-candidate-node-inspector-mechanism-only'
          : 'passed-packaged-desktop-native-chrome';
    assert.equal(inner.status, expected);
    outerReceipt.worker = inner;
    outerReceipt.status =
      'passed-bounded-' +
      options.surface +
      (options.mechanismOnly ? '-inspector-mechanism' : '-native-chrome');
  } catch (error) {
    outerReceipt.error = String(error);
    process.exitCode = 1;
  } finally {
    clearInterval(timer);
    try {
      await bounded(owner.close(), 60000, 'Outer exact owned tree closure');
      outerReceipt.physicalClosure = true;
    } catch (error) {
      outerReceipt.status = 'failed';
      outerReceipt.cleanupError = String(error);
      process.exitCode = 1;
      try {
        outerReceipt.heldLane = await holdUnconfirmedLane();
      } catch (holdError) {
        outerReceipt.laneHoldError = String(holdError);
      }
    }
    // Preserve all fixtures, successful or failed: no deletion can conceal a closure failure.
    outerReceipt.sandboxRetained = true;
    try {
      await bounded(new Promise<void>((r) => log.end(r)), 2000, 'Outer log closure');
    } catch (error) {
      outerReceipt.status = 'failed';
      outerReceipt.logCloseError = String(error);
      process.exitCode = 1;
    }
    await writeJson(path.join(output, 'outer-receipt.json'), outerReceipt);
    await laneHandle.close();
    console.log(
      JSON.stringify({
        output,
        status: outerReceipt.status,
        heldLane: outerReceipt.heldLane,
        laneHoldError: outerReceipt.laneHoldError,
      })
    );
  }
}
