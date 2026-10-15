/** Installed CLI native qualification; no source Service or native Chrome automation transport. */
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { bounded, ownedChromeCleanup } from '../owned-chrome-cleanup.js';
import { runProofCommand } from '../proof-command.js';
import { installedCliEnvironment, proofUiDriver } from '../installed-cli-ui.js';
import { setupOwnedFirstRunUi } from '../../../apps/e2e/pages/local-browser-installed-proof.js';
import { ChatPage } from '../../../apps/e2e/pages/ChatPage.js';
import { makeBootstrapSource } from './bootstrap.js';
import { readQualifiedArtifact } from './cli-artifact.js';
import { runInstalledExistingAcceptance, type State } from './acceptance.js';
import { createChromeHost } from './chrome-host.js';
import { captureProofSource } from '../source-snapshot.js';
import { root, type WorkerOptions } from './options.js';
import { nap, json, sha, reservePort } from './resources.js';
const exec = promisify(execFile);
/** Qualify an explicit installed CLI artifact through its public service and scoped tools. */
export async function runCliWorker(options: WorkerOptions) {
  const { sandbox, output, operationDeadline: deadline } = options;
  const receiptPath = options.receipt;
  let active = true;
  function admit() {
    assert(active && Date.now() < deadline, 'Native artifact operation deadline expired');
  }
  async function stage<T>(label: string, run: () => Promise<T>, maximum = 45000): Promise<T> {
    admit();
    try {
      const result = await bounded(run(), Math.min(maximum, deadline - Date.now()), label);
      admit();
      return result;
    } catch (error) {
      active = false;
      throw error;
    }
  }
  async function poll<T>(
    label: string,
    read: () => Promise<T | undefined>,
    maximum = 45000
  ): Promise<T> {
    return stage(
      label,
      async () => {
        for (;;) {
          admit();
          const result = await read();
          if (result !== undefined) return result;
          await nap(200);
        }
      },
      maximum
    );
  }
  const artifact = await stage(
    'Exact CLI archive/source custody',
    () => readQualifiedArtifact(receiptPath),
    Math.max(1, deadline - Date.now())
  );
  const artifactReceiptHash = await sha(receiptPath);
  const home = path.join(sandbox, 'home'),
    data = path.join(sandbox, 'data'),
    cache = path.join(sandbox, 'cache');
  const installation = path.join(sandbox, 'installation'),
    cwd = path.join(sandbox, 'work');
  const profile = path.join(home, 'Library/Application Support/Google/Chrome');
  for (const directory of [installation, cwd, profile])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  // eslint-disable-next-line no-restricted-syntax -- Standalone proof reads the host boundary, then sanitizes child environments or records source custody.
  const env = installedCliEnvironment(process.env, {
    fixtureHome: home,
    dataDirectory: data,
    browserCache: cache,
  });
  const temporary = path.join(sandbox, 'tmp');
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  env.TMPDIR = temporary;
  await writeFile(path.join(home, 'npmrc'), '');
  await writeFile(path.join(home, 'global-npmrc'), '');
  await writeFile(
    path.join(installation, 'package.json'),
    JSON.stringify({ name: 'owned-native-artifact-proof', version: '1.0.0', private: true })
  );
  const receipt: Record<string, unknown> & {
    lateCloseErrors?: string[];
    detachedSelectedId?: string;
  } = {
    status: 'failed',
    artifact,
    sandbox,
    output,
    paidInference: false,
    personalBrowserTouched: false,
    nativeEndpointOverride: false,
    operationBudgetSeconds: 730,
  };
  const owners: ReturnType<typeof ownedChromeCleanup>[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  const children: ChildProcess[] = [];
  type UiContext = Awaited<ReturnType<typeof proofUiDriver.launchPersistentContext>>;
  let ui: UiContext | undefined, context: UiContext | undefined, base: string | undefined;
  const logs: ReturnType<typeof createWriteStream>[] = [];
  async function own(child: ChildProcess, marker: string) {
    children.push(child);
    assert(child.pid);
    const owner = ownedChromeCleanup(child.pid, marker);
    owners.push(owner);
    await owner.capture();
    timers.push(
      setInterval(() => {
        void owner.capture().catch((error) => {
          receipt.censusError = String(error);
        });
      }, 500)
    );
  }
  function launch(name: string, args: string[], marker: string) {
    admit();
    const child = spawn(name, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = createWriteStream(
      path.join(output, path.basename(marker).replace(/[^a-z0-9-]/gi, '_') + '.log')
    );
    logs.push(log);
    child.stdout!.pipe(log, { end: false });
    child.stderr!.pipe(log, { end: false });
    child.once('error', (error) => {
      receipt.spawnError = String(error);
    });
    return child;
  }
  const closeTasks: (() => Promise<void>)[] = [];

  try {
    // Existing bounded command: up to300s command +60s physical cleanup. No build or pack.
    await stage(
      'Install exact qualified archive',
      () =>
        runProofCommand({
          name: 'npm',
          args: [
            'install',
            '--global=false',
            '--prefix',
            installation,
            '--no-audit',
            '--no-fund',
            '--save-exact',
            artifact.tarball,
          ],
          cwd: installation,
          env,
          log: path.join(output, 'install.log'),
        }),
      365000
    );
    assert.equal(await sha(artifact.tarball), artifact.sha256);
    const pkg = await realpath(path.join(installation, 'node_modules/dorkos'));
    assert(pkg.startsWith(installation + path.sep));
    const manifest = await json(path.join(pkg, 'package.json'));
    assert.equal(manifest.name, 'dorkos');
    assert.equal(manifest.version, artifact.version);
    const requireInstalled = createRequire(path.join(pkg, 'package.json'));
    const pw = await realpath(requireInstalled.resolve('playwright-core/package.json'));
    assert(pw.startsWith(installation + path.sep));
    assert.equal((await json(pw)).version, '1.63.0');
    const bin = await realpath(path.join(pkg, 'dist/bin/cli.js'));
    assert(bin.startsWith(pkg + path.sep));
    receipt.installed = {
      pkg,
      bin,
      version: manifest.version,
      playwright: pw,
      playwrightVersion: '1.63.0',
    };
    const port = await reservePort();
    base = 'http://127.0.0.1:' + port;
    env.DORKOS_PORT = String(port);
    const bootstrap = path.join(sandbox, 'owned-native-bootstrap.cjs'),
      attestation = path.join(sandbox, 'bootstrap.json'),
      guardLog = path.join(sandbox, 'discovery.jsonl');
    await writeFile(
      bootstrap,
      makeBootstrapSource({
        fixtureHome: home,
        ownedChromeProfile: profile,
        dataDirectory: data,
        attestation,
        guardLog,
      }),
      { flag: 'wx', mode: 0o600 }
    );
    const cli = launch(
      process.execPath,
      [
        '--require',
        bootstrap,
        bin,
        '--no-open',
        '--no-tasks',
        '--port',
        String(port),
        '--dir',
        cwd,
        '--boundary',
        sandbox,
      ],
      bootstrap
    );
    await own(cli, bootstrap);
    async function api<T = State>(route: string, body?: unknown) {
      admit();
      const response = await fetch(new URL(route, base), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(Math.min(45000, deadline - Date.now())),
      });
      const value = await response.json();
      assert.equal(response.status, 200, route + ': ' + JSON.stringify(value));
      return value as T;
    }
    await poll('Installed capabilities', async () => {
      assert.equal(cli.exitCode, null);
      try {
        return await api<{ playwrightVersion: string }>('/api/local-browser/capabilities');
      } catch {
        return undefined;
      }
    });
    const attest = async () => {
      const record = await json<{
        pid: number;
        execPath: string;
        runtimeHome: string;
        dataDirectory: string;
        homePreserved: boolean;
        codexHomePreserved: boolean;
        guardSelfTests: number;
        argv: string[];
      }>(attestation);
      assert.equal(record.pid, cli.pid);
      assert.equal(record.execPath, process.execPath);
      assert.equal(record.runtimeHome, home);
      assert.equal(record.dataDirectory, data);
      assert.equal(record.homePreserved, true);
      assert.equal(record.codexHomePreserved, true);
      assert.equal(record.guardSelfTests, 3);
      assert(record.argv.includes(bin));
      const listening = await exec(
        'lsof',
        ['-nP', '-a', '-p', String(cli.pid), '-iTCP:' + port, '-sTCP:LISTEN', '-t'],
        { timeout: 2000 }
      );
      assert(listening.stdout.trim().split(/\s+/).includes(String(cli.pid)));
      await owners[0].capture();
      assert.equal(await realpath((await api<{ dorkHome: string }>('/api/config')).dorkHome), data);
      assert.equal(
        (await api<{ playwrightVersion: string }>('/api/local-browser/capabilities'))
          .playwrightVersion,
        '1.63.0'
      );
      receipt.serverAttestation = record;
    };
    await attest(); // Mandatory before reset, config patches, seed or browser open.
    const host = await createChromeHost({
      surface: 'cli',
      root,
      sandbox,
      fixtureHome: home,
      output,
      environment: env,
      deadline,
      attest,
      stage: (label, run) => stage(label, run, Math.max(1, deadline - Date.now())),
      poll: (label, read) => poll(label, read, Math.max(1, deadline - Date.now())),
      registerClose: (close) => {
        closeTasks.push(close);
        if (!active)
          void close().catch((error) => {
            (receipt.lateCloseErrors ??= []).push(String(error));
          });
      },
      record: (name, value) => {
        receipt[name] = value;
      },
    });
    const { fixture, chrome, extensionProbe } = host;
    const before = fixture.beforeAttachUrl,
      during = fixture.duringAttachUrl;
    // This headless browser drives ONLY the installed DorkOS app chat, never native Chrome.
    ui = await stage(
      'Headless app driver',
      () =>
        proofUiDriver.launchPersistentContext(path.join(sandbox, 'ui-profile'), {
          headless: true,
          env,
        }),
      30000
    );
    const ps = (
      await exec('ps', ['-axo', 'pid=,pgid=,command='], {
        timeout: 2000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
    const uiPids = ps.split('\n').flatMap((line) => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return m &&
        m[1] === m[2] &&
        m[3].includes('--user-data-dir=' + path.join(sandbox, 'ui-profile'))
        ? [Number(m[1])]
        : [];
    });
    assert.equal(uiPids.length, 1);
    const uiCleanup = ownedChromeCleanup(uiPids[0], path.join(sandbox, 'ui-profile'));
    owners.push(uiCleanup);
    await uiCleanup.capture();
    timers.push(
      setInterval(() => {
        void uiCleanup.capture().catch(() => undefined);
      }, 500)
    );
    const browser = ui.browser();
    assert(browser);
    context = await browser.newContext({ baseURL: base, recordVideo: { dir: output } });
    const appPage = await context.newPage();
    await appPage.route('**/api/**', async (route: import('playwright-core').Route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin === base && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        try {
          admit();
          await attest();
          admit();
        } catch {
          await route.abort();
          return;
        }
      }
      await route.continue();
    });
    let sessionId = '';
    const evidence = await runInstalledExistingAcceptance({
      stage: (label, run) => stage(label, run, Math.min(300000, deadline - Date.now())),
      attestInstalledServer: attest,
      createScriptedChat: async () => {
        await attest();
        await api('/api/test/reset', {});
        await setupOwnedFirstRunUi(appPage.request, base!, data);
        const seeded = await api<{ agentDir: string }>('/api/test/seed-agent', {});
        assert((await realpath(seeded.agentDir)).startsWith(path.join(sandbox, 'tmp') + path.sep));
        sessionId = randomUUID();
        await api('/api/test/scenario', { name: 'local-browser-driving', sessionId });
        const chat = new ChatPage(appPage);
        await chat.goto(sessionId, { dir: seeded.agentDir, draft: true, runtime: 'test-mode' });
        return {
          sessionId,
          sendAndLand: (text, timeout) => chat.sendAndLand(text, timeout),
          waitForTurnToEnd: (timeout) => chat.waitForTurnToEnd(timeout),
          lastAssistantText: () =>
            appPage
              .locator('[data-testid="message-item"][data-role="assistant"]')
              .last()
              .innerText(),
        };
      },
      post: (route, body) => api(route, body),
      beforeAttachUrl: before,
      duringAttachUrl: during,
      extensionProbe,
      guardProof: async () => {
        const lines = (await readFile(guardLog, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert(lines.every((line) => line.pid === cli.pid));
        return {
          ownedPortReads: lines.filter((line) => line.ownedPortRead).length,
          violations: lines.filter((line) => line.violation).length,
        };
      },
      savedCallbacks: () => fixture.savedCallbacks(),
      waitForSavedCallbacks: (count) =>
        poll('Real fixture Save count ' + count, async () => fixture.callbacksAtCount(count)),
      assertOwnedChromeAndTabAlive: async (selectedId) => {
        assert.equal(chrome.exitCode, null);
        assert.equal(chrome.signalCode, null);
        assert.equal((await api('/api/local-browser/state')).status, 'disconnected');
        receipt.detachedSelectedId = selectedId;
      },
      humanAfterDetachSameTab: async () => {
        assert(receipt.detachedSelectedId);
        await host.humanAfterDetachSameTab(receipt.detachedSelectedId);
      },
      assertAfterDetachCookie: async () => fixture.assertAfterDetachCookie(),
    });
    fixture.assertSameTabWitness('during-attach');
    await appPage.screenshot({ path: path.join(output, 'installed-native-chat.png') });
    receipt.evidence = evidence;
    receipt.extension = fixture.metadata();
    assert.equal(await sha(artifact.tarball), artifact.sha256);
    receipt.status = 'passed-installed-cli-native-chrome';
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    active = false;
    for (const timer of timers) clearInterval(timer);
    const failures: unknown[] = [];
    // No continuation after deadline may begin another operation. Cleanup is independent and bounded.
    try {
      const results = await bounded(
        Promise.allSettled([
          (async () => {
            if (context) await bounded(context.close(), 5000, 'Chat context close');
            if (ui) await bounded(ui.close(), 5000, 'UI owner close');
          })(),
          ...owners.map((owner) => bounded(owner.close(), 60000, 'Owned process physical cleanup')),
          (async () => {
            const errors: string[] = [];
            for (const close of closeTasks.reverse()) {
              try {
                await close();
              } catch (error) {
                errors.push(String(error));
              }
            }
            assert.equal(errors.length, 0, JSON.stringify(errors));
          })(),
        ]),
        60000,
        'CLI normal resource closure'
      );
      for (const result of results)
        if (result.status === 'rejected') failures.push(String(result.reason));
    } catch (error) {
      failures.push(String(error));
    }
    for (const log of logs)
      await bounded(new Promise<void>((r) => log.end(r)), 1000, 'Log closure').catch((error) =>
        failures.push(String(error))
      );
    if (failures.length) {
      receipt.status = 'failed';
      receipt.cleanupErrors = failures;
      process.exitCode = 1;
    }
    try {
      await bounded(
        (async () => {
          assert.equal(await sha(receiptPath), artifactReceiptHash);
          assert.equal(await sha(artifact.tarball), artifact.sha256);
          // eslint-disable-next-line no-restricted-syntax -- Standalone proof records final source custody without app startup.
          const proofEnvironment = process.env;
          assert.equal(
            (
              await bounded(
                captureProofSource(root, proofEnvironment),
                15000,
                'Final CLI source custody'
              )
            ).fingerprint,
            artifact.sourceFingerprint
          );
        })(),
        15000,
        'Complete final CLI custody'
      );
    } catch (error) {
      receipt.status = 'failed';
      receipt.custodyError = String(error);
      process.exitCode = 1;
    }
    receipt.sandboxRetained = true;
    receipt.finishedAt = new Date().toISOString();
    await writeFile(
      path.join(output, 'worker-receipt.json'),
      JSON.stringify(receipt, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  }
}
