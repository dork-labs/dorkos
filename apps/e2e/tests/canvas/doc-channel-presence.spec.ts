/** Genuine mounted views and original session socket reconnection, without synthetic frames. */
import {
  test,
  expect,
  type WebSocket as BrowserWebSocket,
  type Response,
  type Page,
} from '@playwright/test';
import { decodeStreamFrame } from '@dorkos/shared/stream-socket';
import {
  CanvasChannelNotificationSchema,
  CanvasChannelPresenceResponseSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import { startIsolatedConsumerHost } from '../../fixtures/doc-channel-consumer/server.js';
import { signInOriginalConsumerHost } from '../../fixtures/doc-channel-consumer/browser-bootstrap.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('counts actual document mounts and leaves across original socket reconnection without agent turns', async ({
  page,
}) => {
  const host = await startIsolatedConsumerHost('session');
  let failed = false,
    first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  let documentId: string | undefined;
  const viewerIds = new Set<string>();
  const responseWork = new Set<Promise<void>>();
  const nativePayloads: string[] = [];
  const active = new Set<BrowserWebSocket>(),
    closed = new Set<BrowserWebSocket>();
  const observers = new Map<
    BrowserWebSocket,
    { owner: Page; frame: (event: { payload: string | Buffer }) => void; close: () => void }
  >();
  const observeResponse = (response: Response) => {
    try {
      const url = new URL(response.url()),
        origin = new URL(host.origin);
      if (
        !documentId ||
        url.host !== origin.host ||
        url.pathname !== '/api/canvas/docs/' + documentId + '/presence' ||
        response.request().method() !== 'POST' ||
        !response.ok()
      )
        return;
      const work = (async () => {
        try {
          viewerIds.add(CanvasChannelPresenceResponseSchema.parse(await response.json()).viewerId);
        } catch (cause) {
          remember(cause);
        }
      })();
      responseWork.add(work);
      void work.then(
        () => responseWork.delete(work),
        (cause) => {
          remember(cause);
          responseWork.delete(work);
        }
      );
    } catch (cause) {
      remember(cause);
    }
  };
  const observeSocket = (owner: Page, socket: BrowserWebSocket) => {
    try {
      const url = new URL(socket.url()),
        origin = new URL(host.origin);
      if (
        url.host !== origin.host ||
        url.pathname !== '/api/sessions/' + host.sessionId + '/events'
      )
        return;
      const frame = (event: { payload: string | Buffer }) => {
        try {
          const decoded = decodeStreamFrame(
            typeof event.payload === 'string' ? event.payload : event.payload.toString('utf8')
          );
          if (!decoded) throw new Error('Original presence session frame unavailable');
          if (decoded.event !== 'canvas_event' && decoded.event !== 'canvas_channel_snapshot')
            return;
          const notification = CanvasChannelNotificationSchema.parse(decoded.data);
          if (
            notification.documentId !== documentId ||
            notification.scope !== 'session:' + host.sessionId
          )
            return;
          if (nativePayloads.length >= 64) throw new Error('Original presence wire audit bound');
          nativePayloads.push(JSON.stringify(notification));
        } catch (cause) {
          remember(cause);
        }
      };
      const close = () => {
        active.delete(socket);
        closed.add(socket);
      };
      observers.set(socket, { owner, frame, close });
      active.add(socket);
      socket.on('framereceived', frame);
      socket.on('close', close);
    } catch (cause) {
      remember(cause);
    }
  };
  const pageSocketObservers = new Map<Page, (socket: BrowserWebSocket) => void>();
  const observePage = (owned: Page) => {
    const observer = (socket: BrowserWebSocket) => observeSocket(owned, socket);
    pageSocketObservers.set(owned, observer);
    owned.on('response', observeResponse);
    owned.on('websocket', observer);
  };
  const releasePage = (owned: Page) => {
    owned.off('response', observeResponse);
    const observer = pageSocketObservers.get(owned);
    if (observer) owned.off('websocket', observer);
    pageSocketObservers.delete(owned);
  };
  let second: Page | undefined;
  observePage(page);
  const show = async (owned: Page, boot: 'fresh-owner' | 'shared-owner') => {
    await owned.goto(
      host.origin + '/session?session=' + host.sessionId + '&dir=' + encodeURIComponent(host.root)
    );
    // Only the first page owns fresh-install login and onboarding. The second
    // page shares that same authenticated context and completed install choices.
    if (boot === 'fresh-owner') {
      await signInOriginalConsumerHost(owned, host);
    }
    if (boot === 'shared-owner') {
      // The first launch answered the higher-priority power question only.
      // This new page has its own one-moment budget and asks the remaining
      // telemetry question after reading the original persisted configuration.
      const consent = owned.getByRole('dialog', {
        name: 'Share anonymous usage data?',
        exact: true,
      });
      await expect(consent).toBeVisible();
      await consent.getByRole('button', { name: 'Don’t share', exact: true }).click();
      await expect(consent).toBeHidden();
    }
    const panel = new RightPanelPage(owned);
    await expect(panel.toggle).toBeVisible();
    await panel.ensureTabStripOpen();
    await panel.canvasTab.click();
    await owned.getByText('Native bound widget', { exact: true }).first().click();
    await expect(owned.locator('input[name="draft"]')).toBeVisible();
    return panel;
  };
  try {
    const opened = await host.openBoundWidget();
    if (typeof opened.documentId !== 'string' || !opened.documentId)
      throw new Error('Original presence widget identity unavailable');
    documentId = opened.documentId;
    const panel = await show(page, 'fresh-owner');
    const count = page.getByRole('status', { name: 'Document views', exact: true });
    await expect(count).toHaveText('1 views');
    second = await page.context().newPage();
    observePage(second);
    const secondPanel = await show(second, 'shared-owner');
    await expect(count).toHaveText('2 views');
    await expect(second.getByRole('status', { name: 'Document views', exact: true })).toHaveText(
      '2 views'
    );
    // This original tab switch actually unmounts CanvasRenderer; it does not close the physical document.
    await secondPanel.pulseTab.click();
    await expect(count).toHaveText('1 views');
    releasePage(second);
    await second.close();
    expect(second.isClosed()).toBe(true);
    // Playwright page retirement need not emit each retained socket's close
    // event. Remove only this positively closed page from the active-owner
    // census; the independent wire-close set remains actual close events only.
    for (const [socket, observer] of observers) {
      if (observer.owner === second) active.delete(socket);
    }
    second = undefined;
    await expect.poll(() => active.size).toBe(1);
    const original = [...active][0];
    if (!original) throw new Error('Original mounted presence socket unavailable');
    const before = await host.readOriginalPresenceData();
    expect(before.events.filter((event) => event.type === 'host.opened')).toHaveLength(2);
    expect(before.batches).toBe(0);
    expect(before.admissions).toBe(0);
    // Fixed original widget action is required before its one-use owned socket interruption.
    await host.patchBoundWidget();
    await expect(page.getByText('Native state arrived', { exact: true })).toBeVisible();
    expect(await host.disconnectBoundWidgetStream()).toMatchObject({
      socketCount: 1,
      closed: true,
    });
    await expect.poll(() => closed.has(original)).toBe(true);
    await expect.poll(() => [...active].some((socket) => socket !== original)).toBe(true);
    await expect(count).toHaveText('1 views');
    const reconnected = await host.readOriginalPresenceData();
    expect(reconnected.events.filter((event) => event.type === 'host.opened')).toHaveLength(2);
    expect(reconnected.batches).toBe(0);
    expect(reconnected.admissions).toBe(0);
    // Removing and mounting the actual host again is a new view; wire reconnect alone was not.
    await panel.pulseTab.click();
    await expect
      .poll(
        async () =>
          (await host.readOriginalPresenceData()).events
            .filter((event) => event.type === 'doc.viewers')
            .at(-1)?.payload
      )
      .toEqual({ views: 0 });
    await panel.canvasTab.click();
    await expect(count).toHaveText('1 views');
    await panel.pulseTab.click();
    await expect
      .poll(
        async () =>
          (await host.readOriginalPresenceData()).events
            .filter((event) => event.type === 'doc.viewers')
            .at(-1)?.payload
      )
      .toEqual({ views: 0 });
    const audit = await host.readOriginalPresenceData();
    expect(audit.documentId).toBe(documentId);
    expect(audit.events.filter((event) => event.type === 'host.opened')).toHaveLength(3);
    expect(audit.events.filter((event) => event.type === 'host.closed')).toHaveLength(3);
    expect(
      audit.events.filter((event) => event.type === 'doc.viewers').map((event) => event.payload)
    ).toEqual([{ views: 1 }, { views: 2 }, { views: 1 }, { views: 0 }, { views: 1 }, { views: 0 }]);
    expect(audit.batches).toBe(0);
    expect(audit.admissions).toBe(0);
    await expect.poll(() => responseWork.size).toBe(0);
    expect(viewerIds.size).toBe(3);
    expect(nativePayloads.length).toBeGreaterThan(0);
    for (const id of viewerIds)
      for (const payload of nativePayloads) expect(payload.includes(id)).toBe(false);
    if (failed) throw first;
  } catch (cause) {
    remember(cause);
  }
  releasePage(page);
  if (second) releasePage(second);
  for (const [socket, observer] of observers) {
    socket.off('framereceived', observer.frame);
    socket.off('close', observer.close);
  }
  const attempt = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (cause) {
      remember(cause);
    }
  };
  // Start the owners which can cancel stalled response bodies before joining them.
  // Independent native retirement is attempted even if original page navigation fails.
  const secondPage = second;
  const secondRetirement = secondPage ? attempt(() => secondPage.close()) : Promise.resolve();
  const pageRetirement = attempt(async () => {
    await page.goto('about:blank');
  });
  const hostRetirement = attempt(async () => {
    await host.close();
  });
  await Promise.allSettled([...responseWork, secondRetirement, pageRetirement, hostRetirement]);
  if (failed) throw first;
});
