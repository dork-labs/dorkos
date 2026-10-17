/** Installed SDK browser acceptance; fixtures preserve the original HTTP/receipt authority boundary. */
import { randomUUID } from 'node:crypto';
import type { Request, Route } from '@playwright/test';
import {
  CanvasChannelEventReceiptSchema,
  PageEventSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import { test, expect } from '../../fixtures';
import { RightPanelPage } from '../../pages/RightPanelPage';
import { startDevServer, APP_READY } from '../../pages/canvas-dev-server';
import {
  EVENT,
  actualFrame,
  ready,
  open,
  preserveFailureAndFinish,
  noTurn,
  clickRecord,
  type SdkWindow,
} from './doc-frame-sdk-fixture';

/** Registered inside the maintained browser-driving file; no new project/worker/time/retry policy. */
export function registerDocFrameSdkBrowserTests() {
  test.describe('Installed Doc SDK genuine receipt boundary', () => {
    test('records the page original UUID once through actual HTTP and independently replays its no-turn receipt', async ({
      page,
      request,
    }) => {
      await preserveFailureAndFinish(page, request, async () => {
        const f = await open(page, request);
        const sent = page.waitForRequest(
          (r) =>
            r.method() === 'POST' &&
            new URL(r.url()).pathname === `/api/canvas/docs/${f.documentId}/events`
        );
        void sent.catch(() => {});
        const output = await clickRecord(f.frame);
        const actual = PageEventSchema.parse((await sent).postDataJSON());
        expect(actual).toEqual({ v: 1, id: output.id, type: EVENT, payload: output.payload });
        expect(output.receipt.receipt).toMatchObject({ id: output.id, status: 'recorded' });
        noTurn(output.receipt);
        const saved = await f.receipt(output.id);
        expect(saved.receipt).toEqual(output.receipt.receipt);
        noTurn(saved);
        const events = (await f.channel()).events.filter((row) => row.event.id === output.id);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          docSeq: saved.receipt.docSeq,
          event: { id: output.id, type: EVENT, payload: output.payload },
        });
        const duplicate = CanvasChannelEventReceiptSchema.parse(
          await f.frame.evaluate(async ({ id, payload }) => {
            const sdk = (window as SdkWindow).dorkos?.channel;
            if (!sdk) throw new Error('Installed SDK absent');
            return sdk.emit('fixture.changed', payload, { id });
          }, output)
        );
        expect(duplicate.receipt).toEqual({ ...saved.receipt, status: 'duplicate' });
        noTurn(duplicate);
        expect((await f.channel()).events.filter((row) => row.event.id === output.id)).toHaveLength(
          1
        );
      });
    });

    test('a fresh explicit Reload cannot consume the old frame late committed response', async ({
      page,
      request,
    }) => {
      await preserveFailureAndFinish(page, request, async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let committed!: (id: string) => void;
        const accepted = new Promise<string>((resolve) => {
          committed = resolve;
        });
        const work = new Set<Promise<void>>();
        let failure: unknown;
        let heldOnce = false;
        const pattern = '**/api/canvas/docs/*/events';
        let handler: ((route: Route) => Promise<void>) | undefined;
        try {
          const f = await open(page, request);
          handler = (route) => {
            const pending = (async () => {
              if (
                heldOnce ||
                route.request().method() !== 'POST' ||
                new URL(route.request().url()).pathname !==
                  `/api/canvas/docs/${f.documentId}/events`
              ) {
                await route.continue();
                return;
              }
              heldOnce = true;
              try {
                const input = PageEventSchema.parse(route.request().postDataJSON());
                const response = await route.fetch();
                expect(response.ok()).toBe(true);
                const receipt = CanvasChannelEventReceiptSchema.parse(await response.json());
                expect(receipt.receipt.id).toBe(input.id);
                noTurn(receipt);
                committed(input.id);
                await held;
                // The old frame may have cancelled its request after genuine retirement.
                await route.fulfill({ response }).catch(() => {});
              } catch (cause) {
                failure ??= cause;
                committed('');
                await route.abort().catch(() => {});
              }
            })();
            work.add(pending);
            void pending.finally(() => work.delete(pending));
            return pending;
          };
          await page.route(pattern, handler);
          await f.frame.getByRole('button', { name: 'Record fixture event', exact: true }).click();
          const id = await accepted;
          if (failure) throw failure;
          expect(id).not.toBe('');
          noTurn(await f.receipt(id));
          const oldElement = await page
            .locator('iframe[title="SDK receipt fixture"]')
            .elementHandle();
          await page.getByRole('button', { name: 'Reload', exact: true }).click();
          await expect
            .poll(async () => oldElement?.evaluate((element) => element.isConnected))
            .toBe(false);
          const fresh = await actualFrame(page);
          await ready(fresh);
          expect(fresh).not.toBe(f.frame);
          await expect(
            fresh.getByRole('button', { name: 'Record fixture event', exact: true })
          ).toBeEnabled();
          release();
          await Promise.all([...work]);
          if (failure) throw failure;
          await expect(fresh.locator('#status')).toHaveText('ready');
          const newer = await clickRecord(fresh);
          expect(newer.id).not.toBe(id);
          noTurn(newer.receipt);
          const events = (await f.channel()).events.filter((row) => row.event.type === EVENT);
          expect(events.map((row) => row.event.id).sort()).toEqual([id, newer.id].sort());
        } finally {
          release();
          await Promise.allSettled([...work]);
          if (handler) await page.unroute(pattern, handler);
        }
      });
    });

    test('a real suspended panel retains the old SDK offline until explicit Reload creates a fresh frame', async ({
      page,
      request,
    }) => {
      await preserveFailureAndFinish(page, request, async () => {
        // Hold only a real lazy module request. No module, owner, SDK, event, or receipt is fulfilled.
        const modulePath = '/src/layers/features/local-browser/index.ts';
        const pattern = '**/src/layers/features/local-browser/index.ts*';
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let requested!: () => void;
        const entered = new Promise<void>((resolve) => {
          requested = resolve;
        });
        const work = new Set<Promise<void>>();
        const handler = (route: Route) => {
          if (new URL(route.request().url()).pathname !== modulePath) return route.continue();
          requested();
          const pending = held.then(() => route.continue());
          work.add(pending);
          void pending.then(
            () => work.delete(pending),
            () => work.delete(pending)
          );
          return pending;
        };
        let dispatched = 0;
        const observe = (r: Request) => {
          if (
            r.method() === 'POST' &&
            /\/api\/canvas\/docs\/[^/]+\/events$/.test(new URL(r.url()).pathname)
          )
            dispatched++;
        };
        await page.route(pattern, handler);
        try {
          const f = await open(page, request);
          const recorded = await clickRecord(f.frame);
          noTurn(recorded.receipt);
          const oldElement = await page
            .locator('iframe[title="SDK receipt fixture"]')
            .elementHandle();
          if (!oldElement) throw new Error('Actual managed frame absent');
          const oldWindow = await f.frame.evaluateHandle(() => window);
          page.on('request', observe);
          const panel = new RightPanelPage(page);
          await panel.selectView('Browser');
          await entered;
          // The actual shared React Suspense boundary hides rather than unmounts this old node.
          await expect(page.locator('iframe[title="SDK receipt fixture"]')).toBeHidden();
          expect(await oldElement.evaluate((node) => node.isConnected)).toBe(true);
          expect(await f.frame.evaluate((old) => old === window, oldWindow)).toBe(true);
          await expect
            .poll(() => f.frame.evaluate(() => (window as SdkWindow).dorkos!.channel!.status))
            .toBe('offline');
          await panel.selectView('Page previews');
          await expect(page.locator('iframe[title="SDK receipt fixture"]')).toBeVisible();
          expect(
            await oldElement.evaluate(
              (node) => node === document.querySelector('iframe[title="SDK receipt fixture"]')
            )
          ).toBe(true);
          expect(await f.frame.evaluate((old) => old === window, oldWindow)).toBe(true);
          await expect(
            f.frame.getByRole('button', { name: 'Record fixture event', exact: true })
          ).toBeDisabled();
          await expect(
            page.getByText('Page is offline. Reload to reconnect.', { exact: true })
          ).toBeVisible();
          const refusedId = randomUUID();
          const outcome = await f.frame.evaluate(async (id) => {
            try {
              await (window as SdkWindow).dorkos!.channel!.emit(
                'fixture.changed',
                { text: 'retired frame' },
                { id }
              );
              return 'unexpected acceptance';
            } catch (error) {
              return (error as { outcome?: string }).outcome;
            }
          }, refusedId);
          expect(outcome).toBe('cancelled');
          expect(dispatched).toBe(0);
          expect(
            (await request.get(`/api/canvas/docs/${f.documentId}/events/${refusedId}`)).status()
          ).toBe(404);
          // Reload may destroy the old realm before its asynchronous messages run; no ordering claim is made here.
          await page.getByRole('button', { name: 'Reload', exact: true }).click();
          await expect.poll(() => oldElement.evaluate((node) => node.isConnected)).toBe(false);
          const fresh = await actualFrame(page);
          await ready(fresh);
          expect(fresh).not.toBe(f.frame);
          await expect(
            page.getByText('Page is offline. Reload to reconnect.', { exact: true })
          ).toHaveCount(0);
          const newer = await clickRecord(fresh);
          expect(newer.id).not.toBe(recorded.id);
          noTurn(await f.receipt(newer.id));
          expect(
            (await f.channel()).events
              .filter((row) => row.event.type === EVENT)
              .map((row) => row.event.id)
              .sort()
          ).toEqual([recorded.id, newer.id].sort());
          await oldWindow.dispose();
        } finally {
          page.off('request', observe);
          release();
          await Promise.allSettled([...work]);
          await page.unroute(pattern, handler);
        }
      });
    });

    test('an unowned sibling loads the actual installed SDK but cannot borrow the managed frame source', async ({
      page,
      request,
    }) => {
      await preserveFailureAndFinish(page, request, async () => {
        let dispatched = 0;
        const observe = (r: Request) => {
          if (
            r.method() === 'POST' &&
            /\/api\/canvas\/docs\/[^/]+\/events$/.test(new URL(r.url()).pathname)
          )
            dispatched++;
        };
        try {
          const f = await open(page, request);
          page.on('request', observe);
          const src = await page.locator('iframe[title="SDK receipt fixture"]').getAttribute('src');
          expect(src).toBeTruthy();
          await page.evaluate((source) => {
            const foreign = document.createElement('iframe');
            foreign.dataset.f2Foreign = 'true';
            foreign.sandbox.add('allow-scripts');
            foreign.src = source!;
            document.body.append(foreign);
          }, src);
          const element = await page.locator('iframe[data-f2-foreign]').elementHandle();
          const foreign = await element?.contentFrame();
          if (!foreign) throw new Error('Actual sibling frame absent');
          await expect
            .poll(() =>
              foreign.evaluate(() => (window as SdkWindow).dorkos?.channel?.status ?? 'absent')
            )
            .toBe('offline');
          const id = randomUUID();
          const outcome = await foreign.evaluate(async (id) => {
            try {
              await (window as SdkWindow).dorkos!.channel!.emit(
                'fixture.changed',
                { text: 'foreign' },
                { id }
              );
              return 'unexpected acceptance';
            } catch (error) {
              return (error as { outcome?: string }).outcome;
            }
          }, id);
          expect(outcome).toBe('cancelled');
          expect(dispatched).toBe(0);
          expect(
            (await request.get(`/api/canvas/docs/${f.documentId}/events/${id}`)).status()
          ).toBe(404);
          await ready(f.frame);
          await element!.evaluate((node) => node.remove());
        } finally {
          page.off('request', observe);
        }
      });
    });

    test('a real foreign-origin window cannot obtain a Doc connection or submit through the managed frame', async ({
      page,
      request,
    }) => {
      await preserveFailureAndFinish(page, request, async () => {
        const f = await open(page, request),
          server = await startDevServer();
        let dispatched = 0;
        const observe = (r: Request) => {
          if (
            r.method() === 'POST' &&
            new URL(r.url()).pathname === `/api/canvas/docs/${f.documentId}/events`
          )
            dispatched++;
        };
        page.on('request', observe);
        const marker = randomUUID();
        try {
          await page.evaluate(
            ({ src, marker }) => {
              const reply = (event: MessageEvent) => {
                if (event.data?.f2Barrier === marker && event.source) {
                  (event.source as Window).postMessage({ f2BarrierReply: marker }, event.origin);
                  window.removeEventListener('message', reply);
                }
              };
              window.addEventListener('message', reply);
              const foreign = document.createElement('iframe');
              foreign.dataset.f2WrongOrigin = 'true';
              foreign.src = src;
              document.body.append(foreign);
            },
            { src: `http://localhost:${server.port}/`, marker }
          );
          const element = await page.locator('iframe[data-f2-wrong-origin]').elementHandle();
          const foreign = await element?.contentFrame();
          if (!foreign) throw new Error('Actual foreign-origin window absent');
          await expect(foreign.getByTestId(APP_READY)).toBeVisible();
          expect(await foreign.evaluate(() => location.origin)).not.toBe(
            new URL(page.url()).origin
          );
          const challenges = await foreign.evaluate(async (marker) => {
            let challenges = 0;
            await new Promise<void>((resolve) => {
              const answer = (event: MessageEvent) => {
                if (event.data?.protocol === 'dorkos-doc' && event.data?.kind === 'challenge')
                  challenges++;
                if (event.data?.f2BarrierReply === marker) {
                  window.removeEventListener('message', answer);
                  resolve();
                }
              };
              window.addEventListener('message', answer);
              parent.postMessage({ protocol: 'dorkos-doc', v: 1, kind: 'hello' }, '*');
              // Observer-only event-loop barrier: never an SDK challenge, connection or acceptance.
              parent.postMessage({ f2Barrier: marker }, '*');
            });
            return challenges;
          }, marker);
          expect(challenges).toBe(0);
          expect(dispatched).toBe(0);
          await ready(f.frame);
          await element!.evaluate((node) => node.remove());
          // Real-browser refusal is for the origin/source conjunction. Whole handshake tests isolate origin.
        } finally {
          page.off('request', observe);
          await new Promise<void>((resolve, reject) =>
            server.server.close((error) => (error ? reject(error) : resolve()))
          );
        }
      });
    });

    test('a genuine external no-opt-in page stays displayable without an SDK or event dispatch', async ({
      page,
      request,
    }) => {
      await preserveFailureAndFinish(page, request, async () => {
        let dispatched = 0;
        const url = 'https://f2-no-optin.invalid/fixture';
        const observe = (r: Request) => {
          if (
            r.method() === 'POST' &&
            /\/api\/canvas\/docs\/[^/]+\/events$/.test(new URL(r.url()).pathname)
          )
            dispatched++;
        };
        try {
          await open(page, request);
          page.on('request', observe);
          // Only external content is controlled; no SDK, receipt, HTTP event or approval is fulfilled.
          await page.route(url, (route) =>
            route.fulfill({
              contentType: 'text/html',
              body: '<!doctype html><html><body><h1>Ordinary external page</h1></body></html>',
            })
          );
          await page.getByRole('button', { name: /^Address:/ }).click();
          const address = page.getByRole('textbox', { name: 'Address', exact: true });
          await address.fill(url);
          await address.press('Enter');
          const frame = await actualFrame(page);
          await expect(
            frame.getByRole('heading', { name: 'Ordinary external page' })
          ).toBeVisible();
          expect(
            await frame.evaluate(() => (window as SdkWindow).dorkos?.channel === undefined)
          ).toBe(true);
          expect(dispatched).toBe(0);
        } finally {
          page.off('request', observe);
          await page.unroute(url);
        }
      });
    });
  });
}
