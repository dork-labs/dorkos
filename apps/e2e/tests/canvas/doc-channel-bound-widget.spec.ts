/** Actual mounted widget, native locked TestMode producer and registry MCP state mutation. */
import { test, expect, type WebSocket as BrowserWebSocket } from '@playwright/test';
import { decodeStreamFrame } from '@dorkos/shared/stream-socket';
import {
  CanvasChannelNotificationSchema,
  CanvasChannelEventReceiptSchema,
  CanvasChannelReplayResponseSchema,
  type CanvasChannelEventReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import { startIsolatedConsumerHost } from '../../fixtures/doc-channel-consumer/server.js';
import { signInOriginalConsumerHost } from '../../fixtures/doc-channel-consumer/browser-bootstrap.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';

for (const lifecycle of ['live', 'reconnect-reset-revoke'] as const) {
  test(
    lifecycle === 'live'
      ? 'native state patch updates a bound widget without replacing its draft input'
      : 'bound widget preserves draft, focus, caret and scroll across duplicate patch, reset, reconnect and revocation',
    async ({ page }) => {
      const host = await startIsolatedConsumerHost('session');
      let failed = false,
        first: unknown;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      let observedDocumentId: string | undefined;
      let resetObserved = false,
        networkRestored = false;
      let wireFailed = false,
        wireFailure: unknown;
      const activeSockets = new Set<BrowserWebSocket>();
      const closedSockets = new Set<BrowserWebSocket>();
      let interruptedSockets: Set<BrowserWebSocket> | undefined;
      const socketObservers = new Map<
        BrowserWebSocket,
        {
          frame: (event: { payload: string | Buffer }) => void;
          close: () => void;
        }
      >();
      const observeSocket = (socket: BrowserWebSocket) => {
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
              if (!decoded) throw new Error('Original session wire frame unavailable');
              if (decoded.event !== 'canvas_channel_snapshot') return;
              const notification = CanvasChannelNotificationSchema.parse(decoded.data);
              if (
                notification.type !== 'canvas_channel_snapshot' ||
                notification.documentId !== observedDocumentId ||
                notification.scope !== 'session:' + host.sessionId
              )
                return;
              const snapshot = notification.snapshot;
              if (
                networkRestored &&
                interruptedSockets?.size === 1 &&
                !interruptedSockets.has(socket) &&
                [...interruptedSockets].every((old) => closedSockets.has(old)) &&
                snapshot.resetRequired &&
                snapshot.stateRev === 2 &&
                snapshot.state.message === 'Native state after reconnect'
              )
                resetObserved = true;
            } catch (cause) {
              if (!wireFailed) {
                wireFailed = true;
                wireFailure = cause;
                remember(cause);
              }
            }
          };
          const close = () => {
            closedSockets.add(socket);
            activeSockets.delete(socket);
          };
          socketObservers.set(socket, { frame, close });
          activeSockets.add(socket);
          socket.on('framereceived', frame);
          socket.on('close', close);
        } catch (cause) {
          if (!wireFailed) {
            wireFailed = true;
            wireFailure = cause;
            remember(cause);
          }
        }
      };
      try {
        const opened = await host.openBoundWidget();
        if (typeof opened.documentId !== 'string' || !opened.documentId)
          throw new Error('Original opened widget document identity unavailable');
        observedDocumentId = opened.documentId;
        if (lifecycle === 'reconnect-reset-revoke') page.on('websocket', observeSocket);
        expect(opened.stateRev).toBe(0);
        await page.goto(
          host.origin +
            '/session?session=' +
            host.sessionId +
            '&dir=' +
            encodeURIComponent(host.root)
        );
        await signInOriginalConsumerHost(page, host);
        const panel = new RightPanelPage(page);
        await panel.ensureTabStripOpen();
        await panel.canvasTab.click();
        await page.getByText('Native bound widget', { exact: true }).first().click();
        const input = page.getByRole('textbox', { name: 'Native widget draft' });
        await expect(input).toBeVisible();
        await expect(
          page.getByText('Cannot show text: its state value is missing or has the wrong type.', {
            exact: true,
          })
        ).toBeVisible();
        await input.fill('My unchanged draft');
        await input.focus();
        const mounted = await input.elementHandle();
        if (!mounted) throw new Error('Mounted widget input unavailable');
        const before = await mounted.evaluate((node: HTMLInputElement) => {
          node.setSelectionRange(3, 8);
          let parent = node.parentElement;
          for (let i = 0; parent && i < 32; i++, parent = parent.parentElement) {
            if (parent.scrollHeight > parent.clientHeight + 40) {
              parent.scrollTop = 40;
              break;
            }
          }
          if (!parent || parent.scrollTop === 0)
            throw new Error('Actual widget scroll container unavailable');
          return {
            selectionStart: node.selectionStart,
            selectionEnd: node.selectionEnd,
            scrollTop: parent.scrollTop,
          };
        });
        const result = await host.patchBoundWidget();
        expect(result.stateRev).toBe(1);
        expect(result.duplicateReceipt).toMatchObject({
          stateRev: 1,
          receipt: { status: 'duplicate' },
        });
        await expect(page.getByText('Native state arrived', { exact: true })).toBeVisible();
        await expect(input).toHaveValue('My unchanged draft');
        await expect(input).toBeFocused();
        expect(
          await mounted.evaluate((node: HTMLInputElement) => {
            let parent = node.parentElement;
            for (let i = 0; parent && i < 32; i++, parent = parent.parentElement) {
              if (parent.scrollHeight > parent.clientHeight + 40) break;
            }
            return {
              connected: node.isConnected,
              same: node === document.querySelector('input[name="draft"]'),
              selectionStart: node.selectionStart,
              selectionEnd: node.selectionEnd,
              scrollTop: parent?.scrollTop,
            };
          })
        ).toEqual({ connected: true, same: true, ...before });
        if (lifecycle === 'reconnect-reset-revoke') {
          const action = page.getByRole('button', { name: 'Native widget action', exact: true });
          await expect(action).not.toHaveAttribute('aria-disabled', 'true');
          if (wireFailed) throw wireFailure;
          expect(activeSockets.size).toBe(1); // Positive original session connection before interruption.
          const oldSockets = [...activeSockets];
          interruptedSockets = new Set(oldSockets);
          try {
            // Offline blocks reconnection, but Chromium may retain an established
            // WebSocket. Close only the original owned session socket, then require
            // the browser's actual old-close event before mutating native state.
            await page.context().setOffline(true);
            expect(await host.disconnectBoundWidgetStream()).toEqual({
              socketCount: 1,
              closed: true,
            });
            await expect
              .poll(() => {
                if (wireFailed) throw wireFailure;
                return oldSockets.every((socket) => closedSockets.has(socket));
              })
              .toBe(true);
            const second = await host.patchNextBoundWidget();
            expect(second.stateRev).toBe(2);
            expect(second.duplicateReceipt).toMatchObject({
              stateRev: 2,
              receipt: { status: 'duplicate' },
            });
            const reset = await host.resetBoundWidgetHistory();
            expect(reset).toMatchObject({ stateRev: 2, resetRequired: true });
            await expect(page.getByText('Native state arrived', { exact: true })).toBeVisible();
            networkRestored = true;
            await page.context().setOffline(false);
            await expect
              .poll(() => {
                if (wireFailed) throw wireFailure;
                return resetObserved;
              })
              .toBe(true);
            await expect(
              page.getByText('Native state after reconnect', { exact: true })
            ).toBeVisible();
            const revoked = await host.revokeBoundWidgetGrant();
            expect(revoked).toMatchObject({ stateRev: 2, enabled: false });
            await expect(action).toHaveAttribute('aria-disabled', 'true');
            await expect(input).toHaveValue('My unchanged draft');
            await expect(input).toBeFocused();
            expect(
              await mounted.evaluate((node: HTMLInputElement) => {
                let parent = node.parentElement;
                for (let i = 0; parent && i < 32; i++, parent = parent.parentElement) {
                  if (parent.scrollHeight > parent.clientHeight + 40) break;
                }
                return {
                  connected: node.isConnected,
                  same: node === document.querySelector('input[name="draft"]'),
                  selectionStart: node.selectionStart,
                  selectionEnd: node.selectionEnd,
                  scrollTop: parent?.scrollTop,
                };
              })
            ).toEqual({ connected: true, same: true, ...before });
          } catch (cause) {
            remember(cause);
          } finally {
            try {
              await page.context().setOffline(false);
            } catch (cause) {
              remember(cause);
            }
          }
        }
        const response = await page.request.get(
          host.origin + '/api/canvas/docs/' + opened.documentId + '/channel'
        );
        expect(response.ok()).toBe(true);
        const replay = await response.json();
        expect(replay.stateRev).toBe(lifecycle === 'live' ? 1 : 2);
        expect(replay.state.message).toBe(
          lifecycle === 'live' ? 'Native state arrived' : 'Native state after reconnect'
        );
        if (lifecycle === 'live')
          expect(
            replay.events.filter(
              (frame: { event: { type: string } }) => frame.event.type === 'state.changed'
            )
          ).toHaveLength(1);
        else {
          expect(replay.resetRequired).toBe(true);
          expect(replay.routing.enabled).toBe(false);
        }
      } catch (cause) {
        remember(cause);
      }
      page.off('websocket', observeSocket);
      for (const [socket, observer] of socketObservers) {
        socket.off('framereceived', observer.frame);
        socket.off('close', observer.close);
      }
      try {
        await page.goto('about:blank');
      } catch (cause) {
        remember(cause);
      }
      try {
        await host.close();
      } catch (cause) {
        remember(cause);
      }
      if (failed) throw first;
    }
  );
}

/** Native acceptance is separate from the already-qualified downstream state lifecycle. */
test('native widget keyboard clicks retain distinct durable accepted event identities', async ({
  page,
}) => {
  const host = await startIsolatedConsumerHost('session');
  let failed = false;
  let first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const responsePeers: Promise<unknown>[] = [];
  try {
    const opened = await host.openBoundWidget();
    if (typeof opened.documentId !== 'string' || !opened.documentId)
      throw new Error('Original opened widget document identity unavailable');
    const documentId = opened.documentId;
    await page.goto(
      host.origin + '/session?session=' + host.sessionId + '&dir=' + encodeURIComponent(host.root)
    );
    await signInOriginalConsumerHost(page, host);
    const panel = new RightPanelPage(page);
    await panel.ensureTabStripOpen();
    await panel.canvasTab.click();
    await page.getByText('Native bound widget', { exact: true }).first().click();
    const action = page.getByRole('button', { name: 'Native widget action', exact: true });
    await expect(action).not.toHaveAttribute('aria-disabled', 'true');
    const receipts: CanvasChannelEventReceipt[] = [];
    for (let click = 0; click < 2; click++) {
      const responseWork = page
        .waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            response.url() === host.origin + '/api/canvas/docs/' + documentId + '/events'
        )
        .catch((cause: unknown) => {
          remember(cause);
          return undefined;
        });
      responsePeers.push(responseWork);
      await action.focus();
      await expect(action).toBeFocused();
      await action.press('Enter');
      const response = await responseWork;
      if (!response) throw first;
      expect(response.status()).toBe(201);
      const receipt = CanvasChannelEventReceiptSchema.parse(await response.json());
      expect(receipt.receipt.status).toBe('recorded');
      expect(receipt.deliveries).toHaveLength(1);
      expect(receipt.deliveries[0]).toMatchObject({
        eventId: receipt.receipt.id,
        routeId: 'widget',
      });
      const row = page.locator(
        '[data-testid="widget-action-status"][data-event-id="' + receipt.receipt.id + '"]'
      );
      await expect(row).toContainText('Saved');
      await expect(action).toBeEnabled();
      receipts.push(receipt);
    }
    expect(receipts[0].receipt.id).not.toBe(receipts[1].receipt.id);
    await expect(page.getByTestId('widget-action-status')).toHaveCount(2);
    const response = await page.request.get(
      host.origin + '/api/canvas/docs/' + documentId + '/channel'
    );
    expect(response.ok()).toBe(true);
    const replay = CanvasChannelReplayResponseSchema.parse(await response.json());
    const inputs = replay.events.filter((frame) => frame.event.type === 'task.changed');
    expect(inputs).toHaveLength(2);
    expect(inputs.map((frame) => frame.event.id)).toEqual(
      receipts.map((receipt) => receipt.receipt.id)
    );
    for (const frame of inputs) {
      expect(frame.event.payload).toMatchObject({
        widget: { documentId, title: 'Native bound widget' },
      });
      expect(frame.docSeq).toBe(
        receipts.find((receipt) => receipt.receipt.id === frame.event.id)?.receipt.docSeq
      );
    }
    // These are recorded inputs/delivery receipts; no runtime FIRST or application handling is inferred.
  } catch (cause) {
    remember(cause);
  }
  const attempt = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (cause) {
      remember(cause);
    }
  };
  await Promise.allSettled([attempt(() => page.goto('about:blank')), attempt(() => host.close())]);
  await Promise.allSettled(responsePeers);
  if (failed) throw first;
});
