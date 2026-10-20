/** Isolated packaged desktop browser proof. Invoke only in an explicitly granted native lane. */
import assert from 'node:assert/strict';
import type { LocalBrowserState as BrowserState } from '../../packages/shared/src/local-browser.js';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ElectronApplication,
  Page,
} from '../../apps/desktop/node_modules/playwright-core/index.js';
import type { ProcessMetric, WebContents } from 'electron';
import { LocalBrowserPage } from '../../apps/e2e/pages/LocalBrowserPage.js';
import { proofUiExpect as expect } from '../../apps/e2e/pages/local-browser-installed-proof.js';
import {
  digest,
  inside,
  unusedPort,
  sharedLanePath,
  prepareDesktopEnvironment,
  preparePackagedPreflight,
  createBrowserFixture,
  type CandidateIdentity,
} from './desktop-proof-support.js';
import {
  launchCandidate,
  nativePresentation,
  captureFailureEvidence,
} from './desktop-proof-renderer.js';

const exec = promisify(execFile);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const root = process.cwd();
const candidate = path.resolve(root, 'apps/desktop/release/mac-arm64/DorkOS.app');

async function run(): Promise<void> {
  assert.equal(process.platform, 'darwin', 'This candidate proof covers macOS only');
  const lane = JSON.parse(await readFile(await sharedLanePath(), 'utf8')) as {
    scope: string;
    root: string;
  };
  assert(
    lane.scope.includes('desktop-proof') && lane.root === root,
    'Use run-in-lane.py after root grants the native window'
  );
  const actualCandidate = await realpath(candidate);
  assert.equal(
    actualCandidate,
    candidate,
    'Use the exact worktree candidate, not an installed app or symlink'
  );
  const output = path.join(root, '.dork/local-browser/desktop-proof', String(Date.now()));
  await mkdir(output, { recursive: true, mode: 0o700 });
  const sandbox = await realpath(
    await mkdtemp(path.join(tmpdir(), 'dorkos-packaged-browser-proof-'))
  );
  const fixtureHome = path.join(sandbox, 'home');
  const userData = path.join(fixtureHome, 'Library/Application Support/DorkOS');
  const cwd = path.join(fixtureHome, 'work');
  const browserCache = path.join(sandbox, 'browser-cache');
  const dorkData = path.join(fixtureHome, '.dork');
  for (const directory of [fixtureHome, userData, cwd, browserCache, dorkData])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  const executable = path.join(candidate, 'Contents/MacOS/DorkOS');
  const resources = path.join(candidate, 'Contents/Resources');
  const appArchive = path.join(resources, 'app.asar');
  const receipt: Record<string, unknown> = {
    status: 'running',
    startedAt: new Date().toISOString(),
    candidate,
    output,
    sandbox,
    paidInference: false,
    personalAppTouched: false,
    personalBrowserTouched: false,
    checks: {},
  };
  const checks = receipt.checks as Record<string, unknown>;
  const log = createWriteStream(path.join(output, 'candidate.log'));
  let application: ElectronApplication | undefined;
  let activeRenderer: Page | undefined;
  let preflight: ElectronApplication | undefined;
  let activeIdentity: CandidateIdentity | undefined;
  const identities: CandidateIdentity[] = [];
  const trackedPids = new Set<number>();
  const port = await unusedPort();
  const fixturePort = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
  const { fixture, versionProbeUrl, versionRequests, requestCount } =
    createBrowserFixture(fixtureUrl);
  const { environment, firstRunPromptSeed } = await prepareDesktopEnvironment({
    sandbox,
    fixtureHome,
    browserCache,
    cwd,
    dorkData,
    port,
  });
  checks.firstRunPromptPrelaunchSeed = firstRunPromptSeed;
  const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
  const playwright = desktopRequire(
    'playwright-core'
  ) as typeof import('../../apps/desktop/node_modules/playwright-core/index.js');
  assert.equal(
    (desktopRequire('playwright-core/package.json') as { version: string }).version,
    '1.63.0'
  );
  const devElectron = desktopRequire('electron') as string;
  const expectedElectron = (desktopRequire('electron/package.json') as { version: string }).version;

  async function api<T = Record<string, unknown>>(route: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(route, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(210_000),
    });
    const result = (await response.json()) as T;
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(result)}`);
    return result;
  }
  async function title(expected: string): Promise<BrowserState> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await api<BrowserState>('/api/local-browser/state');
      if (state.tabs.some((tab) => tab.title === expected)) return state;
      await delay(100);
    }
    throw new Error(`The packaged live page did not show ${expected}`);
  }
  async function candidateIdentity(app: ElectronApplication): Promise<CandidateIdentity> {
    return app.evaluate(({ app }) => ({
      home: app.getPath('home'),
      userData: app.getPath('userData'),
      logs: app.getPath('logs'),
      appPath: app.getAppPath(),
      packaged: app.isPackaged,
      electron: process.versions.electron!,
      pid: process.pid,
    }));
  }
  async function assertPortClosed(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await fetch(new URL('/api/health', base), { signal: AbortSignal.timeout(500) });
      } catch {
        return;
      }
      await delay(200);
    }
    throw new Error('Owned packaged server port still answers after candidate quit');
  }
  async function rememberOwnedProcesses(): Promise<void> {
    if (application) {
      const metrics = await application.evaluate(({ app }) =>
        app.getAppMetrics().map((metric: ProcessMetric) => metric.pid)
      );
      for (const pid of metrics) trackedPids.add(pid);
    }
    for (const identity of identities) trackedPids.add(identity.pid);
    const rows = (await exec('ps', ['-axo', 'pid=,ppid=,command='])).stdout
      .split('\n')
      .map((line) => {
        const parsed = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return parsed ? { pid: Number(parsed[1]), parent: Number(parsed[2]) } : undefined;
      })
      .filter((row): row is { pid: number; parent: number } => Boolean(row));
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows)
        if (trackedPids.has(row.parent) && !trackedPids.has(row.pid)) {
          trackedPids.add(row.pid);
          changed = true;
        }
    }
  }
  async function quitCandidate(): Promise<void> {
    if (!application) return;
    // _electron is test-only. Normal app.close/app.quit exercises production parent/guest teardown.
    const candidateApp = application;
    await rememberOwnedProcesses();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        candidateApp.close(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Packaged app did not quit within its closure budget')),
            35_000
          );
        }),
      ]);
      await assertPortClosed();
      application = undefined;
    } finally {
      clearTimeout(timer);
    }
    activeIdentity = undefined;
    activeRenderer = undefined;
  }
  const launch = (suffix: string, installerOffline = false) =>
    launchCandidate(
      {
        playwright,
        executable,
        userData,
        cwd,
        environment,
        log,
        candidateIdentity,
        fixtureHome,
        appArchive,
        expectedElectron,
        dorkData,
        api,
        resources,
        checks,
        port,
        base,
        firstRunPromptSeed,
        output,
        onApplication: (app) => {
          application = app;
        },
        onIdentity: (identity) => {
          activeIdentity = identity;
          identities.push(identity);
        },
        onRenderer: (renderer) => {
          activeRenderer = renderer;
        },
      },
      suffix,
      installerOffline
    );
  const presentation = (capture = false) => nativePresentation(application!, fixtureUrl, capture);
  async function waitNativeVisible(shown: boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const views = await presentation();
      if (
        shown
          ? views.length === 1 &&
            views[0].visible &&
            views[0].bounds.width > 100 &&
            views[0].bounds.height > 100
          : views.every((view) => !view.visible)
      )
        return views;
      await delay(100);
    }
    throw new Error(`The native Browser panel did not become ${shown ? 'visible' : 'hidden'}`);
  }

  try {
    const probe = await preparePackagedPreflight({
      desktopRequire,
      appArchive,
      executable,
      resources,
      receipt,
      checks,
      browserCache,
      candidate,
      expectedElectron,
      sandbox,
    });
    preflight = await playwright._electron.launch({
      executablePath: devElectron,
      args: [probe],
      env: environment,
      cwd,
      timeout: 20_000,
    });
    const isolated = await candidateIdentity(preflight);
    assert.equal(await realpath(isolated.home), fixtureHome);
    assert(inside(await realpath(isolated.userData), fixtureHome));
    assert.equal(isolated.electron, expectedElectron);
    await preflight.close();
    preflight = undefined;
    checks.coreFoundationPreflight = isolated;
    await new Promise<void>((resolve) => fixture.listen(fixturePort, '127.0.0.1', resolve));
    const renderer = await launch('first');
    const browserUi = new LocalBrowserPage(renderer);
    await browserUi.controls.getByRole('button', { name: 'Open browser', exact: true }).click();
    await expect(
      browserUi.controls.getByRole('button', { name: 'Pause agent', exact: true })
    ).toBeVisible({ timeout: 20_000 });
    await browserUi.navigate(`${fixtureUrl}/seed`);
    const embedded = await title('Packaged browser fixture');
    const guests = await application!.evaluate(
      ({ webContents }, prefix) =>
        webContents
          .getAllWebContents()
          .filter((contents: WebContents) => contents.getURL().startsWith(prefix))
          .map((contents: WebContents) => ({
            id: contents.id,
            url: contents.getURL(),
            title: contents.getTitle(),
            type: contents.getType(),
          })),
      fixtureUrl
    );
    assert.equal(guests.length, 1);
    assert.equal(guests[0].title, 'Packaged browser fixture');
    checks.exactEmbeddedGuest = { state: embedded, guests };
    const shown = await waitNativeVisible(true);
    assert.equal(shown[0].id, guests[0].id);
    assert(shown[0].bounds.x >= 0 && shown[0].bounds.y >= 0);
    assert(shown[0].bounds.x + shown[0].bounds.width <= shown[0].hostBounds.width + 1);
    assert(shown[0].bounds.y + shown[0].bounds.height <= shown[0].hostBounds.height + 1);
    await renderer.getByRole('button', { name: 'Close right panel', exact: true }).click();
    await waitNativeVisible(false);
    const hiddenState = await api<BrowserState>('/api/local-browser/state');
    assert.equal(hiddenState.connectionId, embedded.connectionId);
    assert.equal(hiddenState.status, 'connected');
    await browserUi.open();
    const reshown = await waitNativeVisible(true);
    assert.equal(reshown[0].id, guests[0].id);
    assert.equal(
      (await api<BrowserState>('/api/local-browser/state')).connectionId,
      embedded.connectionId
    );
    const captured = (await presentation(true))[0];
    assert(captured.png && captured.pixels);
    assert(
      captured.pixels.width > 100 &&
        captured.pixels.height > 100 &&
        captured.pixels.variedPixels > 100
    );
    const nativePng = path.join(output, 'native-browser-panel-first.png');
    await writeFile(nativePng, Buffer.from(captured.png, 'base64'));
    const rendererPng = path.join(output, 'renderer-browser-panel-first.png');
    await renderer.screenshot({ path: rendererPng });
    checks.embeddedPanelPresentation = {
      visible: captured.visible,
      bounds: captured.bounds,
      hostBounds: captured.hostBounds,
      pixels: captured.pixels,
      nativePng,
      rendererPng,
      sameConnectionAfterPanelReopen: embedded.connectionId,
      sameNativeGuestIdAfterPanelReopen: captured.id,
    };

    await api('/api/local-browser/pause', {});
    await api('/api/local-browser/navigate', { url: `${fixtureUrl}/resume` });
    await title('Saved fixture sign-in');
    await api('/api/local-browser/resume', {});
    await api('/api/local-browser/disconnect', {});
    const openedWindow = await api<BrowserState>('/api/local-browser/open', {
      mode: 'new-window',
      url: versionProbeUrl,
    });
    assert.equal(openedWindow.mode, 'new-window');
    assert.equal(
      openedWindow.tabs.find((tab) => tab.id === openedWindow.selectedTabId)?.url,
      versionProbeUrl
    );
    const freshWindow = await title('Packaged browser fixture');
    assert.equal(freshWindow.mode, 'new-window');
    assert.equal(
      freshWindow.tabs.find((tab) => tab.id === freshWindow.selectedTabId)?.url,
      versionProbeUrl
    );
    const versionRequest = versionRequests[0];
    assert(versionRequest, 'The new managed window did not request its unique version probe');
    const actualVersion = /\bChrome\/(153\.\d+\.\d+\.\d+)\b/.exec(versionRequest.userAgent)?.[1];
    assert(actualVersion, `Expected actual Chrome/153 request: ${versionRequest.userAgent}`);
    assert(
      (await readdir(browserCache)).length > 0,
      'Managed browser acquisition produced no executable/cache'
    );
    checks.automaticAcquisition = {
      freshCache: browserCache,
      versionProbeUrl,
      versionRequest,
      browserVersion: actualVersion,
    };
    await api('/api/local-browser/disconnect', {});
    await api<BrowserState>('/api/local-browser/open', {
      mode: 'embedded',
      url: `${fixtureUrl}/resume`,
    });
    await title('Saved fixture sign-in');
    await quitCandidate();
    checks.firstParentQuit = { serverPortClosed: true, fixtureRequests: requestCount() };
    await launch('reopened', true);
    await api<BrowserState>('/api/local-browser/open', {
      mode: 'embedded',
      url: `${fixtureUrl}/resume`,
    });
    await title('Saved fixture sign-in');
    await api('/api/local-browser/disconnect', {});
    await api<BrowserState>('/api/local-browser/open', {
      mode: 'new-window',
      url: `${fixtureUrl}/resume`,
    });
    await title('Saved fixture sign-in');
    checks.persistentReopen = {
      embedded: true,
      newWindow: true,
      cachedInstallerProxyUnavailable: true,
      fixtureRequests: requestCount(),
    };
    await api('/api/local-browser/disconnect', {});
    await api<BrowserState>('/api/local-browser/open', {
      mode: 'embedded',
      url: `${fixtureUrl}/resume`,
    });
    await title('Saved fixture sign-in');
    await quitCandidate();
    assert.equal(
      await digest(appArchive),
      (receipt.candidateDigest as { appArchive: string }).appArchive,
      'The candidate changed during browser proof'
    );
    receipt.status = 'passed-bounded-packaged-desktop-proof';
    receipt.remainingProofGaps = [
      'Windows desktop remains alpha; no Windows/Linux package proof here.',
      'Production page-only agent commands and reload/swap fixtures are recorded separately.',
    ];
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
    await captureFailureEvidence(activeRenderer, output, checks).catch((captureError: unknown) => {
      checks.failureEvidenceError = String(captureError);
    });
  } finally {
    await preflight?.close().catch(() => undefined);
    await quitCandidate().catch((error) => {
      receipt.quitError = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    });
    const processList = (await exec('ps', ['-axo', 'pid=,ppid=,command='])).stdout;
    const ownedPids = trackedPids;
    const remaining = processList.split('\n').filter((line) => {
      const pid = Number(line.trim().split(/\s+/, 1)[0]);
      return ownedPids.has(pid) || line.includes(sandbox);
    });
    checks.physicalClosure = {
      identities,
      observedOwnedPids: [...trackedPids],
      remainingOwnedProcesses: remaining,
      activeIdentity: activeIdentity ?? null,
    };
    if (remaining.length) {
      receipt.status = 'failed';
      receipt.cleanupError =
        'Owned candidate/fixture processes remain; preserve sandbox for root inspection';
      process.exitCode = 1;
    }
    if (fixture.listening) await new Promise<void>((resolve) => fixture.close(() => resolve()));
    if (!remaining.length && receipt.status === 'passed-bounded-packaged-desktop-proof') {
      await rm(sandbox, { recursive: true, force: true });
      checks.temporaryDataRemoved = true;
    }
    receipt.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    await new Promise<void>((resolve) => log.end(resolve));
    console.log(
      JSON.stringify({
        output,
        status: receipt.status,
        checks: Object.keys(checks),
        error: receipt.error,
        remainingProofGaps: receipt.remainingProofGaps,
      })
    );
  }
}

// Syntax/lint preparation must not acquire a lane or launch any app.
if (process.argv.includes('--execute')) await run();
else
  console.log(
    'Prepared packaged desktop browser proof. Native execution requires root authorization and the exclusive desktop-proof lane.'
  );
