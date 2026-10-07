import { expect, type Locator, type Page, type Request, type Response } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { SettingsPage } from '../../pages/SettingsPage';

/** Join the original UI action and every matching save, including on failure. */
async function chooseMoment(
  page: Page,
  button: Locator,
  matches: Array<(response: Response) => boolean>
): Promise<Response[]> {
  const responses: Response[] = [];
  const failure: { first?: { value: unknown } } = {};
  const saving = matches.map((match, index) =>
    page.waitForResponse(match, { timeout: 10_000 }).then(
      (response) => {
        responses[index] = response;
      },
      (value) => {
        failure.first ??= { value };
      }
    )
  );
  const clicking = button.click({ timeout: 10_000 }).catch((value) => {
    failure.first ??= { value };
  });
  await Promise.allSettled([...saving, clicking]);
  if (failure.first) throw failure.first.value;
  for (const response of responses) expect(response.status()).toBe(200);
  return responses;
}

/** Read only the original UI request's JSON fields used to correlate its save. */
function choiceBody(response: Response, method: string, path: string) {
  if (response.request().method() !== method || new URL(response.url()).pathname !== path) return;
  try {
    const body: unknown = JSON.parse(response.request().postData() ?? 'null');
    if (body && typeof body === 'object') return body as Record<string, unknown>;
  } catch {
    /* Unrelated or malformed responses cannot match this UI choice. */
  }
}

/** Preserve the original first-run UI and Settings setup on the captured Electron page. */
export async function preparePackagedManagedBrowser(
  page: Page,
  settingsPage: SettingsPage,
  testInfo: { outputPath(name: string): string },
  checkAdmission: () => void
): Promise<void> {
  // Bound genuine locator actions; the original runtime-enable wait keeps its existing total budget.
  page.setDefaultTimeout(10_000);
  const initial = await page.request.get('/api/browser/runtime/status');
  expect(initial.status()).toBe(200);
  expect(await initial.json()).toMatchObject({ state: 'disabled', enabled: false });
  const boot: Array<Readonly<Record<string, string | number>>> = [];
  let dropped = 0;
  const retain = (row: Readonly<Record<string, string | number>>) => {
    if (boot.length < 32) boot.push(row);
    else dropped++;
  };
  const location = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`.slice(0, 256);
    } catch {
      return 'unavailable';
    }
  };
  const pageError = (error: Error) =>
    retain({
      kind: 'pageerror',
      name: error.name.slice(0, 64),
      message: error.message.replace(/https?:\/\/[^\s)]+/g, location).slice(0, 512),
    });
  const requestFailed = (request: Request) =>
    retain({
      kind: 'requestfailed',
      url: location(request.url()),
      method: request.method().slice(0, 16),
      failure: (request.failure()?.errorText ?? 'unavailable').slice(0, 128),
    });
  const responseFailed = (response: Response) => {
    if (response.status() >= 400)
      retain({ kind: 'http-refusal', url: location(response.url()), status: response.status() });
  };
  page.on('pageerror', pageError);
  page.on('requestfailed', requestFailed);
  page.on('response', responseFailed);
  try {
    checkAdmission();
    await page.goto('/');
    const shell = page.getByRole('button', { name: 'Open command palette', exact: true });
    const skipSetup = page.getByRole('button', { name: 'Skip all setup', exact: true });
    // Fresh installs show real first-run setup instead of the app header.
    await expect(
      shell
        .or(skipSetup)
        .or(page.getByRole('dialog', { name: 'DorkOS runs at full power', exact: true }))
        .or(page.getByRole('dialog', { name: 'Share anonymous usage data?', exact: true }))
        .first()
    ).toBeVisible({ timeout: 10_000 });
    if (await skipSetup.isVisible()) {
      const dismissedAt = (response: Response): string | undefined => {
        const request = response.request();
        if (request.method() !== 'PATCH' || new URL(response.url()).pathname !== '/api/config')
          return;
        try {
          const patch: unknown = JSON.parse(request.postData() ?? 'null');
          if (!patch || typeof patch !== 'object') return;
          const onboarding = (patch as Record<string, unknown>).onboarding;
          if (!onboarding || typeof onboarding !== 'object') return;
          const value = (onboarding as Record<string, unknown>).dismissedAt;
          return typeof value === 'string' ? value : undefined;
        } catch {
          return;
        }
      };
      const dismissal: { response?: Response; first?: { value: unknown } } = {};
      checkAdmission();
      const saving = page
        .waitForResponse((response) => dismissedAt(response) !== undefined, { timeout: 10_000 })
        .then(
          (response) => {
            dismissal.response = response;
          },
          (value) => {
            dismissal.first ??= { value };
          }
        );
      const clicking = skipSetup.click({ timeout: 10_000 }).catch((value) => {
        dismissal.first ??= { value };
      });
      await Promise.allSettled([saving, clicking]);
      if (dismissal.first) throw dismissal.first.value;
      const originalResponse = dismissal.response;
      if (!originalResponse) throw new Error('Original setup dismissal response required');
      expect(originalResponse.status()).toBe(200);
      const persisted = await page.request.get('/api/config');
      expect(persisted.status()).toBe(200);
      expect(await persisted.json()).toMatchObject({
        onboarding: { dismissedAt: dismissedAt(originalResponse) },
      });
    }
    // The disposable install answers normal consent doors through their real UI.
    // Closing X would leave the question eligible again on every later full page load.
    const configBefore = await page.request.get('/api/config');
    expect(configBefore.status()).toBe(200);
    const beforeChoices = await configBefore.json();
    if (beforeChoices.ui.fullPowerDecidedAt == null) {
      const door = page.getByRole('dialog', { name: 'DorkOS runs at full power', exact: true });
      await expect(door).toBeVisible({ timeout: 10_000 });
      checkAdmission();
      const [decision] = await chooseMoment(
        page,
        door.getByRole('button', { name: 'Keep asking me first', exact: true }),
        [
          (response) => {
            const ui = choiceBody(response, 'PATCH', '/api/config')?.ui;
            return (
              !!ui &&
              typeof ui === 'object' &&
              (ui as Record<string, unknown>).fullPowerChoice === 'supervised' &&
              typeof (ui as Record<string, unknown>).fullPowerDecidedAt === 'string'
            );
          },
          (response) => {
            const body = choiceBody(response, 'PUT', '/api/permissions/preset');
            return body?.preset === 'careful' && body.surface === 'first-run';
          },
        ]
      );
      const saved = await page.request.get('/api/config');
      expect(saved.status()).toBe(200);
      expect(await saved.json()).toMatchObject({
        ui: choiceBody(decision!, 'PATCH', '/api/config')?.ui,
      });
      const permissions = await page.request.get('/api/permissions');
      expect(permissions.status()).toBe(200);
      expect(await permissions.json()).toMatchObject({ preset: 'careful' });
      await expect(door).toBeHidden({ timeout: 10_000 });
    }
    const telemetryBefore = await page.request.get('/api/config');
    expect(telemetryBefore.status()).toBe(200);
    if (!(await telemetryBefore.json()).telemetry.userHasDecided) {
      // MomentHost shows at most one question per launch; a normal reload asks the next.
      checkAdmission();
      await page.reload();
      const telemetry = page.getByRole('dialog', {
        name: 'Share anonymous usage data?',
        exact: true,
      });
      await expect(telemetry).toBeVisible({ timeout: 10_000 });
      checkAdmission();
      await chooseMoment(
        page,
        telemetry.getByRole('button', { name: 'Don’t share', exact: true }),
        [
          (response) => {
            const value = choiceBody(response, 'PATCH', '/api/config')?.telemetry;
            if (!value || typeof value !== 'object') return false;
            const fields = value as Record<string, unknown>;
            return (
              fields.install === false &&
              fields.heartbeat === false &&
              fields.usage === false &&
              fields.userHasDecided === true
            );
          },
        ]
      );
      const saved = await page.request.get('/api/config');
      expect(saved.status()).toBe(200);
      expect(await saved.json()).toMatchObject({
        telemetry: { install: false, heartbeat: false, usage: false, userHasDecided: true },
      });
      await expect(telemetry).toBeHidden({ timeout: 10_000 });
    }
    await expect(shell).toBeVisible({ timeout: 10_000 });
    // Keep bounded evidence active through the actual Settings/Experiments interaction.
    checkAdmission();
    await settingsPage.open();
    checkAdmission();
    await settingsPage.switchTab('Experiments');
    await expect(
      settingsPage.activePanel.getByRole('switch', {
        name: 'Shared browser',
        exact: true,
      })
    ).not.toBeChecked();
  } catch (value) {
    const report = testInfo.outputPath('original-outer-app-boot.json');
    const raster = testInfo.outputPath('original-outer-app-boot.png');
    // Evidence failures never replace the original navigation/readiness failure.
    await Promise.allSettled([
      writeFile(report, JSON.stringify({ url: location(page.url()), boot, dropped }, null, 2), {
        flag: 'wx',
        mode: 0o600,
      }),
      page.screenshot({ path: raster, timeout: 5_000 }),
    ]);
    throw value;
  } finally {
    page.off('pageerror', pageError);
    page.off('requestfailed', requestFailed);
    page.off('response', responseFailed);
  }
}
