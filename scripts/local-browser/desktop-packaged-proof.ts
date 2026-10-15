/* eslint-disable max-lines -- Verification-only native custody stays in one file so every launch shares the same physical-closure finally block. */
/** Isolated packaged desktop browser proof. Invoke only in an explicitly granted native lane. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ElectronApplication,
  Page,
} from '../../apps/desktop/node_modules/playwright-core/index.js';
import type {
  NativeImage,
  ProcessMetric,
  View,
  WebContents,
  WebContentsView as NativeBrowserView,
} from 'electron';
import { LocalBrowserPage } from '../../apps/e2e/pages/LocalBrowserPage.js';
import {
  assertOwnedBrowserProofHome,
  setupOwnedFirstRunUi,
  proofUiExpect as expect,
} from '../../apps/e2e/pages/local-browser-installed-proof.js';
import { LOGIN_SHELL_PATH_MARKER } from '../../apps/desktop/src/shared/login-shell-path.js';

const exec = promisify(execFile);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const root = process.cwd();
const candidate = path.resolve(root, 'apps/desktop/release/mac-arm64/DorkOS.app');

interface BrowserState {
  connectionId: string | null;
  mode: string;
  status: string;
  paused: boolean;
  browserVersion: string | null;
  selectedTabId: string | null;
  tabs: { id: string; url: string; title: string }[];
}
interface CandidateIdentity {
  home: string;
  userData: string;
  logs: string;
  appPath: string;
  packaged: boolean;
  electron: string;
  pid: number;
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function inside(file: string, directory: string): boolean {
  return file === directory || file.startsWith(directory + path.sep);
}
/** Resolve existing ancestors too, since Electron may report a not-yet-created log folder. */
async function canonicalPath(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
    return path.join(await canonicalPath(path.dirname(file)), path.basename(file));
  }
}
const reservedPorts = new Set<number>();
async function unusedPort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = 6000 + Math.floor(Math.random() * 1000);
    if (reservedPorts.has(value)) continue;
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(value, '127.0.0.1', resolve);
      });
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      reservedPorts.add(value);
      return value;
    } catch {
      /* Try another proof-owned port. */
    }
  }
  throw new Error('No available 6xxx proof port');
}

async function sharedLanePath(): Promise<string> {
  // Verification can share an operator-provided lane; otherwise use the original clone's workspace.
  // eslint-disable-next-line no-restricted-syntax
  const override = process.env.LOCAL_BROWSER_LANE_FILE;
  if (override) return path.resolve(override);
  const common = (
    await exec('git', ['rev-parse', '--git-common-dir'], { cwd: root })
  ).stdout.trim();
  return path.join(
    path.dirname(path.dirname(path.resolve(root, common))),
    '.workspace/shared-local-heavy-producer.lock'
  );
}

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
  const shippedLibrary = path.join(resources, 'app.asar.unpacked/node_modules/playwright-core');
  const shippedInstaller = path.join(shippedLibrary, 'cli.js');
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
  let fixtureRequests = 0;
  const fixture = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url?.startsWith('/seed'))
      response.setHeader(
        'Set-Cookie',
        'dorkos_desktop_proof=owned; Max-Age=3600; Path=/; SameSite=Lax'
      );
    const persisted = request.headers.cookie?.includes('dorkos_desktop_proof=owned') ?? false;
    if (request.url?.startsWith('/resume') && persisted) fixtureRequests++;
    const title =
      request.url?.startsWith('/resume') && persisted
        ? 'Saved fixture sign-in'
        : 'Packaged browser fixture';
    response.end(
      `<title>${title}</title><h1>${title}</h1><label>Name<input aria-label="Name"></label>`
    );
  });
  const fakeShell = path.join(sandbox, 'fixture-login-shell');
  await writeFile(
    fakeShell,
    `#!/bin/sh\nprintf %s '${LOGIN_SHELL_PATH_MARKER}'; /usr/bin/env; printf %s '${LOGIN_SHELL_PATH_MARKER}'\n`
  );
  await chmod(fakeShell, 0o700);
  // Preserve original HOME/CODEX_HOME values; CoreFoundation is isolated by its own supported knob.
  // Model credentials, paid arms, debug hooks and pre-existing desktop secrets never enter this child.
  const inherited = Object.fromEntries(
    // eslint-disable-next-line no-restricted-syntax
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith('DORKOS_') &&
        !name.startsWith('DORK_') &&
        !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALED|PAID|HARNESS_SMOKE|COMMUNITY_LIVE)/.test(
          name
        ) &&
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
        ].includes(name)
    )
  );
  const environment: Record<string, string> = {
    ...(inherited as Record<string, string>),
    CFFIXED_USER_HOME: fixtureHome,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SHELL: fakeShell,
    PLAYWRIGHT_BROWSERS_PATH: browserCache,
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
  };
  const promptSeedTimestamp = new Date().toISOString();
  const firstRunPromptSeed = {
    onboarding: { dismissedAt: promptSeedTimestamp },
    profile: {
      rolePromptDismissedAt: promptSeedTimestamp,
      identityPromptDismissedAt: promptSeedTimestamp,
    },
    telemetry: { userHasDecided: true },
    ui: { trustNoticeSeenAt: promptSeedTimestamp },
  };
  await writeFile(
    path.join(dorkData, 'config.json'),
    JSON.stringify(
      {
        version: 1,
        server: { port, cwd, boundary: fixtureHome },
        scheduler: { enabled: false },
        heartbeats: { enabled: false, triageOnCredits: false },
        auth: { enabled: false },
        ...firstRunPromptSeed,
      },
      null,
      2
    )
  );
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
  async function captureFailureEvidence(): Promise<void> {
    if (!application || !activeRenderer || activeRenderer.isClosed()) return;
    const renderer = activeRenderer;
    const screenshot = path.join(output, 'failure-renderer.png');
    const evidence: Record<string, unknown> = { url: renderer.url(), capturedBeforeQuit: true };
    checks.failureEvidence = evidence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const results = await Promise.race([
        Promise.allSettled([
          renderer.screenshot({ path: screenshot, timeout: 2_000 }),
          renderer.locator('body').innerText({ timeout: 1_000 }),
        ]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Failure evidence exceeded three seconds')),
            3_000
          );
          timer.unref();
        }),
      ]);
      evidence.screenshot = results[0].status === 'fulfilled' ? screenshot : null;
      evidence.screenshotError =
        results[0].status === 'rejected' ? String(results[0].reason) : null;
      evidence.bodyText =
        results[1].status === 'fulfilled' ? results[1].value.toString().slice(0, 8_192) : null;
      evidence.bodyTextError = results[1].status === 'rejected' ? String(results[1].reason) : null;
    } catch (error) {
      evidence.captureError = String(error);
    } finally {
      clearTimeout(timer);
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
  async function launch(suffix: string, installerOffline = false): Promise<Page> {
    const launchedAt = Date.now();
    application = await playwright._electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${userData}`],
      cwd,
      env: {
        ...environment,
        ...(installerOffline
          ? {
              HTTP_PROXY: 'http://127.0.0.1:1',
              HTTPS_PROXY: 'http://127.0.0.1:1',
              ALL_PROXY: 'http://127.0.0.1:1',
              NO_PROXY: '127.0.0.1,localhost',
            }
          : {}),
      },
      timeout: 90_000,
    });
    application.process().stdout?.pipe(log, { end: false });
    application.process().stderr?.pipe(log, { end: false });
    const identity = await candidateIdentity(application);
    activeIdentity = identity;
    identities.push(identity);
    assert.equal(
      await realpath(identity.home),
      fixtureHome,
      'Candidate CoreFoundation home escaped isolation'
    );
    assert.equal(
      await realpath(identity.userData),
      userData,
      'Candidate userData escaped isolation'
    );
    assert(
      inside(await canonicalPath(identity.logs), fixtureHome),
      'Candidate logs escaped isolation'
    );
    assert.equal(identity.packaged, true);
    assert.equal(identity.appPath, appArchive);
    assert.equal(identity.electron, expectedElectron);
    // Avoid update downloads/install-on-quit in this browser-only test of the owned candidate.
    await application.evaluate(({ app }) => {
      const candidateRequire = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json');
      const { autoUpdater } = candidateRequire('electron-updater');
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.checkForUpdatesAndNotify = async () => null;
    });
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        const health = await api<{ status: string }>('/api/health');
        if (health.status === 'ok') break;
      } catch {
        /* Await the owned child's boot. */
      }
      if (attempt === 299) throw new Error('Owned packaged server never became ready');
      await delay(200);
    }
    await access(path.join(dorkData, 'dork.db'));
    const capabilities = await api<{
      embedded: boolean;
      defaultMode: string;
      playwrightVersion: string;
    }>('/api/local-browser/capabilities');
    assert.equal(capabilities.embedded, true);
    assert.equal(capabilities.defaultMode, 'embedded');
    assert.equal(capabilities.playwrightVersion, '1.63.0');
    const runtimeLibrary = await application.evaluate(({ app }) => {
      const candidateRequire = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json');
      return {
        version: candidateRequire('playwright-core/package.json').version,
        packagePath: candidateRequire.resolve('playwright-core/package.json'),
      };
    });
    assert.equal(runtimeLibrary.version, '1.63.0');
    assert(
      inside(runtimeLibrary.packagePath, resources),
      'Candidate resolved Playwright outside its own package'
    );
    checks[`runtimeLibrary-${suffix}`] = runtimeLibrary;
    checks[`candidate-${suffix}`] = { identity, capabilities };
    const renderer = await application.firstWindow();
    activeRenderer = renderer;
    const rendererErrors: string[] = [];
    renderer.on('pageerror', (error) => rendererErrors.push(error.message));
    checks[`rendererErrors-${suffix}`] = rendererErrors;
    await renderer.waitForLoadState('domcontentloaded');
    const normalRendererUrl = new URL(renderer.url());
    assert.equal(normalRendererUrl.protocol, 'http:');
    assert.equal(
      normalRendererUrl.hostname,
      'localhost',
      'Preserve the normal packaged renderer host'
    );
    assert.equal(normalRendererUrl.port, String(port));
    checks[`rendererOrigin-${suffix}`] = {
      rendererUrl: normalRendererUrl.href,
      navigationOrigin: normalRendererUrl.origin,
      fixtureApiOrigin: base,
    };
    // The preload heartbeat can precede React's first rendered controls.
    await renderer.locator('button:visible').first().waitFor({ state: 'visible', timeout: 20_000 });
    await assertOwnedBrowserProofHome(renderer.request, base, dorkData);
    assert(
      (await renderer.request.post(new URL('/api/test/reset', base).href)).ok(),
      'Owned candidate must expose its test-mode reset before fixture setup'
    );
    checks[`firstRunUi-${suffix}`] = await setupOwnedFirstRunUi(renderer.request, base, dorkData);
    const { config: promptConfig } = await assertOwnedBrowserProofHome(
      renderer.request,
      base,
      dorkData
    );
    const promptReadback = {
      onboarding: { dismissedAt: promptConfig.onboarding?.dismissedAt },
      profile: {
        rolePromptDismissedAt: promptConfig.profile?.rolePromptDismissedAt,
        identityPromptDismissedAt: promptConfig.profile?.identityPromptDismissedAt,
      },
      telemetry: { userHasDecided: promptConfig.telemetry?.userHasDecided },
      ui: { trustNoticeSeenAt: promptConfig.ui?.trustNoticeSeenAt },
    };
    assert.deepEqual(promptReadback, firstRunPromptSeed);
    checks[`firstRunPromptReadback-${suffix}`] = promptReadback;
    const seededResponse = await renderer.request.post(new URL('/api/test/seed-agent', base).href, {
      data: {},
      timeout: 10_000,
    });
    assert(seededResponse.ok(), 'Owned test-mode agent seed must succeed');
    const seeded = (await seededResponse.json()) as { agentDir: string };
    assert.equal(typeof seeded.agentDir, 'string');
    const agentDir = await realpath(seeded.agentDir);
    assert(
      inside(agentDir, path.join(fixtureHome, 'tmp')),
      'Seeded agent escaped the owned home boundary'
    );
    const locationResponse = await renderer.request.post(
      new URL('/api/session-locations', base).href,
      {
        data: { cwd: agentDir },
        timeout: 10_000,
      }
    );
    assert(locationResponse.ok(), 'Owned draft location reservation must succeed');
    const location = (await locationResponse.json()) as { id: string };
    assert(typeof location.id === 'string' && location.id.length > 0);
    const sessionId = randomUUID();
    // The preload transport targets localhost; changing the page host makes its API requests cross-site.
    const sessionUrl = new URL('/session', normalRendererUrl.origin);
    assert.equal(sessionUrl.protocol, 'http:');
    assert.equal(sessionUrl.origin, normalRendererUrl.origin);
    assert.equal(sessionUrl.hostname, 'localhost');
    assert.equal(sessionUrl.port, String(port));
    sessionUrl.search = new URLSearchParams({
      session: sessionId,
      draft: '1',
      launchRef: location.id,
      runtime: 'test-mode',
    }).toString();
    await renderer.goto(sessionUrl.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    // Match ChatPage's shell/chat barriers before the panel's short idempotent toggle read.
    await expect(renderer.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });
    await expect(renderer.getByTestId('chat-panel')).toBeVisible({ timeout: 10_000 });
    await expect(renderer.getByRole('button', { name: /right panel/i })).toBeVisible({
      timeout: 10_000,
    });
    const finalUrl = new URL(renderer.url());
    assert.equal(finalUrl.origin, sessionUrl.origin);
    assert.equal(finalUrl.pathname, '/session');
    assert.equal(finalUrl.searchParams.get('session'), sessionId);
    const rawDraft = finalUrl.searchParams.get('draft');
    // The app search parser preserves numeric-looking strings quoted; its draft schema accepts both.
    assert(
      rawDraft === '1' || rawDraft === JSON.stringify('1'),
      'The final route must remain a draft'
    );
    assert.equal(finalUrl.searchParams.get('launchRef'), location.id);
    assert.equal(finalUrl.searchParams.get('runtime'), 'test-mode');
    checks[`draftRoute-${suffix}`] = {
      agentDir,
      sessionId,
      launchRef: location.id,
      normalRendererOrigin: normalRendererUrl.origin,
      rawDraft,
      semanticDraft: '1',
      requestedUrl: sessionUrl.href,
      finalUrl: finalUrl.href,
      shellReady: true,
      chatReady: true,
      panelToggleReady: true,
    };
    const controls = new LocalBrowserPage(renderer);
    await controls.open();
    await expect(controls.controls.getByRole('radio')).toHaveCount(3);
    const embeddedChoice = controls.controls.getByRole('radio', { name: /^DorkOS browser/ });
    await expect(embeddedChoice).toBeChecked();
    await expect(embeddedChoice).toBeEnabled();
    checks[`browserChoices-${suffix}`] = {
      count: 3,
      embeddedDefault: true,
      embeddedEnabled: true,
      url: sessionUrl.href,
    };

    // Fixed fixture code stays a string so tsx keepNames cannot inject Node-only helpers.
    const frameTicks = await renderer.evaluate<number>(
      'new Promise(resolve => { let ticks = 0; function tick() { if (++ticks === 6) resolve(ticks); else requestAnimationFrame(tick); } requestAnimationFrame(tick); })'
    );
    assert.equal(frameTicks, 6);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const health = JSON.parse(
          await readFile(path.join(userData, 'renderer-health.json'), 'utf8')
        ) as { consecutiveFailures: number; updatedAt: string };
        if (health.consecutiveFailures === 0 && Date.parse(health.updatedAt) >= launchedAt) {
          checks[`rendererHeartbeat-${suffix}`] = health;
          break;
        }
      } catch {
        /* Wait for the real renderer's own heartbeat record. */
      }
      if (attempt === 99)
        throw new Error('The real renderer never recorded a fresh healthy heartbeat');
      await delay(200);
    }
    const screenshot = path.join(output, `renderer-${suffix}.png`);
    await renderer.screenshot({ path: screenshot });
    const pixels = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window.webContents.capturePage().then((image: NativeImage) => {
        const bitmap = image.toBitmap();
        let changedPixels = 0;
        for (let i = 4; i < bitmap.length; i += 4)
          if (bitmap[i] !== bitmap[0] || bitmap[i + 1] !== bitmap[1] || bitmap[i + 2] !== bitmap[2])
            changedPixels++;
        return { width: image.getSize().width, height: image.getSize().height, changedPixels };
      });
    });
    assert(pixels.width > 100 && pixels.height > 100);
    assert(pixels.changedPixels > 100, 'Renderer capture is blank or one solid color');
    checks[`rendererPixels-${suffix}`] = {
      width: pixels.width,
      height: pixels.height,
      changedPixels: pixels.changedPixels,
      screenshot,
      frameTicks,
    };
    return renderer;
  }

  async function nativePresentation(capture = false) {
    return application!.evaluate(
      async ({ BrowserWindow, WebContentsView }, options) => {
        const found = [];
        for (const window of BrowserWindow.getAllWindows()) {
          const pending = window.contentView.children.map((view: View) => ({
            view,
            parentVisible: window.isVisible(),
          }));
          while (pending.length) {
            const { view, parentVisible } = pending.pop()!;
            const visible = parentVisible && view.getVisible();
            pending.push(
              ...view.children.map((child: View) => ({ view: child, parentVisible: visible }))
            );
            if (
              !(view instanceof (WebContentsView as typeof NativeBrowserView)) ||
              !view.webContents.getURL().startsWith(options.prefix)
            )
              continue;
            const bounds = view.getBounds();
            const hostBounds = window.getContentBounds();
            let png: string | undefined;
            let pixels: { width: number; height: number; variedPixels: number } | undefined;
            if (options.capture) {
              const image = await view.webContents.capturePage();
              const bitmap = image.toBitmap();
              let variedPixels = 0;
              for (let i = 4; i < bitmap.length; i += 4)
                if (
                  bitmap[i] !== bitmap[0] ||
                  bitmap[i + 1] !== bitmap[1] ||
                  bitmap[i + 2] !== bitmap[2]
                )
                  variedPixels++;
              pixels = { ...image.getSize(), variedPixels };
              png = image.toPNG().toString('base64');
            }
            found.push({
              id: view.webContents.id,
              url: view.webContents.getURL(),
              visible,
              bounds,
              hostBounds,
              png,
              pixels,
            });
          }
        }
        return found;
      },
      { prefix: fixtureUrl, capture }
    );
  }
  async function waitNativeVisible(shown: boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const views = await nativePresentation();
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
    await access(executable);
    await access(appArchive);
    // A writer changing a packed file between stat and streaming shifts later ASAR offsets.
    // Verify every packed payload before launching a candidate built from a mutable checkout.
    const builderRequire = createRequire(desktopRequire.resolve('electron-builder'));
    const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
    const archive = appBuilderRequire('@electron/asar') as {
      listPackage(file: string): string[];
      statFile(
        file: string,
        entry: string,
        followLinks: boolean
      ): {
        offset?: string;
        integrity?: { algorithm: string; hash: string };
      };
      extractFile(file: string, entry: string): Buffer;
    };
    let packedFiles = 0;
    for (const name of archive.listPackage(appArchive)) {
      const entry = name.replace(/^\//, '');
      const metadata = archive.statFile(appArchive, entry, false);
      if (metadata.offset === undefined) continue;
      assert.equal(metadata.integrity?.algorithm, 'SHA256');
      assert.equal(
        createHash('sha256').update(archive.extractFile(appArchive, entry)).digest('hex'),
        metadata.integrity.hash,
        `Candidate archive payload changed: ${entry}`
      );
      packedFiles++;
    }
    const packagedManifest = JSON.parse(
      archive.extractFile(appArchive, 'package.json').toString('utf8')
    ) as { main: string };
    assert.equal(packagedManifest.main, 'dist/main/index.js');
    checks.archiveIntegrity = { packedFiles, allPayloadHashesValid: true };
    await access(shippedInstaller);
    const shipped = JSON.parse(
      await readFile(path.join(shippedLibrary, 'package.json'), 'utf8')
    ) as { version: string };
    assert.equal(shipped.version, '1.63.0');
    const descriptor = JSON.parse(
      await readFile(path.join(shippedLibrary, 'browsers.json'), 'utf8')
    ) as { browsers: { name: string; revision: string; browserVersion: string }[] };
    const chromium = descriptor.browsers.find((browser) => browser.name === 'chromium');
    assert(chromium?.browserVersion.startsWith('153.'));
    const installer = await realpath(shippedInstaller);
    assert(inside(installer, path.join(resources, 'app.asar.unpacked')));
    receipt.sourceSHA = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    receipt.dirtyFiles = (await exec('git', ['status', '--short'], { cwd: root })).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    receipt.candidateDigest = {
      appArchive: await digest(appArchive),
      executable: await digest(executable),
    };
    checks.shippedLibrary = {
      version: shipped.version,
      descriptor: chromium,
      installer,
      installerDigest: await digest(installer),
    };
    assert.equal((await readdir(browserCache)).length, 0);
    const frameworkPlist = path.join(
      candidate,
      'Contents/Frameworks/Electron Framework.framework/Resources/Info.plist'
    );
    const packagedElectron = (
      await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', frameworkPlist])
    ).stdout.trim();
    assert.equal(
      packagedElectron,
      expectedElectron,
      'CoreFoundation preflight must use the candidate’s exact Electron version'
    );
    checks.packagedElectronVersion = packagedElectron;
    // Prove CoreFoundation isolation with the same Electron version before candidate startup.
    const probe = path.join(sandbox, 'corefoundation-preflight.cjs');
    await writeFile(
      probe,
      "const {app}=require('electron');app.whenReady().then(()=>{console.log(JSON.stringify({home:app.getPath('home'),userData:app.getPath('userData'),electron:process.versions.electron}));});"
    );
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
    const captured = (await nativePresentation(true))[0];
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
    await api<BrowserState>('/api/local-browser/open', {
      mode: 'new-window',
      url: `${fixtureUrl}/seed`,
    });
    const freshWindow = await title('Packaged browser fixture');
    assert(freshWindow.browserVersion?.startsWith('153.'));
    assert(
      (await readdir(browserCache)).length > 0,
      'Managed browser acquisition produced no executable/cache'
    );
    checks.automaticAcquisition = {
      freshCache: browserCache,
      browserVersion: freshWindow.browserVersion,
    };
    await api('/api/local-browser/disconnect', {});
    await api<BrowserState>('/api/local-browser/open', {
      mode: 'embedded',
      url: `${fixtureUrl}/resume`,
    });
    await title('Saved fixture sign-in');
    await quitCandidate();
    checks.firstParentQuit = { serverPortClosed: true, fixtureRequests };
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
      fixtureRequests,
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
      'Actual Chrome/Edge channel-native consent is separate; this run does not touch a personal browser.',
      'Windows desktop remains alpha; no Windows/Linux package proof here.',
      'Production page-only agent commands and reload/swap fixtures are recorded separately.',
    ];
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
    await captureFailureEvidence().catch((captureError: unknown) => {
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
