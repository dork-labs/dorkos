import { readFile } from 'node:fs/promises';
import type { Page, Response, Route } from '@playwright/test';
import {
  OriginalFrameLeaseBank,
  originalFramePriorDraw,
  joinOriginalFrameLeaseSetup,
  parseOriginalFrameQueue,
  type OriginalFrameRole,
} from '../../fixtures/managed-frame-lease-bank';
import { createOriginalFrameChannel } from '../../../server/src/services/browser/runtime/__tests__/private-frame-channel.fixture';
import {
  BrowserProductionOpenReceiptSchema,
  BrowserViewerSchema,
  BrowserRenderReceiptSchema,
} from '@dorkos/shared/browser-schemas';
import { test, expect } from '../../fixtures/managed-performance-receiver';
import { ManagedBrowserPage } from '../../pages/ManagedBrowserPage';
import {
  armFrameSample,
  frameObservations,
  installFrameObserver,
  p95,
} from '../../fixtures/managed-frame-observer';

// Intentional network latency/stall injection, never an element-readiness sleep.
const delay = (ms: number) => new Promise<void>((yes) => setTimeout(yes, ms));
test('Actual viewer pixels: 100 local, 100 injected RTT and stalled second viewer @managed-native', async ({
  page,
  context,
  settingsPage,
  performanceReceiver,
}, info) => {
  test.setTimeout(300_000);
  const queuePath = process.env.DORKOS_MANAGED_QUEUE_OBSERVATIONS;
  if (!queuePath)
    throw new Error(
      'Original in-process viewer bank observations required; no request-count inference'
    );
  const channelDirectory = process.env.DORKOS_MANAGED_FRAME_PARENT_DIR;
  if (!channelDirectory) throw new Error('Original resource/frame parent channel required');
  const channel = await createOriginalFrameChannel(channelDirectory, new AbortController().signal);
  await installFrameObserver(page);
  await page.goto('/');
  await settingsPage.open();
  await settingsPage.switchTab('Experiments');
  const toggle = settingsPage.activePanel.getByRole('switch', {
    name: 'Shared browser',
    exact: true,
  });
  await expect(toggle).not.toBeChecked();
  const enabling = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/browser/runtime/enable' && r.request().method() === 'POST'
  );
  await toggle.click();
  const enabled = await enabling;
  expect(enabled.status()).toBe(200);
  const ready = await enabled.json();
  if (ready.state !== 'qualification') throw new Error('ORIGINAL_BROWSER_QUALIFICATION_REQUIRED');
  expect(ready.state).toBe('qualification');
  expect(ready.readiness).toBe('unverified');
  expect(ready.workspaces.length).toBeGreaterThan(0);
  await settingsPage.close();
  const view = new ManagedBrowserPage(page);
  await view.goto();
  const label = `Frame acceptance ${info.testId}`;
  const workspace = process.env.DORKOS_MANAGED_UI_WORKSPACE;
  if (
    !workspace ||
    !ready.workspaces.some((value: { workspaceId: string }) => value.workspaceId === workspace)
  )
    throw new Error('Original parent workspace unavailable');
  await view.createSaved(label, workspace);
  let second: Page | undefined;
  const leases = new OriginalFrameLeaseBank();
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  let stalledAt = 0,
    heldResponse = false;
  let secondViewerId: string | undefined;
  let stalledLeaseExpiresAt = 0;
  const pattern = '**/api/browser/**';
  const stall = async (route: Route) => {
    try {
      const response = await route.fetch();
      if (
        !heldResponse &&
        new URL(route.request().url()).pathname === '/api/browser/viewers/next'
      ) {
        const original = route.request().postDataJSON();
        // The first genuine next request for a renewed viewer has no previous draw.
        // Forward it unchanged; only the subsequent exact drawn receipt can begin a stall.
        const receipt = originalFramePriorDraw(original);
        if (receipt === null) {
          await route.fulfill({ response });
          return;
        }
        if (receipt.viewerId !== secondViewerId)
          throw new Error('Original second viewer identity changed before active stall');
        const originalLease = leases.assertStallLease(
          receipt.viewerId,
          receipt.binding,
          Date.now()
        );
        stalledLeaseExpiresAt = Date.parse(originalLease.expiresAt);
        heldResponse = true;
        stalledAt = Date.now();
        await held;
      }
      await route.fulfill({ response });
    } catch (value) {
      first ??= { value };
      throw value;
    }
  };
  let first: { value: unknown } | undefined;
  const setupOriginals: Promise<unknown>[] = [];
  const retainSetup = <T>(original: Promise<T>) => {
    setupOriginals.push(original);
    void original.catch(() => {});
    return original;
  };
  const observeIssuance = (role: OriginalFrameRole) => (response: Response) => {
    if (
      new URL(response.url()).pathname !== '/api/browser/viewers/issue' ||
      response.request().method() !== 'POST'
    )
      return;
    const original = (async () => {
      if (response.status() !== 200) throw new Error('FRAME_ORIGINAL_VIEWER_ISSUE_REFUSED');
      leases.record(role, (await response.json()).viewer);
    })();
    retainSetup(original);
    void original.catch((value) => {
      first ??= { value };
    });
  };
  const primaryIssuance = observeIssuance('primary'),
    secondaryIssuance = observeIssuance('secondary');
  page.on('response', primaryIssuance);
  try {
    const opening = retainSetup(
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/browser/runtime/open' &&
          r.request().method() === 'POST'
      )
    );
    await view.openSaved();
    const opened = await opening;
    expect(opened.status()).toBe(200);
    const saved = BrowserProductionOpenReceiptSchema.parse(await opened.json());
    await view.navigateLocal(performanceReceiver.url);
    await expect.poll(async () => (await frameObservations(page)).lastRevision).toBe(0);
    second = await context.newPage();
    const originalSecond = second;
    originalSecond.on('response', secondaryIssuance);
    await installFrameObserver(originalSecond);
    await originalSecond.goto('/browser');
    const row = second
      .getByRole('region', { name: 'Your browsers', exact: true })
      .getByRole('listitem')
      .filter({ hasText: label })
      .filter({
        has: originalSecond
          .getByRole('button', { name: 'View', exact: true })
          .and(originalSecond.locator('button:not([disabled])')),
      });
    await expect(row).toHaveCount(1);
    const issuing = retainSetup(
      originalSecond.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/browser/viewers/issue' &&
          response.request().method() === 'POST'
      )
    );
    const drawn = retainSetup(
      originalSecond.waitForRequest((request) => {
        if (
          new URL(request.url()).pathname !== '/api/browser/viewers/next' ||
          request.method() !== 'POST'
        )
          return false;
        return request.postDataJSON()?.receipt?.stage === 'drawn';
      })
    );
    await row.getByRole('button', { name: 'View', exact: true }).click();
    const issued = await issuing;
    expect(issued.status()).toBe(200);
    const originalSecondViewer = leases.record(
      'secondary',
      BrowserViewerSchema.parse((await issued.json()).viewer)
    );
    secondViewerId = originalSecondViewer.viewerId;
    expect(originalSecondViewer.binding.browserId).toBe(saved.binding.browserId);
    expect(originalSecondViewer.binding.browserGeneration).toBe(saved.binding.browserGeneration);
    expect(originalSecondViewer.binding.tabId).toBe(saved.binding.tabId);
    const originalDrawn = (await drawn).postDataJSON();
    const originalDrawReceipt = BrowserRenderReceiptSchema.parse(originalDrawn.receipt);
    expect(originalDrawReceipt.viewerId).toBe(secondViewerId);
    await expect.poll(async () => (await frameObservations(originalSecond)).lastRevision).toBe(0);
    // Both genuine viewers are decoding/drawing before the parent's idle counters.
    await channel.write('ready', saved);
    await channel.wait('start');
    let revision = 0;
    const sample = async () => {
      await armFrameSample(page, ++revision);
      await view.point(800, 400, 1280, 720, true);
      await expect
        .poll(async () =>
          (await frameObservations(page)).samples.some((s) => s.revision === revision)
        )
        .toBe(true);
      await expect
        .poll(() => performanceReceiver.revisions.includes(revision), {
          message: 'genuine target action independently observed',
        })
        .toBe(true);
    };
    for (let n = 0; n < 100; n++) await sample();
    const local = (await frameObservations(page)).samples.slice(0, 100);
    // Delay ORIGINAL request entry and ORIGINAL downstream response by 75ms each.
    // Route.fetch bypasses routing recursion and preserves the genuine server response.
    const rtt = async (route: Route) => {
      await delay(75);
      const response = await route.fetch();
      await delay(75);
      await route.fulfill({ response });
    };
    await page.route(pattern, rtt);
    let rttFailure: { value: unknown } | undefined;
    try {
      for (let n = 0; n < 100; n++) await sample();
    } catch (value) {
      rttFailure = { value };
    } finally {
      try {
        await page.unrouteAll({ behavior: 'wait' });
      } catch (value) {
        rttFailure ??= { value };
      }
    }
    if (rttFailure) throw rttFailure.value;
    const injected = (await frameObservations(page)).samples.slice(100, 200);
    // Observe the next genuine scheduled lease on the SAME original second Page.
    // No manual detach/reopen, retry, TTL extension or fabricated viewer occurs.
    const freshResponse = await retainSetup(
      originalSecond.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/browser/viewers/issue' &&
          response.request().method() === 'POST'
      )
    );
    expect(freshResponse.status()).toBe(200);
    const freshViewer = leases.record('secondary', (await freshResponse.json()).viewer);
    secondViewerId = freshViewer.viewerId;
    expect(freshViewer.binding).toEqual(local[0]!.receipt.binding);
    await originalSecond.route(pattern, stall);
    await expect.poll(() => heldResponse).toBe(true);
    for (let n = 0; n < 100; n++) await sample();
    // Intentional original response-stall duration, not an element-readiness delay.
    // Fast native rendering must not exhaust the sample bank before the genuine ten-second hold.
    await delay(Math.max(0, 10_000 - (Date.now() - stalledAt)));
    const readQueue = async () =>
      parseOriginalFrameQueue(JSON.parse(await readFile(queuePath, 'utf8')));
    // Periodic private samples need an actual post-ten-second observation from BOTH
    // original roles; a timer ending between one-second ticks is not evidence of coverage.
    await expect
      .poll(
        async () => {
          const actual = await readQueue();
          return (['primary', 'secondary'] as const).every((role) =>
            actual.some(
              (sample) =>
                sample.at >= stalledAt + 10_000 &&
                !sample.closed &&
                leases.role(sample.viewerId, sample.binding) === role
            )
          );
        },
        { message: 'both original roles actually observed after the full stall' }
      )
      .toBe(true);
    const elapsed = Date.now() - stalledAt;
    expect(elapsed).toBeGreaterThanOrEqual(10_000);
    expect(
      Date.now(),
      'original held lease survives through the entire measured stall'
    ).toBeLessThan(stalledLeaseExpiresAt - 1000);
    for (const result of await Promise.allSettled(setupOriginals))
      if (result.status === 'rejected') first ??= { value: result.reason };
    if (first) throw first.value;
    const bank = { samples: await readQueue() };
    const windowSamples = bank.samples.filter(
      (s) => s.at >= stalledAt && s.at <= stalledAt + elapsed
    );
    expect(windowSamples.length).toBeGreaterThanOrEqual(2);
    const roles = new Set(windowSamples.map((s) => leases.role(s.viewerId, s.binding)));
    expect(roles).toEqual(new Set(['primary', 'secondary']));
    for (const role of roles) {
      const actual = windowSamples.filter(
        (s) => leases.role(s.viewerId, s.binding) === role && !s.closed
      );
      const times = actual.map((s) => s.at);
      expect(times.length).toBeGreaterThan(0);
      expect(actual.some((sample) => sample.encodingMs !== null)).toBe(true);
      expect(Math.min(...times)).toBeLessThanOrEqual(stalledAt + 1000);
      expect(Math.max(...times)).toBeGreaterThanOrEqual(stalledAt + 10_000);
      if (role === 'secondary')
        expect(new Set(actual.map((s) => s.viewerId))).toEqual(new Set([secondViewerId]));
    }
    const originalBinding = local[0]!.receipt.binding;
    for (const s of windowSamples) {
      for (const key of [
        'browserId',
        'browserGeneration',
        'tabId',
        'navigationGeneration',
        'viewportVersion',
        'epoch',
        'inputGeneration',
      ] as const)
        expect(s.binding[key], 'original canonical tab/control scope').toBe(originalBinding[key]);
      expect(s.pendingFrames).toBeLessThanOrEqual(1);
      expect(s.pendingFrames).toBeGreaterThanOrEqual(0);
      expect(s.pendingBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(s.pendingBytes).toBeGreaterThanOrEqual(0);
      if (s.encodingMs === null) {
        // A genuine fresh lease has no encoder observation until its first capture.
        // Retain that row; it cannot count as an encoding measurement.
        expect(s.pendingFrames).toBe(0);
        expect(s.pendingBytes).toBe(0);
      } else expect(Number.isFinite(s.encodingMs) && s.encodingMs >= 0).toBe(true);
      expect(Number.isInteger(s.droppedFrames) && s.droppedFrames >= 0).toBe(true);
    }
    const observation = await frameObservations(page);
    expect(observation.overflow).toBe(false);
    const slow = observation.samples.slice(200);
    const report = {
      local,
      injected150msRTT: injected,
      activeWithStalledViewer: slow,
      stallMs: elapsed,
      bank: windowSamples,
      actualDraws: observation.drawn,
      actualDecodes: observation.decoded,
      actualReceipts: observation.receipts,
      bytes: observation.bytes,
      p95: {
        local: p95(local.map((s) => s.visibleAt - s.inputAt)),
        injected: p95(injected.map((s) => s.visibleAt - s.inputAt)),
        stalled: p95(slow.map((s) => s.visibleAt - s.inputAt)),
      },
      secondViewerId,
      originalViewerLeases: leases.originals(),
      actualTunnel: 'unverified',
    };
    await info.attach('genuine-frame-performance', {
      body: Buffer.from(JSON.stringify(report)),
      contentType: 'application/json',
    });
    expect(report.p95.local).toBeLessThan(250);
    expect(report.p95.injected).toBeLessThan(600);
    expect(report.p95.stalled).toBeLessThan(250);
    expect(report.bytes).toBeGreaterThan(0);
    await channel.write('active', { frames: report.actualDraws, bytes: report.bytes, report });
    // Keep both original browsers and the actual viewers alive through the parent's final counters.
    await channel.wait('release');
  } catch (value) {
    first ??= { value };
  } finally {
    page.off('response', primaryIssuance);
    second?.off('response', secondaryIssuance);
    release();
    try {
      await joinOriginalFrameLeaseSetup({
        first,
        originals: setupOriginals,
        closePrimary: () => page.close(),
        unrouteSecondary: async () => second?.unrouteAll({ behavior: 'wait' }),
        closeSecondary: async () => second?.close(),
      });
    } catch (value) {
      first ??= { value };
    }
  }
  if (first) throw first.value;
  await view.closeSaved(label);
});
