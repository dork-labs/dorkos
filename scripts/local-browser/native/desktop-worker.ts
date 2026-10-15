/** Normal packaged app inspector custody; no ASAR patch or unsupported Node preload. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import type { ElectronApplication } from 'playwright-core';
import { runNativeAcceptance } from './renderer.js';
import { LOGIN_SHELL_PATH_MARKER } from '../../../apps/desktop/src/shared/login-shell-path.js';
import { bounded } from '../owned-chrome-cleanup.js';
import { root, type WorkerOptions } from './options.js';
import { createPromptSeed, assertPromptSeed } from './prompt-fixture.js';
import { type InspectorReceipt } from './resources.js';
import { sha } from './resources.js';
import { readDesktopArtifact, readMechanism, assertArtifactUnchanged } from './artifact.js';
/** Qualify the normal packaged app inside the supported inspector custody boundary. */
export async function runDesktopWorker(options: WorkerOptions) {
  const { sandbox, output, operationDeadline: deadline } = options;
  assert.equal(process.platform, 'darwin');
  const candidate = options.candidate!;
  const artifact = await bounded(
    readDesktopArtifact(root, options.receipt, options.runtimeReceipt!, candidate),
    Math.max(1, deadline - Date.now()),
    'Explicit desktop artifact custody'
  );
  const mechanismReceipt = options.mechanismOnly
    ? undefined
    : await readMechanism(options.mechanismReceipt!, artifact);
  const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
  const playwright = desktopRequire('playwright-core') as typeof import('playwright-core');
  const remoteCallbackPath = path.join(root, 'scripts/local-browser/native/remote-callbacks.cjs');
  const remoteCallbackSource = await readFile(remoteCallbackPath, 'utf8');
  const remoteCallbacks = createRequire(import.meta.url)(remoteCallbackPath);
  for (const callback of Object.values(remoteCallbacks) as ((...args: unknown[]) => unknown)[]) {
    assert(
      remoteCallbackSource.includes(callback.toString()),
      'Remote callback must match raw source verbatim'
    );
    assert(!/\b__name\s*\(/.test(callback.toString()), 'Remote helper injection refused');
  }
  assert.equal(desktopRequire('playwright-core/package.json').version, '1.63.0');
  assert.equal(desktopRequire('electron/package.json').version, '41.10.7');
  const executablePath = path.join(candidate, 'Contents/MacOS/DorkOS');
  const fixtureHome = path.join(sandbox, 'home');
  const dataDirectory = path.join(fixtureHome, '.dork');
  const userData = path.join(fixtureHome, 'Library/Application Support/DorkOS');
  const cwd = path.join(fixtureHome, 'work');
  const cache = path.join(sandbox, 'empty-browser-cache');
  const temporary = path.join(sandbox, 'tmp');
  for (const folder of [fixtureHome, dataDirectory, userData, cwd, cache, temporary])
    await mkdir(folder, { recursive: true, mode: 0o700 });
  let port = 0;
  for (let i = 0; i < 50 && !port; i++) {
    const trial = 6000 + Math.floor(Math.random() * 1000);
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(trial, '127.0.0.1', resolve);
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      port = trial;
    } catch {
      server.close();
    }
  }
  assert(port, 'No owned 6xxx port available');
  const fakeShell = path.join(sandbox, 'fixture-login-shell');
  await writeFile(
    fakeShell,
    '#!/bin/sh\nprintf %s ' +
      JSON.stringify(LOGIN_SHELL_PATH_MARKER) +
      '; /usr/bin/env; printf %s ' +
      JSON.stringify(LOGIN_SHELL_PATH_MARKER) +
      '\n',
    { flag: 'wx', mode: 0o700 }
  );
  await chmod(fakeShell, 0o700);
  const environment = Object.fromEntries(
    // eslint-disable-next-line no-restricted-syntax -- Packaged proof sanitizes the inherited host environment before launching only owned fixtures.
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(DORKOS_|DORK_|npm_config_|npm_package_config_node_gyp_|GYP)/i.test(name) &&
        !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIALED|PAID|HARNESS_SMOKE|COMMUNITY_LIVE)/i.test(name) &&
        ![
          'NODE_OPTIONS',
          'NODE_PATH',
          'DEBUG',
          'PWDEBUG',
          'SSH_AUTH_SOCK',
          'ELECTRON_RUN_AS_NODE',
          'ELECTRON_RENDERER_URL',
          'ESBUILD_BINARY_PATH',
          'PLAYWRIGHT_BROWSERS_PATH',
          'BASH_ENV',
          'ENV',
          'ZDOTDIR',
          'PYTHONPATH',
          'PYTHONHOME',
          'PYTHONSTARTUP',
          'NODE_GYP_FORCE_PYTHON',
          'MAKEFLAGS',
          'MFLAGS',
        ].includes(name)
    )
  ) as Record<string, string>;
  Object.assign(environment, {
    CFFIXED_USER_HOME: fixtureHome,
    TMPDIR: temporary,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SHELL: fakeShell,
    PLAYWRIGHT_BROWSERS_PATH: cache,
    DORKOS_TEST_RUNTIME: 'true',
    DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
    DORKOS_TASKS_ENABLED: 'false',
    DORKOS_DEFAULT_CWD: cwd,
    DORKOS_BOUNDARY: fixtureHome,
    DORKOS_PORT: String(port),
    DORKOS_HOST: '127.0.0.1',
    DORKOS_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    DORKOS_DESKTOP_SUPPRESS_INSTALL_PROMPT: '1',
  });
  const firstRunPromptSeed = createPromptSeed();
  await writeFile(
    path.join(dataDirectory, 'config.json'),
    JSON.stringify({
      version: 1,
      server: { port, cwd, boundary: fixtureHome },
      scheduler: { enabled: false },
      heartbeats: { enabled: false, triageOnCredits: false },
      auth: { enabled: false },
      ...firstRunPromptSeed,
    }),
    { flag: 'wx', mode: 0o600 }
  );
  type CandidateIdentity = {
    home: string;
    userData: string;
    electron: string;
    canonical?: { home: string; userData: string };
  };
  const receipt: Record<string, unknown> & {
    remoteCallbacks: { path: string; sha256: string };
    preflight?: CandidateIdentity;
    probe?: InspectorReceipt;
    updaterCloseReadbacks?: unknown[];
    lateResourceCloseErrors?: string[];
    acceptance?: Record<string, unknown>;
  } = {
    status: 'running',
    root,
    output,
    sandbox,
    candidate,
    artifact,
    mechanismOnly: options.mechanismOnly,
    mechanismReceipt,
    personalAppTouched: false,
    nativeDiscoveryAttempted: false,
    remoteCallbacks: { path: remoteCallbackPath, sha256: await sha(remoteCallbackPath) },
  };
  const applications = new Set<ElectronApplication>();
  const updaterSuppression = new Map<ElectronApplication, Promise<unknown>>();
  async function suppressCandidateUpdater(app: ElectronApplication) {
    return app.evaluate(remoteCallbacks.suppressUpdater);
  }
  async function closeOwnedApplication(app: ElectronApplication) {
    // Never normal-quit a candidate until suppression is acknowledged; outer census owns a stuck app.
    await updaterSuppression.get(app);
    if (updaterSuppression.has(app)) {
      const finalReadback = await suppressCandidateUpdater(app);
      (receipt.updaterCloseReadbacks ??= []).push(finalReadback);
    }
    await app.close();
  }
  const closeTasks: (() => Promise<void>)[] = [];
  let active = true;
  function admit() {
    assert(active && Date.now() < deadline, 'Native operation budget expired');
  }
  async function step<T>(run: () => Promise<T>): Promise<T> {
    admit();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              active = false;
              reject(Error('Native operation deadline'));
            },
            Math.max(1, deadline - Date.now())
          );
          timer.unref();
        }),
      ]);
      admit();
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
  async function launch(executable: string, args: string[]) {
    return step(async () => {
      const app: ElectronApplication = await playwright._electron.launch({
        executablePath: executable,
        args,
        env: environment,
        cwd,
        timeout: Math.max(1, Math.min(60000, deadline - Date.now())),
      });
      applications.add(app);
      app.process().stdout?.on('data', (chunk) => process.stdout.write(chunk));
      app.process().stderr?.on('data', (chunk) => process.stderr.write(chunk));
      if (executable === executablePath) {
        const suppressed = suppressCandidateUpdater(app);
        updaterSuppression.set(app, suppressed);
        receipt.updaterSuppression = await suppressed;
      }
      if (!active || Date.now() >= deadline) {
        void closeOwnedApplication(app).catch(() => undefined);
        throw Error('Late launch fenced');
      }
      return app;
    });
  }
  try {
    const cfProbe = path.join(sandbox, 'cf-home-preflight.cjs');
    await writeFile(
      cfProbe,
      'const {app}=require("electron");app.whenReady().then(()=>{console.log("CFHOME_READY");});',
      { flag: 'wx', mode: 0o600 }
    );
    const preflightUserData = path.join(fixtureHome, 'preflight-user-data');
    await mkdir(preflightUserData, { mode: 0o700 });
    const preflight = await launch(desktopRequire('electron'), [
      cfProbe,
      '--user-data-dir=' + preflightUserData,
    ]);
    receipt.preflight = await step(() =>
      preflight.evaluate<CandidateIdentity>(remoteCallbacks.identity)
    );
    receipt.preflight.canonical = {
      home: await realpath(receipt.preflight.home),
      userData: await realpath(receipt.preflight.userData),
    };
    assert.equal(receipt.preflight.canonical.home, fixtureHome);
    assert.equal(receipt.preflight.canonical.userData, preflightUserData);
    assert.equal(receipt.preflight.electron, '41.10.7');
    assert(receipt.preflight.canonical.userData.startsWith(fixtureHome + path.sep));
    await step(() => preflight.close());
    applications.delete(preflight);
    const application = await launch(executablePath, ['--user-data-dir=' + userData]);
    const page = await step(() => application.firstWindow());
    await step(() => page.waitForURL(/^http:\/\/(127\.0\.0\.1|localhost):6[0-9]{3}/));
    const base = new URL(page.url()).origin;
    const configResponse = await step(() =>
      fetch(base + '/api/config', {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      })
    );
    assert.equal(configResponse.status, 200);
    const config: Parameters<typeof assertPromptSeed>[0] & { dorkHome: string } = await step(() =>
      configResponse.json()
    );
    assert.equal(await realpath(config.dorkHome), dataDirectory);
    receipt.firstRunPromptPrelaunchSeed = firstRunPromptSeed;
    receipt.firstRunPromptBootReadback = assertPromptSeed(config, firstRunPromptSeed);
    const stateResponse = await step(() =>
      fetch(base + '/api/local-browser/state', {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      })
    );
    assert.equal(stateResponse.status, 200);
    const state: { status: string } = await step(() => stateResponse.json());
    assert.equal(state.status, 'disconnected');
    const probe = createRequire(import.meta.url)(
      path.join(root, 'scripts/local-browser/native/inspector-probe.cjs')
    );
    assert.equal(typeof probe.probeInspector, 'function', 'Use actual inspected export');
    receipt.probe = await step(() =>
      probe.probeInspector(application, {
        root,
        candidate,
        fixtureHome,
        dataDirectory,
        sandbox,
        output,
        deadline,
        ...(options.mechanismOnly
          ? {}
          : {
              onReady: (custody: Parameters<typeof runNativeAcceptance>[0]) =>
                runNativeAcceptance(custody, {
                  promptSeed: firstRunPromptSeed,
                  sandbox,
                  fixtureHome,
                  dataDirectory,
                  output,
                  environment,
                  deadline,
                  registerClose: (close) => {
                    closeTasks.push(close);
                    if (!active)
                      void close().catch((error) => {
                        (receipt.lateResourceCloseErrors ??= []).push(String(error));
                      });
                  },
                  record: (name, value) => {
                    (receipt.acceptance ??= {})[name] = value;
                    if (name === 'nativeOpenAttempt') receipt.nativeDiscoveryAttempted = true;
                  },
                }),
            }),
      })
    );
    assert(receipt.probe);
    assert.equal(receipt.probe.status, 'passed-owned-node-inspector-mechanism-only');
    assert.equal(
      receipt.probe.finalFence.failed,
      null,
      'Inspector custody failed during final acknowledgement'
    );
    assert.equal(receipt.probe.finalFence.guardAttested, true);
    assert(!receipt.probe.forkFenceError);
    if (options.mechanismOnly)
      receipt.status = 'passed-owned-normal-candidate-node-inspector-mechanism-only';
    else {
      assert(receipt.probe.nativeContinuation?.actualCandidateRenderer);
      receipt.status = 'passed-packaged-desktop-native-chrome';
    }
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    active = false;
    const closeDeadline = Date.now() + 60_000;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([
          Promise.allSettled([...applications].map((app) => closeOwnedApplication(app))).then(
            (results) => {
              assert(
                results.every((result) => result.status === 'fulfilled'),
                'Owned application close failed'
              );
            }
          ),
          (async () => {
            const failures: unknown[] = [];
            for (const close of closeTasks.reverse()) {
              try {
                await close();
              } catch (error) {
                failures.push(String(error));
              }
            }
            if (failures.length) throw Error(JSON.stringify(failures));
          })(),
        ]).then((results) => {
          assert(
            results.every((result) => result.status === 'fulfilled'),
            'Owned resource close failed'
          );
        }),
        new Promise<never>((_, reject) => {
          closeTimer = setTimeout(
            () => reject(Error('60-second normal app closure deadline')),
            Math.max(1, closeDeadline - Date.now())
          );
          closeTimer.unref();
        }),
      ]);
      receipt.normalAppCloseResolved = true;
    } catch (error) {
      receipt.status = 'failed';
      receipt.closeError = String(error);
      process.exitCode = 1;
    } finally {
      clearTimeout(closeTimer);
    }
    try {
      await bounded(
        assertArtifactUnchanged(root, artifact),
        30000,
        'Post-normal-close complete custody'
      );
      if (mechanismReceipt) assert.equal(await sha(mechanismReceipt.path), mechanismReceipt.sha256);
      assert.equal(await sha(remoteCallbackPath), receipt.remoteCallbacks.sha256);
      receipt.custodyUnchanged = true;
    } catch (error) {
      receipt.status = 'failed';
      receipt.custodyError = String(error);
      process.exitCode = 1;
    }
    receipt.physicalClosureOwner =
      'Outer ops.run_owned identity census; app.close resolution is not physical proof';
    receipt.sandboxRetained = true;
    await writeFile(
      path.join(output, 'worker-receipt.json'),
      JSON.stringify(receipt, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    console.log(JSON.stringify(receipt));
  }
}
