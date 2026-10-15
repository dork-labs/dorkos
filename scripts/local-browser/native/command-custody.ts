/** One explicitly granted standard build/pack command; no native rebuild or repair. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, readFile, realpath, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { installedCliEnvironment } from '../installed-cli-ui.js';
import { runProofCommand } from '../proof-command.js';
import { bounded } from '../owned-chrome-cleanup.js';
import { root } from './options.js';
import { json, sha, writeJson } from './resources.js';
import { builtInputs, assertBuiltPayloads, captureDesktopInputs } from './build-inputs.js';
import { archiveManifest, bundleManifest } from './bundle.js';
import { standardCommands as commands, type CommandReceipt } from './build-custody.js';
export type BuildCommand = keyof typeof commands;
/** Run one explicitly granted standard command and retain immutable provenance evidence. */
export async function runCustodyCommand(
  command: BuildCommand,
  output: string,
  previousPath: string | undefined,
  candidate: string,
  electronCache: string
) {
  const deadline = Date.now() + 600000,
    receipt: CommandReceipt = {
      status: 'failed',
      root,
      command,
      output,
      candidate,
      budgetSeconds: 600,
      commands: [],
      inputHashes: {},
    };
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  assert.equal(candidate, path.join(root, 'apps/desktop/release/mac-arm64/DorkOS.app'));
  for (const evidence of [output, output + '.command.log', output + '.command.log.command.cjs']) {
    try {
      await lstat(evidence);
      throw Error('Refuse existing command evidence ' + evidence);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  assert(Object.hasOwn(commands, command));
  assert.equal(await realpath(electronCache), electronCache);
  assert(
    electronCache.startsWith(path.join(root, '.dork') + path.sep),
    'Explicit private Electron cache required'
  );
  const exec = promisify(execFile),
    common = (
      await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: root,
        timeout: 2000,
      })
    ).stdout.trim();
  // eslint-disable-next-line no-restricted-syntax -- Standalone proof reads the explicitly owned lane from its host environment.
  const proofEnvironment = process.env;
  const markerPath =
    proofEnvironment.LOCAL_BROWSER_LANE_FILE ??
    path.join(path.dirname(path.dirname(common)), '.workspace/shared-local-heavy-producer.lock');
  assert.equal(await realpath(markerPath), markerPath);
  const handle = await open(markerPath, constants.O_RDWR | constants.O_NOFOLLOW),
    markerInfo = await handle.stat();
  assert(markerInfo.isFile() && markerInfo.size < 65536);
  const markerBytes = Buffer.alloc(markerInfo.size);
  assert.equal(
    (await handle.read(markerBytes, 0, markerBytes.length, 0)).bytesRead,
    markerBytes.length
  );
  const raw = markerBytes.toString('utf8'),
    marker = JSON.parse(raw);
  assert.equal(marker.root, root);
  assert(marker.scope.includes('desktop-proof'));
  const rows = (await exec('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 2000 })).stdout;
  const parents = new Map(
    rows.split('\n').flatMap((line) => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
      return m ? [[Number(m[1]), Number(m[2])] as [number, number]] : [];
    })
  );
  const ancestors = new Set<number>();
  let cursor = process.pid;
  while (parents.has(cursor) && !ancestors.has(cursor)) {
    ancestors.add(cursor);
    cursor = parents.get(cursor)!;
  }
  assert(ancestors.has(marker.pid), 'Build lane owner must be actual ancestor');
  let started = false;
  try {
    const before = await bounded(
      captureDesktopInputs(root),
      30000,
      'Before-command source/native custody'
    );
    receipt.inputs = before;
    const sequence = ['shared-build', 'desktop-build', 'desktop-pack'],
      index = sequence.indexOf(command);
    let previous: CommandReceipt | undefined;
    if (index > 0) {
      assert(previousPath);
      assert.equal(await realpath(previousPath), previousPath);
      previous = await json<CommandReceipt>(previousPath);
      assert.equal(previous.status, 'passed-normal-desktop-command');
      assert.equal(previous.command, sequence[index - 1]);
      assert.equal(previous.candidate, candidate);
      assert.deepEqual(previous.inputs, before);
      receipt.previous = { path: previousPath, sha256: await sha(previousPath) };
      receipt.inputHashes = { ...previous.inputHashes, [previousPath]: receipt.previous.sha256 };
      receipt.commands = [...previous.commands];
    } else {
      assert(!previousPath);
      receipt.commands = [];
      receipt.inputHashes = {};
    }
    const frozen =
      command === 'desktop-pack'
        ? await bounded(builtInputs(root), 15000, 'Frozen built inputs')
        : undefined;
    if (frozen) assert.deepEqual(frozen, previous!.builtInputs);
    const home = await realpath(await mkdtemp(path.join(path.dirname(output), 'command-home-')));
    for (const name of ['', 'data', 'cache', 'tmp'])
      await mkdir(path.join(home, name), { recursive: true, mode: 0o700 });
    // eslint-disable-next-line no-restricted-syntax -- Standalone proof reads the host boundary, then sanitizes child environments or records source custody.
    const env = installedCliEnvironment(process.env, {
      fixtureHome: home,
      dataDirectory: path.join(home, 'data'),
      browserCache: path.join(home, 'cache'),
    });
    Object.assign(env, {
      TMPDIR: path.join(home, 'tmp'),
      ELECTRON_CACHE: electronCache,
      ELECTRON_BUILDER_CACHE: path.join(home, 'builder-cache'),
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    });
    await writeFile(path.join(home, 'npmrc'), '');
    await writeFile(path.join(home, 'global-npmrc'), '');
    const log = output + '.command.log';
    started = true;
    await bounded(
      runProofCommand({ name: 'pnpm', args: [...commands[command]], cwd: root, env, log }),
      365000,
      'Standard command and physical cleanup'
    );
    receipt.commands.push({
      name: 'pnpm',
      args: commands[command],
      log,
      logSha256: await sha(log),
      exitCode: 0,
      physicallyClosed: true,
    });
    const after = await bounded(
      captureDesktopInputs(root),
      30000,
      'After-command source/native custody'
    );
    assert.deepEqual(after, before);
    if (command !== 'shared-build')
      receipt.builtInputs = await bounded(builtInputs(root), 15000, 'Built input inventory');
    if (frozen) {
      assert(receipt.builtInputs);
      assert.deepEqual(receipt.builtInputs, frozen);
      const archive = await bounded(
        archiveManifest(candidate),
        30000,
        'Fresh packaged ASAR integrity'
      );
      receipt.frozenDesktopPayloadMatches = assertBuiltPayloads(frozen, archive);
      receipt.archive = archive;
      receipt.bundle = await bounded(bundleManifest(candidate), 30000, 'Fresh full bundle');
    }
    assert.deepEqual(
      await bounded(captureDesktopInputs(root), 30000, 'Final command custody'),
      before
    );
    assert(Date.now() < deadline, 'Command custody exceeded600s');
    receipt.status = 'passed-normal-desktop-command';
  } catch (error) {
    receipt.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
    if (started) {
      try {
        const current = await lstat(markerPath);
        assert(
          current.isFile() &&
            !current.isSymbolicLink() &&
            current.ino === markerInfo.ino &&
            current.dev === markerInfo.dev
        );
        assert.equal(await readFile(markerPath, 'utf8'), raw);
        const held = Buffer.from(
          JSON.stringify({ ...marker, status: 'owned-command-closure-requires-inspection', output })
        );
        assert.equal((await handle.write(held, 0, held.length, 0)).bytesWritten, held.length);
        await handle.truncate(held.length);
        await handle.sync();
        const after = await lstat(markerPath);
        assert(
          after.ino === markerInfo.ino && after.dev === markerInfo.dev,
          'Marker changed during hold'
        );
        receipt.heldLane = { path: markerPath, inode: markerInfo.ino };
      } catch (holdError) {
        receipt.holdError = String(holdError);
      }
    }
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await writeJson(output, receipt);
    await handle.close();
  }
}
