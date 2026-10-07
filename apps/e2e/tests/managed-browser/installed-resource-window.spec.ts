import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import {
  BrowserProductionOpenReceiptSchema,
  BrowserRenderReceiptSchema,
  BrowserViewerSchema,
} from '@dorkos/shared/browser-schemas';
import { createOriginalFrameChannel } from '../../../server/src/services/browser/runtime/__tests__/private-frame-channel.fixture';
import {
  parseOriginalResourceReady,
  originalResourceViewerInterval,
} from '../../../server/src/services/browser/runtime/__tests__/private-resource-evidence.fixture';
import { test, expect } from '../../fixtures/managed-performance-receiver';
import {
  OriginalFrameLeaseBank,
  parseOriginalFrameQueue,
} from '../../fixtures/managed-frame-lease-bank';
import { ManagedBrowserPage } from '../../pages/ManagedBrowserPage';
import {
  armFrameSample,
  frameObservations,
  installFrameObserver,
} from '../../fixtures/managed-frame-observer';

// Both actual target pages use the existing controlled revision receiver. No injected RTT,
// artificial viewer stall, latency percentile, model turn or network ACK substitutes rendering.
test('Two original browsers and drawn viewers: separate idle and active resource window @managed-native', async ({
  page,
  context,
  settingsPage,
  performanceReceiver,
}, info) => {
  const directory = process.env.DORKOS_MANAGED_FRAME_PARENT_DIR;
  const queuePath = process.env.DORKOS_MANAGED_QUEUE_OBSERVATIONS;
  const workspace = process.env.DORKOS_MANAGED_UI_WORKSPACE;
  if (!directory || !queuePath || !workspace)
    throw new Error('RESOURCE_ORIGINAL_PARENT_OBSERVERS_REQUIRED');
  const channel = await createOriginalFrameChannel(directory, new AbortController().signal);
  const second = await context.newPage();
  const pages = [page, second] as const;
  const draws: Array<ReturnType<typeof BrowserRenderReceiptSchema.parse>> = [];
  const pageDraws = pages.map(() => [] as typeof draws);
  const leases = new OriginalFrameLeaseBank();
  const pageLeases = pages.map(
    () => [] as Array<{ viewer: ReturnType<typeof BrowserViewerSchema.parse>; observedAt: number }>
  );
  const listeners = pages.map((original, index) => {
    const listen = (request: import('@playwright/test').Request) => {
      if (
        new URL(request.url()).pathname !== '/api/browser/viewers/next' ||
        request.method() !== 'POST'
      )
        return;
      try {
        const parsed = BrowserRenderReceiptSchema.safeParse(request.postDataJSON()?.receipt);
        if (parsed.success) {
          if (draws.length >= 4096) throw new Error('RESOURCE_ORIGINAL_DRAW_BOUND');
          draws.push(parsed.data);
          pageDraws[index]!.push(parsed.data);
        }
      } catch (value) {
        first ??= { value };
      }
    };
    original.on('request', listen);
    return listen;
  });
  const originals: Promise<unknown>[] = [];
  const own = <T>(work: Promise<T>): Promise<T> => {
    originals.push(work);
    void work.catch((value) => {
      first ??= { value };
    });
    return work;
  };
  let first: { value: unknown } | undefined;
  const issuanceJobs = new Set<Promise<void>>();
  const issuanceListeners = pages.map((original, index) => {
    const listener = (response: import('@playwright/test').Response) => {
      if (
        new URL(response.url()).pathname !== '/api/browser/viewers/issue' ||
        response.request().method() !== 'POST' ||
        response.status() !== 200
      )
        return;
      const job = own(
        (async () => {
          const observedAt = Date.now();
          const body = await response.json();
          const viewer = leases.record(index === 0 ? 'primary' : 'secondary', body.viewer);
          const rows = pageLeases[index]!;
          const prior = rows.find((row) => row.viewer.viewerId === viewer.viewerId);
          if (!prior) rows.push({ viewer, observedAt });
        })()
      );
      issuanceJobs.add(job);
      void job.then(
        () => issuanceJobs.delete(job),
        () => issuanceJobs.delete(job)
      );
    };
    original.on('response', listener);
    return listener;
  });
  try {
    await Promise.all(pages.map((original) => own(installFrameObserver(original))));
    await page.goto('/');
    await settingsPage.open();
    await settingsPage.switchTab('Experiments');
    const toggle = settingsPage.activePanel.getByRole('switch', {
      name: 'Shared browser',
      exact: true,
    });
    await expect(toggle).not.toBeChecked();
    const enabling = own(
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/browser/runtime/enable' &&
          r.request().method() === 'POST'
      )
    );
    await toggle.click();
    const enabled = await enabling;
    expect(enabled.status()).toBe(200);
    const status = await enabled.json();
    if (status.state !== 'qualification')
      throw new Error('ORIGINAL_BROWSER_QUALIFICATION_REQUIRED');
    expect(status.state).toBe('qualification');
    expect(status.readiness).toBe('unverified');
    expect(
      status.workspaces.some((w: { workspaceId: string }) => w.workspaceId === workspace)
    ).toBe(true);
    await settingsPage.close();
    const savedView = new ManagedBrowserPage(page),
      cleanView = new ManagedBrowserPage(second);
    await savedView.goto();
    await savedView.createSaved(`Resource acceptance ${info.testId}`, workspace);
    const savedOpening = own(
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/browser/runtime/open' &&
          r.request().method() === 'POST'
      )
    );
    await savedView.openSaved();
    const savedResponse = await savedOpening;
    expect(savedResponse.status()).toBe(200);
    const saved = BrowserProductionOpenReceiptSchema.parse(await savedResponse.json());
    await savedView.navigateLocal(performanceReceiver.url);
    await cleanView.goto();
    await second.getByLabel('Workspace', { exact: true }).selectOption(workspace);
    await second.getByLabel('Browser', { exact: true }).selectOption('ephemeral');
    const cleanOpening = own(
      second.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/browser/runtime/open' &&
          r.request().method() === 'POST'
      )
    );
    await second.getByRole('button', { name: 'Open clean browser', exact: true }).click();
    const cleanResponse = await cleanOpening;
    expect(cleanResponse.status()).toBe(200);
    const clean = BrowserProductionOpenReceiptSchema.parse(await cleanResponse.json());
    await expect(second.getByRole('button', { name: 'Take control', exact: true })).toBeEnabled();
    await second.getByRole('button', { name: 'Take control', exact: true }).click();
    await cleanView.navigateLocal(performanceReceiver.url);
    const views = [savedView, cleanView] as const;
    // A real no-op pointer input arms the existing outer observer; the unchanged revision
    // must be decoded, drawn and still visible across two actual animation frames.
    for (let n = 0; n < 2; n++) {
      await pages[n]!.bringToFront();
      await armFrameSample(pages[n]!, 0);
      await views[n]!.point(1200, 650, 1280, 720, true);
      await expect
        .poll(async () =>
          (await frameObservations(pages[n]!)).samples.some((s) => s.revision === 0)
        )
        .toBe(true);
    }
    const subject = async (original: Page, open: typeof saved) => {
      const observation = await frameObservations(original);
      expect(observation.overflow).toBe(false);
      const sample = observation.samples.at(-1);
      const drawn =
        sample &&
        draws.find(
          (d) =>
            d.viewerId === sample.receipt.viewerId &&
            d.frameId === sample.receipt.frameId &&
            d.sequence === sample.receipt.sequence
        );
      if (
        !drawn ||
        leases.role(drawn.viewerId, drawn.binding) !== (original === page ? 'primary' : 'secondary')
      )
        throw new Error('RESOURCE_ORIGINAL_DECODED_DRAW_RECEIPT_REQUIRED');
      return {
        open,
        drawn,
        decoded: observation.decoded,
        draws: observation.drawn,
        bytes: observation.bytes,
      };
    };
    const ready = parseOriginalResourceReady({
      subjects: [await subject(page, saved), await subject(second, clean)],
    });
    const snapshot = async () => {
      await Promise.all([...issuanceJobs]);
      const viewers = [];
      for (let n = 0; n < pages.length; n++) {
        const original = pages[n]!;
        const o = await frameObservations(original),
          last = pageDraws[n]!.at(-1);
        if (first) throw first.value;
        if (
          o.overflow ||
          !last ||
          leases.role(last.viewerId, last.binding) !== (n === 0 ? 'primary' : 'secondary')
        )
          throw new Error('RESOURCE_ORIGINAL_FRAME_OBSERVER_UNAVAILABLE');
        viewers.push({
          viewerId: last.viewerId,
          binding: last.binding,
          leases: pageLeases[n]!.filter((row) =>
            Object.keys(last.binding).every(
              (key) => Reflect.get(row.viewer.binding, key) === Reflect.get(last.binding, key)
            )
          ),
          decoded: o.decoded,
          draws: o.drawn,
          receipts: o.receipts,
          bytes: o.bytes,
        });
      }
      return { at: Date.now(), viewers };
    };
    const idleBefore = await snapshot();
    // No control or target activity is injected in the parent's recorded idle window.
    await channel.write('ready', { ...ready, idleBefore });
    await channel.wait('start');
    const idleAfter = await snapshot();
    const activeBefore = await snapshot();
    const begin = performance.now();
    let revision = 0;
    do {
      if (++revision > 200) throw new Error('RESOURCE_ACTIVE_ORIGINAL_REVISION_BOUND');
      for (let n = 0; n < 2; n++) {
        await pages[n]!.bringToFront();
        await armFrameSample(pages[n]!, revision);
        await views[n]!.point(800, 400, 1280, 720, true);
        await expect
          .poll(async () =>
            (await frameObservations(pages[n]!)).samples.some((s) => s.revision === revision)
          )
          .toBe(true);
      }
    } while (performance.now() - begin < 10_000);
    // This is an actual observation duration, never an element-readiness delay.
    const activeAfter = await snapshot();
    const raw = await readFile(queuePath);
    if (raw.byteLength > 4 * 1024 * 1024) throw new Error('RESOURCE_ORIGINAL_QUEUE_FILE_BOUND');
    const samples = parseOriginalFrameQueue(JSON.parse(raw.toString('utf8')));
    const idle = originalResourceViewerInterval(ready, idleBefore, idleAfter, samples, false);
    const active = originalResourceViewerInterval(ready, activeBefore, activeAfter, samples, true);
    const report = {
      schema: 1,
      scope: 'P8.8 separate resource window',
      idle,
      active,
      latency: 'UNRUN',
      tunnel: 'UNRUN',
      handoff: 'UNRUN',
      additionalSlotsAdmitted: 0,
    };
    await info.attach('genuine-resource-viewers', {
      body: Buffer.from(JSON.stringify(report)),
      contentType: 'application/json',
    });
    await channel.write('active', {
      frames: active.frames,
      bytes: active.bytes,
      idleBefore,
      idleAfter,
      activeBefore,
      activeAfter,
      report,
    });
    // Both actual browsers and subscriptions remain live through final parent counters.
    await channel.wait('release');
  } catch (value) {
    first ??= { value };
  } finally {
    // Preserve the original Off fixture on the primary page. Close the second page to
    // release its exact event duties, then join every original retained setup operation.
    try {
      await second.close();
    } catch (value) {
      first ??= { value };
    }
    if (first) {
      try {
        await page.close();
      } catch (value) {
        first ??= { value };
      }
    }
    for (const result of await Promise.allSettled(originals))
      if (result.status === 'rejected') first ??= { value: result.reason };
    pages.forEach((p, n) => {
      p.off('request', listeners[n]!);
      p.off('response', issuanceListeners[n]!);
    });
  }
  if (first) throw first.value;
});
