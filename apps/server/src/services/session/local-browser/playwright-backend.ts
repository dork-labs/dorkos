/** Pinned Playwright packaging and managed browser acquisition. */
import { access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import {
  agentWindowNameArg,
  agentWindowThemeArgs,
  assertAgentFrame,
  writeAgentWindowTheme,
} from './agent-window/index.js';
import { LocalBrowserError } from './errors.js';
import { BrowserDownloadProgress, type BrowserPreparationListener } from './preparation.js';
import { disablePasswordSaving } from './plain-chromium.js';
const runFile = promisify(execFile);
const require = createRequire(import.meta.url);
export const LOCAL_PLAYWRIGHT_VERSION = '1.65.0-alpha-2026-10-30';
export const LOCAL_MANAGED_CHROMIUM_VERSION = '157.0.8103.15';
const BROWSER_LAUNCH_TIMEOUT_MS = 15_000;
// Exact disabledFeatures list from the pinned library. Chromium takes only the last
// --disable-features argument, so replace that argument with one merged list.
const PINNED_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'AvoidCorsURLLoaderRestartOnRedirect',
  'TcpPortRandomizationWin',
  'OptimizationHints',
  'NetworkTimeServiceQuerying',
  'AimEnabled',
  'PreconnectToSearch',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
].join(',');
const PINNED_DISABLED_FEATURES_ARG = `--disable-features=${PINNED_DISABLED_FEATURES}`;
/** Refuse drift between the shipped library and its supported browser revision. */
export function assertLocalPlaywrightVersion(): void {
  const installed = require('playwright-core/package.json') as { version?: string };
  if (installed.version !== LOCAL_PLAYWRIGHT_VERSION)
    throw new LocalBrowserError('library_version', 'Update DorkOS before opening its browser.');
}

export interface LocalBrowserBackend {
  /**
   * Open the agent's own window.
   *
   * @param storagePath - The profile's folder.
   * @param signal - Cancels the browser download and setup.
   * @param onPreparation - Told how the download and launch are going.
   * @param agentName - The chat's agent, for the window's title; null when it isn't known.
   */
  launch(
    storagePath: string,
    signal?: AbortSignal,
    onPreparation?: BrowserPreparationListener,
    agentName?: string | null
  ): Promise<BrowserContext>;
  connect(endpoint: string, headers?: Record<string, string>): Promise<Browser>;
}

/** Only downloads the browser paired with the installed library; never invokes npx. */
export async function acquireLocalChromium(
  signal?: AbortSignal,
  onPreparation?: BrowserPreparationListener
): Promise<void> {
  onPreparation?.({ stage: 'checking', component: null, percent: null });
  assertLocalPlaywrightVersion();
  if (signal?.aborted)
    throw new LocalBrowserError('cancelled', 'Browser setup stopped. Open it again to continue.');
  try {
    await access(chromium.executablePath());
    return;
  } catch {
    /* first launch */
  }
  const packageDirectory = path.dirname(require.resolve('playwright-core/package.json'));
  // The desktop ships the full library unpacked: its installer is a real child process.
  const installerDirectory = packageDirectory.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const cli = path.join(installerDirectory, 'cli.js');
  try {
    onPreparation?.({ stage: 'downloading', component: null, percent: null });
    const installing = runFile(process.execPath, [cli, 'install', 'chromium'], {
      timeout: 180_000,
      signal,
      maxBuffer: 2 * 1024 * 1024,
      // Preserve installer proxy/certificate settings; this is a child environment, not app configuration.
      // eslint-disable-next-line no-restricted-syntax
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const progress = new BrowserDownloadProgress((state) => {
      if (!signal?.aborted) onPreparation?.(state);
    });
    const output = (chunk: Buffer | string) => progress.push(chunk);
    installing.child?.stdout?.on('data', output);
    try {
      await installing;
    } finally {
      installing.child?.stdout?.off('data', output);
    }
  } catch (error) {
    if (signal?.aborted)
      throw new LocalBrowserError('cancelled', 'Browser setup stopped. Open it again to continue.');
    const failure = error as { code?: string; stderr?: string };
    if (failure.code === 'ENOSPC' || failure.stderr?.includes('ENOSPC'))
      throw new LocalBrowserError(
        'browser_storage',
        'Free some space, then open the browser again.'
      );
    if (failure.code === 'EACCES' || failure.stderr?.includes('EACCES'))
      throw new LocalBrowserError(
        'browser_storage',
        'Check folder permissions, then open the browser again.'
      );
    throw new LocalBrowserError(
      'browser_download',
      'Couldn’t download the browser. Check your connection and try again.'
    );
  }
}
/** The managed Chromium's path, downloading it first if needed. The sign-in window runs it plainly. */
export async function managedChromiumPath(): Promise<string> {
  await acquireLocalChromium();
  return chromium.executablePath();
}

export const productionBackend: LocalBrowserBackend = {
  async launch(storagePath, signal, onPreparation, agentName) {
    await acquireLocalChromium(signal, onPreparation);
    signal?.throwIfAborted();
    onPreparation?.({ stage: 'launching', component: null, percent: null });
    // The profile is shared with the plain sign-in window, and with the basic
    // password store a saved password is readable on disk. Neither window saves one.
    await disablePasswordSaving(storagePath);
    const theme = await writeAgentWindowTheme(storagePath);
    // Playwright launch does not accept AbortSignal. The service retains setup ownership
    // and closes a context that arrives after cancellation; never race this result away.
    const context = await chromium.launchPersistentContext(storagePath, {
      timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      headless: false,
      viewport: null,
      chromiumSandbox: true,
      args: [
        `${PINNED_DISABLED_FEATURES_ARG},HttpsUpgrades,HttpsFirstBalancedModeAutoEnable`,
        ...agentWindowThemeArgs(theme),
        agentWindowNameArg(agentName),
      ],
      // Without the automation flag the window looks like the person's Chrome;
      // password saving is off in the profile itself. The theme's own flag allows
      // that one folder and no other extension, in place of Playwright's blanket one.
      ignoreDefaultArgs: [
        '--enable-automation',
        PINNED_DISABLED_FEATURES_ARG,
        '--disable-extensions',
      ],
    });
    try {
      await assertAgentFrame(context);
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
    return context;
  },
  connect: (endpoint, headers) => {
    assertLocalPlaywrightVersion();
    return chromium.connectOverCDP(endpoint, { headers, noDefaults: true, timeout: 15_000 });
  },
};
