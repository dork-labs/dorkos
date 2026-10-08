import { expect, type Page, type Response } from '@playwright/test';
import { ManagedBrowserPage } from '../pages/ManagedBrowserPage';
import { SettingsPage } from '../pages/SettingsPage';
import type { ManagedReceiver } from './managed-browser-receiver';
import { preparePackagedManagedBrowser } from './signed-desktop/setup';

/** The original Electron BrowserWindow, with only URL resolution supplied for existing POMs. */
export function absoluteElectronPage(original: Page, origin: string): Page {
  const request = new Proxy(original.request, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch'].includes(String(key)))
        return (url: string, ...args: unknown[]) =>
          Reflect.apply(value, target, [new URL(url, origin).href, ...args]);
      return value.bind(target);
    },
  });
  return new Proxy(original, {
    get(target, key) {
      if (key === 'request') return request;
      if (key === 'goto')
        return (url: string, ...args: unknown[]) =>
          Reflect.apply(target.goto, target, [new URL(url, origin).href, ...args]);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export interface DesktopActorArtifacts {
  testId: string;
  checkAdmission(): void;
  reuseSaved: boolean;
  initialSavedCookie: boolean;
  retainOriginalProcesses(): Promise<void>;
  /** Optional original OS observer; no result supplies browser or input authority. */
  observePresence?(phase: 'launch' | 'capture' | 'input' | 'off'): Promise<void>;
  outputPath(name: string): string;
  attach(name: string, value: { body: Buffer; contentType: string }): Promise<void>;
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

/** Same real public UI assertions as the installed web leg, on an actual Electron window. */
export async function exercisePackagedManagedBrowser(
  page: Page,
  managedReceiver: ManagedReceiver,
  testInfo: DesktopActorArtifacts
): Promise<void> {
  const checkAdmission = testInfo.checkAdmission.bind(testInfo);
  checkAdmission();
  const settingsPage = new SettingsPage(page);
  await preparePackagedManagedBrowser(page, settingsPage, testInfo, checkAdmission);
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
    checkAdmission();
    await toggle.click();
    enabled = await enabling;
  } finally {
    await Promise.allSettled([enabling]);
  }
  expect(enabled.status()).toBe(200);
  const ready = await enabled.json();
  expect(ready.state).toBe('qualification');
  expect(ready.readiness).toBe('unverified');
  expect(ready.enabled).toBe(true);
  expect(ready.workspaces.length).toBeGreaterThan(0);
  const workspace = ready.workspaces[0].workspaceId;
  expect(
    ready.workspaces.some((value: { workspaceId: string }) => value.workspaceId === workspace)
  ).toBe(true);
  checkAdmission();
  await settingsPage.close();
  const view = new ManagedBrowserPage(page);
  checkAdmission();
  await view.goto();
  const label = `UI acceptance ${testInfo.testId}`;
  checkAdmission();
  if (testInfo.reuseSaved) {
    checkAdmission();
    await page.getByLabel('Workspace', { exact: true }).selectOption(workspace);
    checkAdmission();
    await page.getByLabel('Browser', { exact: true }).selectOption('persistent');
    checkAdmission();
    await page.getByLabel('Saved profile', { exact: true }).selectOption({ label });
  } else await view.createSaved(label, workspace);
  checkAdmission();
  await view.openSaved();
  await testInfo.retainOriginalProcesses();
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
    checkAdmission();
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
    await testInfo.observePresence?.('capture');
    const beforeFocus = acknowledgments;
    await expect
      .poll(async () => (await pixels(view, metrics.width, metrics.height))?.whites)
      .toBe(0);
    checkAdmission();
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
        checkAdmission();
        const rect = await view.pointer.boundingBox();
        return !!rect && Math.abs(rect.x + 2 - target.x) < 3 && Math.abs(rect.y + 2 - target.y) < 3;
      })
      .toBe(true);
    // Blur only by genuine input on the captured page, then observe a subsequent actual draw.
    const beforeBlur = acknowledgments;
    checkAdmission();
    await view.point(270, 140, metrics.width, metrics.height, true);
    await expect.poll(() => managedReceiver.observations.at(-1)?.focused).toBe(false);
    await expect.poll(() => acknowledgments).toBeGreaterThan(beforeBlur + 1);
    await expect
      .poll(async () => (await pixels(view, metrics.width, metrics.height))?.whites)
      .toBe(0);
    checkAdmission();
    await view.point(56, 80, metrics.width, metrics.height, true);
    await expect.poll(() => managedReceiver.observations.at(-1)?.focused).toBe(true);
    const marker = 'managed-ui';
    // Wait for each actual destination observation: serialized key delivery is exercised.
    for (let index = 0; index < marker.length; index++) {
      checkAdmission();
      await page.keyboard.press(marker[index]!);
      await expect
        .poll(() => managedReceiver.observations.at(-1)?.value)
        .toBe(marker.slice(0, index + 1));
    }
    await expect
      .poll(async () => (await pixels(view, metrics.width, metrics.height))?.whiteColumns ?? 0)
      .toBeGreaterThan(4);
    await page.screenshot({ path: testInfo.outputPath('native-typed.png') });
    await testInfo.observePresence?.('input');
    expect(managedReceiver.visits[0]?.cookieReturned).toBe(testInfo.initialSavedCookie);
    checkAdmission();
    await view.closeSaved(label);
    checkAdmission();
    await view.openSaved();
    await testInfo.retainOriginalProcesses();
    await testInfo.observePresence?.('launch');
    const beforeReopen = managedReceiver.visits.length;
    checkAdmission();
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
    checkAdmission();
    await view.closeSaved(label);
    const cleanVisit = managedReceiver.visits.length;
    const cleanObservation = managedReceiver.observations.length;
    checkAdmission();
    const clean = await view.openClean();
    await testInfo.retainOriginalProcesses();
    checkAdmission();
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
    checkAdmission();
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
        checkAdmission();
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
      checkAdmission();
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
    checkAdmission();
    await view.closeClean(clean.binding);
    const newCleanVisit = managedReceiver.visits.length;
    const newCleanObservation = managedReceiver.observations.length;
    checkAdmission();
    const newClean = await view.openClean();
    await testInfo.retainOriginalProcesses();
    expect(newClean.binding.browserId).not.toBe(clean.binding.browserId);
    checkAdmission();
    await view.navigateLocal(managedReceiver.url);
    await expect.poll(() => managedReceiver.visits.length).toBeGreaterThan(newCleanVisit);
    expect(managedReceiver.visits[newCleanVisit]?.cookieReturned).toBe(false);
    await expect
      .poll(() => managedReceiver.observations.length)
      .toBeGreaterThan(newCleanObservation);
    expect(managedReceiver.observations[newCleanObservation]?.value).toBe('');
    checkAdmission();
    await view.closeClean(newClean.binding);
    // Original saved profile remains intact after both ephemeral instances were observed closed.
    checkAdmission();
    await view.openSaved();
    await testInfo.retainOriginalProcesses();
    const finalSavedVisit = managedReceiver.visits.length;
    checkAdmission();
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
    checkAdmission();
    await settingsPage.open();
    checkAdmission();
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
      checkAdmission();
      await toggle.click();
      disabled = await disabling;
    } finally {
      await Promise.allSettled([disabling]);
    }
    expect(disabled.status()).toBe(200);
    expect(await disabled.json()).toMatchObject({ state: 'disabled', enabled: false });
    await expect(toggle).not.toBeChecked();
    checkAdmission();
    await settingsPage.close();
    await expect(view.canvas).toHaveCount(0);
    await expect(view.pointer).toHaveCount(0);
    checkAdmission();
    await view.gotoOff();
    const final = await page.request.get('/api/browser/runtime/status');
    expect(final.status()).toBe(200);
    expect(await final.json()).toMatchObject({ state: 'disabled', enabled: false });
    await testInfo.observePresence?.('off');
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
}
