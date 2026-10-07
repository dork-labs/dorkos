import { test, expect } from '../../fixtures/managed-browser-receiver';
import { ManagedBrowserPage } from '../../pages/ManagedBrowserPage';
import { writeFile } from 'node:fs/promises';
import type { Locator, Page, Request, Response } from '@playwright/test';

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

/** Actual canvas raster, read only in the DorkOS outer page. No target DOM/CDP access. */
async function pixels(view: ManagedBrowserPage, width: number, height: number) {
  return view.canvas.evaluate(
    (canvas, viewport) => {
      if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) return null;
      const context = canvas.getContext('2d');
      if (!context) return null;
      const sx = canvas.width / viewport.width,
        sy = canvas.height / viewport.height;
      const sample = (x: number, y: number) => [
        ...context.getImageData(Math.floor(x * sx), Math.floor(y * sy), 1, 1).data,
      ];
      const left = Math.ceil(40 * sx),
        top = Math.ceil(44 * sy);
      const w = Math.floor(184 * sx),
        h = Math.floor(68 * sy);
      const raster = context.getImageData(left, top, w, h).data;
      let whites = 0,
        whiteColumns = 0,
        tallest = 0;
      for (let x = 0; x < w; x++) {
        let count = 0;
        for (let y = 0; y < h; y++) {
          const i = (y * w + x) * 4;
          if (
            raster[i]! > 180 &&
            raster[i + 1]! > 180 &&
            raster[i + 2]! > 180 &&
            raster[i + 3] === 255
          )
            count++;
        }
        if (count) whiteColumns++;
        whites += count;
        tallest = Math.max(tallest, count);
      }
      return {
        red: sample(270, 140),
        blue: sample(330, 70),
        whites,
        whiteColumns: whiteColumns / sx,
        tallest: tallest / sy,
        rasterWidth: canvas.width,
        rasterHeight: canvas.height,
      };
    },
    { width, height }
  );
}

test('Installed saved and clean browsers draw frames, show caret and pointer, type, isolate cookies, reopen and turn Off @managed-native', async ({
  page,
  settingsPage,
  managedReceiver,
}, testInfo) => {
  test.setTimeout(180_000);
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
      await page.reload();
      const telemetry = page.getByRole('dialog', {
        name: 'Share anonymous usage data?',
        exact: true,
      });
      await expect(telemetry).toBeVisible({ timeout: 10_000 });
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
    await settingsPage.open();
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
  const toggle = settingsPage.activePanel.getByRole('switch', {
    name: 'Shared browser',
    exact: true,
  });
  await expect(toggle).not.toBeChecked();
  const enabling = page.waitForResponse(
    (value) =>
      new URL(value.url()).pathname === '/api/browser/runtime/enable' &&
      value.request().method() === 'POST',
    { timeout: 180_000 }
  );
  void enabling.catch(() => {});
  let enabled: Response;
  try {
    await toggle.click();
    enabled = await enabling;
  } finally {
    await Promise.allSettled([enabling]);
  }
  expect(enabled.status()).toBe(200);
  const ready = await enabled.json();
  expect(ready.state).toBe('ready');
  expect(ready.enabled).toBe(true);
  expect(ready.workspaces.length).toBeGreaterThan(0);
  const workspace = process.env.DORKOS_MANAGED_UI_WORKSPACE ?? ready.workspaces[0].workspaceId;
  expect(
    ready.workspaces.some((value: { workspaceId: string }) => value.workspaceId === workspace)
  ).toBe(true);
  await settingsPage.close();
  const view = new ManagedBrowserPage(page);
  await view.goto();
  const label = `UI acceptance ${testInfo.testId}`;
  await view.createSaved(label, workspace);
  await view.openSaved();
  let acknowledgments = 0;
  let drawObservationOverflow = false;
  let lastDraw: { viewerId: string; frameId: string; sequence: number } | undefined;
  let finalRaster: Awaited<ReturnType<typeof pixels>>;
  const observe = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).pathname !== '/api/browser/viewers/next') return;
    const body = request.postDataJSON();
    const receipt = body?.receipt;
    if (receipt?.stage === 'drawn') {
      if (acknowledgments >= 65536) {
        drawObservationOverflow = true;
        return;
      }
      acknowledgments++;
      lastDraw = {
        viewerId: receipt.viewerId,
        frameId: receipt.frameId,
        sequence: receipt.sequence,
      };
    }
  };
  page.on('request', observe);
  try {
    await view.navigateLocal(managedReceiver.url);
    await expect.poll(() => managedReceiver.observations.length).toBeGreaterThan(0);
    const metrics = managedReceiver.observations[0]!;
    await expect
      .poll(async () => {
        const p = await pixels(view, metrics.width, metrics.height);
        return !!p && p.red[0]! > 180 && p.red[1]! < 50 && p.blue[2]! > 180 && p.blue[0]! < 50;
      })
      .toBe(true);
    await expect.poll(() => acknowledgments).toBeGreaterThan(0);
    const beforeFocus = acknowledgments;
    await expect
      .poll(async () => (await pixels(view, metrics.width, metrics.height))?.whites)
      .toBe(0);
    const target = await view.point(56, 80, metrics.width, metrics.height, true);
    await expect(page.getByRole('textbox', { name: 'Browser typing', exact: true })).toBeFocused();
    await expect.poll(() => managedReceiver.observations.at(-1)?.focused).toBe(true);
    await expect.poll(() => acknowledgments).toBeGreaterThan(beforeFocus);
    // Empty target input: a white glyph cannot accidentally satisfy the native caret assertion.
    expect(managedReceiver.observations.at(-1)?.value).toBe('');
    await expect
      .poll(
        async () => {
          const p = await pixels(view, metrics.width, metrics.height);
          return !!p && p.whiteColumns > 0 && p.whiteColumns <= 4 && p.tallest >= 20;
        },
        { timeout: 10_000 }
      )
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath('native-caret.png') });
    await expect(view.pointer).toBeVisible();
    await expect
      .poll(async () => {
        const rect = await view.pointer.boundingBox();
        return !!rect && Math.abs(rect.x + 2 - target.x) < 3 && Math.abs(rect.y + 2 - target.y) < 3;
      })
      .toBe(true);
    // Blur only by genuine input on the captured page, then observe a subsequent actual draw.
    const beforeBlur = acknowledgments;
    await view.point(270, 140, metrics.width, metrics.height, true);
    await expect.poll(() => managedReceiver.observations.at(-1)?.focused).toBe(false);
    await expect.poll(() => acknowledgments).toBeGreaterThan(beforeBlur + 1);
    await expect
      .poll(async () => (await pixels(view, metrics.width, metrics.height))?.whites)
      .toBe(0);
    await view.point(56, 80, metrics.width, metrics.height, true);
    await expect.poll(() => managedReceiver.observations.at(-1)?.focused).toBe(true);
    const marker = 'managed-ui';
    // Wait for each actual destination observation: serialized key delivery is exercised.
    for (let index = 0; index < marker.length; index++) {
      await page.keyboard.press(marker[index]!);
      await expect
        .poll(() => managedReceiver.observations.at(-1)?.value)
        .toBe(marker.slice(0, index + 1));
    }
    await expect
      .poll(async () => (await pixels(view, metrics.width, metrics.height))?.whiteColumns ?? 0)
      .toBeGreaterThan(4);
    await page.screenshot({ path: testInfo.outputPath('native-typed.png') });
    expect(managedReceiver.visits[0]?.cookieReturned).toBe(false);
    await view.closeSaved(label);
    await view.openSaved();
    const beforeReopen = managedReceiver.visits.length;
    await view.navigateLocal(managedReceiver.url);
    await expect.poll(() => managedReceiver.visits.length).toBeGreaterThan(beforeReopen);
    expect(managedReceiver.visits.at(-1)?.cookieReturned).toBe(true);
    await expect
      .poll(async () => {
        const p = await pixels(view, metrics.width, metrics.height);
        return !!p && p.blue[2]! > 180 && p.blue[0]! < 50;
      })
      .toBe(true);
    // Close the genuine saved instance, retaining its profile. Clean UI navigation then
    // uses the same destination/cookie path, so isolation cannot pass via a different origin.
    await view.closeSaved(label);
    const cleanVisit = managedReceiver.visits.length;
    const cleanObservation = managedReceiver.observations.length;
    const clean = await view.openClean();
    await view.navigateLocal(managedReceiver.url);
    await expect.poll(() => managedReceiver.visits.length).toBeGreaterThan(cleanVisit);
    expect(managedReceiver.visits[cleanVisit]?.cookieReturned).toBe(false);
    await expect.poll(() => managedReceiver.observations.length).toBeGreaterThan(cleanObservation);
    const cleanMetrics = managedReceiver.observations[cleanObservation]!;
    expect(cleanMetrics.value).toBe('');
    expect(cleanMetrics.focused).toBe(false);
    await expect
      .poll(async () => {
        const raster = await pixels(view, cleanMetrics.width, cleanMetrics.height);
        return (
          !!raster &&
          raster.red[0]! > 180 &&
          raster.red[1]! < 50 &&
          raster.blue[2]! > 180 &&
          raster.blue[0]! < 50
        );
      })
      .toBe(true);
    await expect
      .poll(async () => (await pixels(view, cleanMetrics.width, cleanMetrics.height))?.whites)
      .toBe(0);
    const cleanBeforeFocus = acknowledgments;
    const cleanTarget = await view.point(56, 80, cleanMetrics.width, cleanMetrics.height, true);
    await expect(page.getByRole('textbox', { name: 'Browser typing', exact: true })).toBeFocused();
    await expect.poll(() => managedReceiver.observations.at(-1)?.focused).toBe(true);
    expect(managedReceiver.observations.at(-1)?.value).toBe('');
    await expect.poll(() => acknowledgments).toBeGreaterThan(cleanBeforeFocus);
    await expect
      .poll(
        async () => {
          const raster = await pixels(view, cleanMetrics.width, cleanMetrics.height);
          return (
            !!raster && raster.whiteColumns > 0 && raster.whiteColumns <= 4 && raster.tallest >= 20
          );
        },
        { timeout: 10_000 }
      )
      .toBe(true);
    await expect(view.pointer).toBeVisible();
    await expect
      .poll(async () => {
        const rect = await view.pointer.boundingBox();
        return (
          !!rect &&
          Math.abs(rect.x + 2 - cleanTarget.x) < 3 &&
          Math.abs(rect.y + 2 - cleanTarget.y) < 3
        );
      })
      .toBe(true);
    const cleanMarker = 'clean-ui';
    for (let index = 0; index < cleanMarker.length; index++) {
      await page.keyboard.press(cleanMarker[index]!);
      await expect
        .poll(() => managedReceiver.observations.at(-1)?.value)
        .toBe(cleanMarker.slice(0, index + 1));
    }
    await expect
      .poll(
        async () => (await pixels(view, cleanMetrics.width, cleanMetrics.height))?.whiteColumns ?? 0
      )
      .toBeGreaterThan(4);
    await page.screenshot({ path: testInfo.outputPath('native-clean-typed.png') });
    await view.closeClean(clean.binding);
    const newCleanVisit = managedReceiver.visits.length;
    const newCleanObservation = managedReceiver.observations.length;
    const newClean = await view.openClean();
    expect(newClean.binding.browserId).not.toBe(clean.binding.browserId);
    await view.navigateLocal(managedReceiver.url);
    await expect.poll(() => managedReceiver.visits.length).toBeGreaterThan(newCleanVisit);
    expect(managedReceiver.visits[newCleanVisit]?.cookieReturned).toBe(false);
    await expect
      .poll(() => managedReceiver.observations.length)
      .toBeGreaterThan(newCleanObservation);
    expect(managedReceiver.observations[newCleanObservation]?.value).toBe('');
    await view.closeClean(newClean.binding);
    // Original saved profile remains intact after both ephemeral instances were observed closed.
    await view.openSaved();
    const finalSavedVisit = managedReceiver.visits.length;
    await view.navigateLocal(managedReceiver.url);
    await expect.poll(() => managedReceiver.visits.length).toBeGreaterThan(finalSavedVisit);
    expect(managedReceiver.visits[finalSavedVisit]?.cookieReturned).toBe(true);
    await expect
      .poll(async () => {
        const raster = await pixels(view, metrics.width, metrics.height);
        return !!raster && raster.blue[2]! > 180 && raster.blue[0]! < 50;
      })
      .toBe(true);
    finalRaster = await pixels(view, metrics.width, metrics.height);
    await settingsPage.open();
    await settingsPage.switchTab('Experiments');
    await expect(toggle).toBeChecked();
    const disabling = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === '/api/browser/runtime/enable' &&
        value.request().method() === 'POST'
    );
    void disabling.catch(() => {});
    let disabled: Response;
    try {
      await toggle.click();
      disabled = await disabling;
    } finally {
      await Promise.allSettled([disabling]);
    }
    expect(disabled.status()).toBe(200);
    expect(await disabled.json()).toMatchObject({ state: 'disabled', enabled: false });
    await expect(toggle).not.toBeChecked();
    await settingsPage.close();
    await expect(view.canvas).toHaveCount(0);
    await expect(view.pointer).toHaveCount(0);
    await view.goto();
    await expect(
      page.getByText('Turn on Shared browser in Settings → Experiments.', { exact: true })
    ).toBeVisible();
    const final = await page.request.get('/api/browser/runtime/status');
    expect(final.status()).toBe(200);
    expect(await final.json()).toMatchObject({ state: 'disabled', enabled: false });
    expect(drawObservationOverflow, 'actual draw observation capacity').toBe(false);
    await testInfo.attach('actual-public-ui-observations', {
      body: Buffer.from(
        JSON.stringify({
          raster: finalRaster,
          lastDraw,
          actualDrawReceipts: acknowledgments,
          originalTargetTyped: managedReceiver.observations.some((value) => value.value === marker),
          reopenedCookie: managedReceiver.visits.at(-1)?.cookieReturned,
          cleanTyped: managedReceiver.observations.some((value) => value.value === cleanMarker),
          cleanCookieIsolated: managedReceiver.visits[cleanVisit]?.cookieReturned === false,
          newCleanCookieIsolated: managedReceiver.visits[newCleanVisit]?.cookieReturned === false,
          savedCookiePreserved: managedReceiver.visits[finalSavedVisit]?.cookieReturned === true,
          cleanBrowserIds: [clean.binding.browserId, newClean.binding.browserId],
          off: true,
        })
      ),
      contentType: 'application/json',
    });
  } finally {
    page.off('request', observe);
  }
});
