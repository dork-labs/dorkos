/** Qualified native bridge proof; the default invocation prepares nothing and launches nothing. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { bounded, ownedChromeCleanup } from './owned-chrome-cleanup.js';

async function run(): Promise<void> {
  assert.equal(process.platform, 'darwin', 'This qualification records macOS coverage only');
  const root = process.cwd();
  const common = (
    await promisify(execFile)('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      timeout: 2000,
    })
  ).stdout.trim();
  const lanePath =
    // eslint-disable-next-line no-restricted-syntax -- Existing qualification lane override.
    process.env.LOCAL_BROWSER_LANE_FILE ??
    path.join(path.dirname(path.dirname(common)), '.workspace/shared-local-heavy-producer.lock');
  const lane = JSON.parse(await readFile(lanePath, 'utf8')) as { root: string; scope: string };
  assert(
    lane.root === root && lane.scope.includes('bridge-proof'),
    'Acquire the owned bridge-proof lane before execution'
  );
  const output = path.join(root, '.dork/local-browser/bridge-proof', String(Date.now()));
  const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dorkos-bridge-proof-')));
  await mkdir(output, { recursive: true, mode: 0o700 });
  for (const name of ['os-home', 'user-data', 'session-data', 'data', 'logs'])
    await mkdir(path.join(fixture, name), { recursive: true, mode: 0o700 });
  const receipt: Record<string, unknown> = {
    status: 'running',
    output,
    fixture,
    root,
    qualificationOnly: true,
    personalBrowserTouched: false,
    inferenceCalled: false,
  };
  let child: ReturnType<typeof spawn> | undefined;
  let cleanup: ReturnType<typeof ownedChromeCleanup> | undefined;
  let captureTimer: ReturnType<typeof setInterval> | undefined;
  const log = createWriteStream(path.join(output, 'native-bridge.log'));
  let stdout = '';
  let physicalClosure = false;
  try {
    const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
    const playwright = path.dirname(desktopRequire.resolve('playwright-core/package.json'));
    const playwrightVersion = JSON.parse(
      await readFile(path.join(playwright, 'package.json'), 'utf8')
    ).version;
    assert.equal(playwrightVersion, '1.63.0');
    const electron = desktopRequire('electron') as string;
    assert.equal(typeof electron, 'string');
    const source = path.join(root, 'apps/desktop/src/main/local-browser/index.ts');
    const bundle = path.join(output, 'production-bridge.cjs');
    // Compilation happens only inside this explicitly executed, lane-qualified function.
    const esbuild = desktopRequire('esbuild') as {
      build(options: Record<string, unknown>): Promise<unknown>;
    };
    await bounded(
      esbuild.build({
        entryPoints: [source],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        external: ['electron'],
        logLevel: 'silent',
      }),
      15_000,
      'Production bridge compilation'
    );
    receipt.sourceSha256 = createHash('sha256')
      .update(await readFile(source))
      .digest('hex');
    receipt.bundleSha256 = createHash('sha256')
      .update(await readFile(bundle))
      .digest('hex');
    receipt.fixtureSha256 = createHash('sha256')
      .update(await readFile(path.join(root, 'scripts/local-browser/bridge-feasibility.cjs')))
      .digest('hex');
    receipt.playwright = playwrightVersion;
    const environment = Object.fromEntries(
      // eslint-disable-next-line no-restricted-syntax -- Qualification child receives no credentials or inherited app flags.
      Object.entries(process.env).filter(([name]) => {
        const upper = name.toUpperCase();
        return (
          !/^(DORKOS_|DORK_|PW_)/.test(upper) &&
          !/(KEY|TOKEN|SECRET|PASSWORD|PAID|CREDENTIALED|HARNESS_SMOKE|COMMUNITY_LIVE)/.test(
            upper
          ) &&
          ![
            'NODE_OPTIONS',
            'NODE_PATH',
            'ELECTRON_RUN_AS_NODE',
            'DEBUG',
            'PWDEBUG',
            'SSH_AUTH_SOCK',
            'BASH_ENV',
            'ENV',
            'ZDOTDIR',
          ].includes(upper)
        );
      })
    );
    child = spawn(
      electron,
      [
        path.join(root, 'scripts/local-browser/bridge-feasibility.cjs'),
        bundle,
        `--user-data-dir=${path.join(fixture, 'user-data')}`,
        `--dorkos-bridge-fixture=${fixture}`,
      ],
      {
        cwd: fixture,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...environment,
          CFFIXED_USER_HOME: path.join(fixture, 'os-home'),
          DORK_HOME: path.join(fixture, 'data'),
          DORKOS_BRIDGE_PROOF_DIRECTORY: fixture,
          DORKOS_BRIDGE_PROOF_OUTPUT: output,
          DORKOS_BRIDGE_PLAYWRIGHT: playwright,
          ELECTRON_ENABLE_LOGGING: '1',
        },
      }
    );
    const exited = new Promise<number | null>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('exit', resolve);
    });
    // Attach immediately, so an early spawn failure is observed during census too.
    void exited.catch(() => undefined);
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-1024 * 1024);
      log.write(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      log.write(chunk);
    });
    assert(child.pid, 'Electron did not receive an owned PID');
    receipt.pid = child.pid;
    cleanup = ownedChromeCleanup(child.pid, fixture);
    await cleanup.capture();
    captureTimer = setInterval(() => {
      void cleanup?.capture().catch((error: unknown) => {
        receipt.censusError = String(error);
      });
    }, 500);
    const exit = await bounded(exited, 60_000, 'Native bridge proof');
    assert.equal(exit, 0, 'Native bridge fixture failed; inspect native-bridge.log');
    const result = stdout.split('\n').find((line) => line.startsWith('BRIDGE_PROOF_RESULT '));
    assert(result, 'Native bridge fixture returned no proof result');
    const proof = JSON.parse(result.slice('BRIDGE_PROOF_RESULT '.length)) as {
      ok: boolean;
      playwright: string;
    };
    assert.equal(proof.ok, true);
    assert.equal(proof.playwright, playwrightVersion);
    receipt.proof = proof;
    receipt.status = 'passed-native-bridge-reparent-proof';
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    clearInterval(captureTimer);
    try {
      if (cleanup) await bounded(cleanup.close(), 60_000, 'Owned Electron physical cleanup');
      else assert(!child?.pid, 'Electron started before ownership capture; preserve its fixture');
      physicalClosure = true;
      receipt.ownedProcessesPhysicallyClosed = true;
    } catch (error) {
      receipt.status = 'failed';
      receipt.cleanupError = String(error);
      process.exitCode = 1;
    }
    await bounded(new Promise<void>((resolve) => log.end(resolve)), 2000, 'Proof log close').catch(
      (error: unknown) => {
        receipt.logCloseError = String(error);
        receipt.status = 'failed';
        process.exitCode = 1;
      }
    );
    if (physicalClosure) {
      try {
        await rm(fixture, { recursive: true, force: true });
        receipt.temporaryDataRemoved = true;
      } catch (error) {
        receipt.temporaryDataRemoved = false;
        receipt.status = 'failed';
        receipt.cleanupError = String(error);
        process.exitCode = 1;
      }
    } else receipt.temporaryDataRemoved = false;
    receipt.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(
      JSON.stringify({
        output,
        status: receipt.status,
        error: receipt.error,
        cleanupError: receipt.cleanupError,
        temporaryDataRemoved: receipt.temporaryDataRemoved,
      })
    );
  }
}

if (process.argv.includes('--execute')) await run();
else console.log('Prepared bridge proof. Execution requires --execute and the bridge-proof lane.');
