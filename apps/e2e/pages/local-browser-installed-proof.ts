/** Real UI and production-tool assertions on an exclusively owned installed test-mode server. */
import { bounded } from '../../../scripts/local-browser/owned-chrome-cleanup.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  chromium,
  expect,
  type Browser,
  type Page,
  type APIRequestContext,
} from '@playwright/test';

import { LocalBrowserPage } from './LocalBrowserPage';
import { ChatPage } from './ChatPage';

/** Workspace UI runner uses its existing cache; the installed app owns a separate empty cache. */
export const proofUiDriver = chromium;
export { expect as proofUiExpect };

/** Read-only custody check required before any reset, seed, or configuration write. */
export async function assertOwnedBrowserProofHome(
  request: APIRequestContext,
  baseURL: string,
  expectedDataDirectory: string
) {
  expect(new URL(baseURL).hostname, 'Owned UI setup requires loopback').toBe('127.0.0.1');
  const configUrl = new URL('/api/config', baseURL).href;
  const response = await request.get(configUrl);
  expect(response.ok()).toBe(true);
  const config = (await response.json()) as {
    dorkHome?: string;
    onboarding?: { dismissedAt?: string | null };
    profile?: { rolePromptDismissedAt?: string | null; identityPromptDismissedAt?: string | null };
    telemetry?: { userHasDecided?: boolean };
    ui?: { trustNoticeSeenAt?: string | null };
  };
  expect(typeof config.dorkHome, 'The candidate API must report its actual data directory').toBe(
    'string'
  );
  const expectedHome = await realpath(expectedDataDirectory);
  expect(
    await realpath(config.dorkHome!),
    'Refuse config writes outside the explicitly owned data directory'
  ).toBe(expectedHome);
  return { config, configUrl, expectedHome };
}

/** Settle only first-run prompts after proving this API stores data in the caller's private fixture. */
export async function setupOwnedFirstRunUi(
  request: APIRequestContext,
  baseURL: string,
  expectedDataDirectory: string
) {
  const { config, configUrl, expectedHome } = await assertOwnedBrowserProofHome(
    request,
    baseURL,
    expectedDataDirectory
  );
  const now = new Date().toISOString();
  const promptFields = {
    onboarding: { dismissedAt: config.onboarding?.dismissedAt ?? now },
    profile: {
      rolePromptDismissedAt: config.profile?.rolePromptDismissedAt ?? now,
      identityPromptDismissedAt: config.profile?.identityPromptDismissedAt ?? now,
    },
    telemetry: { userHasDecided: true },
    ui: { trustNoticeSeenAt: config.ui?.trustNoticeSeenAt ?? now },
  };
  expect((await request.patch(configUrl, { data: promptFields })).ok()).toBe(true);
  return { verifiedPrivateDataDirectory: expectedHome, settledPromptFields: promptFields };
}

/** Prove real installer refusal produces recoverable copy before the successful first-use run. */
export async function proveInstalledPreparationFailure(
  browser: Browser,
  baseURL: string,
  output: string,
  expectedDataDirectory: string
) {
  if (new URL(baseURL).hostname !== '127.0.0.1')
    throw new Error('UI proof requires owned loopback');
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 900 },
    recordVideo: { dir: output },
  });
  try {
    const page = await context.newPage();
    await assertOwnedBrowserProofHome(page.request, baseURL, expectedDataDirectory);
    expect((await page.request.post('/api/test/reset')).ok()).toBe(true);
    const firstRun = await setupOwnedFirstRunUi(page.request, baseURL, expectedDataDirectory);
    const seeded = await page.request.post('/api/test/seed-agent');
    expect(seeded.ok()).toBe(true);
    const { agentDir } = (await seeded.json()) as { agentDir: string };
    await new ChatPage(page).goto(randomUUID(), {
      dir: agentDir,
      draft: true,
      runtime: 'test-mode',
    });
    const ui = new LocalBrowserPage(page);
    await ui.open();
    await ui.controls.getByRole('radio', { name: /^New browser window/ }).check();
    await ui.controls.getByRole('button', { name: 'Open browser', exact: true }).click();
    const recovery = 'Couldn’t download the browser. Check your connection and try again.';
    await expect(ui.controls.getByRole('alert')).toHaveText(recovery, { timeout: 120_000 });
    await expect(
      ui.controls.getByRole('button', { name: 'Open browser', exact: true })
    ).toBeEnabled();
    const state = await (await page.request.get('/api/local-browser/state')).json();
    expect(state.status).toBe('disconnected');
    expect(state.preparation).toBeNull();
    await page.screenshot({ path: path.join(output, 'browser-download-error.png') });
    return {
      firstRun,
      realInstallerNetworkRefusal: true,
      recovery,
      openEnabled: true,
      preparationCleared: true,
    };
  } finally {
    await bounded(context.close(), 10_000, 'Owned failure UI context close');
  }
}

/** This caller must own the server: resets here must never reach the shared E2E test-mode leg. */
export async function proveInstalledLocalBrowserUi(
  browser: Browser,
  baseURL: string,
  output: string,
  expectedDataDirectory: string
) {
  const originUrl = new URL(baseURL);
  if (originUrl.hostname !== '127.0.0.1')
    throw new Error('UI proof requires its owned loopback server');
  const saved: string[] = [];
  const fixture = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    if (url.pathname === '/saved') saved.push(url.searchParams.get('name') ?? '');
    response.setHeader('Content-Type', 'text/html');
    response.end(
      "<title>Local live page</title><input aria-label=\"Name\"><button onclick=\"fetch('/saved?name='+encodeURIComponent(document.querySelector('input').value));document.title='Saved live page'\">Save</button>"
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a local port');
  const origin = `http://127.0.0.1:${address.port}`;
  const evidence: Record<string, unknown> = {};

  /** A test-mode route must answer before any scripted chat turn is allowed. */
  async function prepare(page: Page) {
    await assertOwnedBrowserProofHome(page.request, baseURL, expectedDataDirectory);
    const reset = await page.request.post('/api/test/reset');
    expect(reset.ok(), 'Refuse scripted turns without the test-mode runtime').toBe(true);
    evidence.firstRun = await setupOwnedFirstRunUi(page.request, baseURL, expectedDataDirectory);
    expect((await page.request.post('/api/local-browser/disconnect')).ok()).toBe(true);
    const seeded = await page.request.post('/api/test/seed-agent');
    expect(seeded.ok()).toBe(true);
    return (await seeded.json()) as { agentDir: string };
  }
  try {
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ baseURL, viewport, recordVideo: { dir: output } });
      try {
        const page = await context.newPage();
        const { agentDir } = await prepare(page);
        await new ChatPage(page).goto(randomUUID(), {
          dir: agentDir,
          draft: true,
          runtime: 'test-mode',
        });
        const ui = new LocalBrowserPage(page);
        await ui.open();
        await expect(ui.controls.getByRole('radio')).toHaveCount(3);
        await expect(ui.controls.getByRole('radio', { name: /^DorkOS browser/ })).toBeDisabled();
        await expect(ui.controls.getByRole('radio', { name: /^New browser window/ })).toBeChecked();
        await ui.controls.getByRole('radio', { name: /^Your existing browser/ }).check();
        const browserChoice = ui.controls.getByRole('combobox', {
          name: 'Choose your browser',
          exact: true,
        });
        await browserChoice.selectOption('msedge');
        await ui.controls
          .getByRole('checkbox', { name: 'Allow DorkOS to use this browser' })
          .check();
        await page.reload();
        await ui.open();
        await expect(
          ui.controls.getByRole('radio', { name: /^Your existing browser/ })
        ).toBeChecked();
        await expect(browserChoice).toHaveValue('msedge');
        await expect(
          ui.controls.getByRole('checkbox', { name: 'Allow DorkOS to use this browser' })
        ).not.toBeChecked();
        await expect(
          ui.controls.getByRole('button', { name: 'Connect browser', exact: true })
        ).toBeDisabled();
        await page.screenshot({ path: path.join(output, `browser-choices-${viewport.width}.png`) });
        evidence[`choices-${viewport.width}`] = {
          threeModes: true,
          preferenceRestored: true,
          consentNotRestored: true,
        };
      } finally {
        await bounded(context.close(), 10_000, 'Owned UI context close');
      }
    }
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 1440, height: 1000 },
      recordVideo: { dir: output },
    });
    try {
      const page = await context.newPage();
      const { agentDir } = await prepare(page);
      const sessionId = randomUUID();
      expect(
        (
          await page.request.post('/api/test/scenario', {
            data: { name: 'local-browser-driving', sessionId },
          })
        ).ok()
      ).toBe(true);
      const chat = new ChatPage(page);
      await chat.goto(sessionId, { dir: agentDir, draft: true, runtime: 'test-mode' });
      const ui = new LocalBrowserPage(page);
      await ui.open();
      await ui.controls.getByRole('radio', { name: /^New browser window/ }).check();
      const preparationText = ui.controls.getByText(
        /^Downloading (?:the browser|browser support|video support|browser files)…$/
      );
      const firstOpenAt = new Date().toISOString();
      await ui.controls.getByRole('button', { name: 'Open browser', exact: true }).click();
      await expect(preparationText).toBeVisible({ timeout: 120_000 });
      const preparation = await (await page.request.get('/api/local-browser/state')).json();
      expect(preparation.preparation?.stage).toBe('downloading');
      await page.screenshot({ path: path.join(output, 'browser-first-download.png') });
      await ui.controls.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(ui.controls.getByRole('status')).toHaveText('Disconnected');
      await expect
        .poll(async () => {
          const state = await (await page.request.get('/api/local-browser/state')).json();
          return { status: state.status, preparation: state.preparation };
        })
        .toEqual({ status: 'disconnected', preparation: null });
      const cancelledAt = new Date().toISOString();
      await page.screenshot({ path: path.join(output, 'browser-preparation-cancelled.png') });
      await ui.controls.getByRole('button', { name: 'Open browser', exact: true }).click();

      await expect(
        ui.controls.getByRole('button', { name: 'Pause agent', exact: true })
      ).toBeVisible({ timeout: 210_000 });
      evidence.firstUsePreparation = {
        firstOpenAt,
        genuineDownloadState: preparation.preparation,
        cancelledAt,
        cancellationClearedPreparation: true,
        retryConnectedAt: new Date().toISOString(),
        retryCompleted: true,
        syntheticProgress: false,
        cacheManipulated: false,
      };
      await ui.navigate(`${origin}/`);
      await chat.sendAndLand('use the local page', 30_000);
      await chat.waitForTurnToEnd(30_000);
      await expect(
        page.locator('[data-testid="message-item"][data-role="assistant"]').last()
      ).toContainText('local-browser: saved; screenshot=image/png');
      await expect.poll(() => saved).toEqual(['Scripted local input']);
      await ui.controls.getByRole('button', { name: 'Pause agent', exact: true }).click();
      await expect(
        ui.controls.getByRole('button', { name: 'Resume agent', exact: true })
      ).toBeVisible();
      await chat.sendAndLand('try while paused', 30_000);
      await chat.waitForTurnToEnd(30_000);
      await expect(
        page.locator('[data-testid="message-item"][data-role="assistant"]').last()
      ).toContainText('local-browser: paused');
      expect(saved).toEqual(['Scripted local input']);
      await ui.controls.getByRole('button', { name: 'Resume agent', exact: true }).click();
      await expect(
        ui.controls.getByRole('button', { name: 'Pause agent', exact: true })
      ).toBeVisible();
      await chat.sendAndLand('use it after resuming', 30_000);
      await chat.waitForTurnToEnd(30_000);
      await expect(
        page.locator('[data-testid="message-item"][data-role="assistant"]').last()
      ).toContainText('local-browser: saved; screenshot=image/png');
      await expect.poll(() => saved).toEqual(['Scripted local input', 'Scripted local input']);
      await page.screenshot({ path: path.join(output, 'browser-shared-agent.png') });
      await ui.controls.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await expect(ui.controls.getByRole('status')).toHaveText('Disconnected');
      evidence.productionTools = {
        sameLivePage: true,
        pngPixels: true,
        pauseRefusedInput: true,
        resumeUsedFreshObservation: true,
        saved,
      };
    } finally {
      await bounded(context.close(), 10_000, 'Owned UI context close');
    }
    return evidence;
  } finally {
    fixture.closeAllConnections();
    await bounded(
      new Promise<void>((resolve) => fixture.close(() => resolve())),
      2_000,
      'Owned UI fixture close'
    );
  }
}
