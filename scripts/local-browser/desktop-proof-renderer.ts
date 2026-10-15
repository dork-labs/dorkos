/** Renderer and native-view assertions for the owned packaged desktop candidate. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import type { WriteStream } from 'node:fs';
import path from 'node:path';
import type {
  ElectronApplication,
  Page,
} from '../../apps/desktop/node_modules/playwright-core/index.js';
import type { NativeImage, View, WebContentsView as NativeBrowserView } from 'electron';
import { LocalBrowserPage } from '../../apps/e2e/pages/LocalBrowserPage.js';
import {
  assertOwnedBrowserProofHome,
  setupOwnedFirstRunUi,
  proofUiExpect as expect,
} from '../../apps/e2e/pages/local-browser-installed-proof.js';
import { inside, canonicalPath, type CandidateIdentity } from './desktop-proof-support.js';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
interface LaunchOptions {
  playwright: typeof import('../../apps/desktop/node_modules/playwright-core/index.js');
  executable: string;
  userData: string;
  cwd: string;
  environment: Record<string, string>;
  log: WriteStream;
  fixtureHome: string;
  appArchive: string;
  expectedElectron: string;
  dorkData: string;
  resources: string;
  checks: Record<string, unknown>;
  port: number;
  base: string;
  firstRunPromptSeed: Record<string, unknown>;
  output: string;
  api: <T = Record<string, unknown>>(route: string, body?: unknown) => Promise<T>;
  candidateIdentity: (app: ElectronApplication) => Promise<CandidateIdentity>;
  onApplication: (app: ElectronApplication) => void;
  onIdentity: (identity: CandidateIdentity) => void;
  onRenderer: (renderer: Page) => void;
}
/** Launch the isolated candidate, register its ownership immediately, and verify its renderer. */
export async function launchCandidate(
  options: LaunchOptions,
  suffix: string,
  installerOffline = false
): Promise<Page> {
  const {
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
  } = options;
  const launchedAt = Date.now();
  const application = await playwright._electron.launch({
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
  options.onApplication(application);
  application.process().stdout?.pipe(log, { end: false });
  application.process().stderr?.pipe(log, { end: false });
  const identity = await candidateIdentity(application);
  options.onIdentity(identity);
  assert.equal(
    await realpath(identity.home),
    fixtureHome,
    'Candidate CoreFoundation home escaped isolation'
  );
  assert.equal(await realpath(identity.userData), userData, 'Candidate userData escaped isolation');
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
  options.onRenderer(renderer);
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
  await expect(controls.controls.getByRole('radio')).toHaveCount(2);
  const embeddedChoice = controls.controls.getByRole('radio', { name: /^DorkOS browser/ });
  await expect(embeddedChoice).toBeChecked();
  await expect(embeddedChoice).toBeEnabled();
  await expect(controls.controls.getByRole('radio', { name: /^New browser window/ })).toBeEnabled();
  checks[`browserChoices-${suffix}`] = {
    count: 2,
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

/** Inspect only the native view serving the owned fixture and optionally capture its pixels. */
export async function nativePresentation(
  application: ElectronApplication,
  fixtureUrl: string,
  capture = false
) {
  return application.evaluate(
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
/** Capture bounded renderer evidence before the entry point closes its owned candidate. */
export async function captureFailureEvidence(
  renderer: Page | undefined,
  output: string,
  checks: Record<string, unknown>
): Promise<void> {
  if (!renderer || renderer.isClosed()) return;
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
    evidence.screenshotError = results[0].status === 'rejected' ? String(results[0].reason) : null;
    evidence.bodyText =
      results[1].status === 'fulfilled' ? results[1].value.toString().slice(0, 8_192) : null;
    evidence.bodyTextError = results[1].status === 'rejected' ? String(results[1].reason) : null;
  } catch (error) {
    evidence.captureError = String(error);
  } finally {
    clearTimeout(timer);
  }
}
