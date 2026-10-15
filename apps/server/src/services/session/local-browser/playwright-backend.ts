/** Pinned Playwright packaging and managed browser acquisition. */
import { access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { LocalBrowserError } from './errors.js';
import { BrowserDownloadProgress, type BrowserPreparationListener } from './preparation.js';
const runFile = promisify(execFile);
const require = createRequire(import.meta.url);
export const LOCAL_PLAYWRIGHT_VERSION = '1.63.0';
export const LOCAL_MANAGED_CHROMIUM_VERSION = '153.0.8010.12';
export const LOCAL_EXISTING_BROWSER_VERSIONS = { minimum: 144, maximum: 155 } as const;
const BROWSER_LAUNCH_TIMEOUT_MS = 15_000;
/** Refuse drift between the shipped library and its supported browser revision. */
export function assertLocalPlaywrightVersion(): void {
  const installed = require('playwright-core/package.json') as { version?: string };
  if (installed.version !== LOCAL_PLAYWRIGHT_VERSION)
    throw new LocalBrowserError('library_version', 'Update DorkOS before opening its browser.');
}

export interface LocalBrowserBackend {
  launch(
    storagePath: string,
    signal?: AbortSignal,
    onPreparation?: BrowserPreparationListener
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
export const productionBackend: LocalBrowserBackend = {
  async launch(storagePath, signal, onPreparation) {
    await acquireLocalChromium(signal, onPreparation);
    signal?.throwIfAborted();
    onPreparation?.({ stage: 'launching', component: null, percent: null });
    // Playwright launch does not accept AbortSignal. The service retains setup ownership
    // and closes a context that arrives after cancellation; never race this result away.
    return chromium.launchPersistentContext(storagePath, {
      timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      headless: false,
      viewport: null,
      chromiumSandbox: true,
      // Chrome's automation flag disables password saving, which this mode promises to keep.
      ignoreDefaultArgs: ['--enable-automation'],
    });
  },
  connect: (endpoint, headers) => {
    assertLocalPlaywrightVersion();
    return chromium.connectOverCDP(endpoint, { headers, noDefaults: true, timeout: 15_000 });
  },
};

/** Refuse personal-browser versions outside the recorded compatibility window. */
export function assertLocalExistingBrowserVersion(version: string): void {
  const major = Number.parseInt(version, 10);
  if (
    !Number.isFinite(major) ||
    major < LOCAL_EXISTING_BROWSER_VERSIONS.minimum ||
    major > LOCAL_EXISTING_BROWSER_VERSIONS.maximum
  )
    throw new LocalBrowserError(
      'unsupported_version',
      major < LOCAL_EXISTING_BROWSER_VERSIONS.minimum
        ? 'Update your browser, then connect it again.'
        : 'Update DorkOS to use this browser version.'
    );
}
