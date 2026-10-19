/**
 * A served page's frame is sandboxed without `allow-same-origin`, so every
 * document it ever holds — an outside site included — is origin `null` in the
 * same window. These prove, in a real browser, that a document the frame
 * reached by itself never gets the agent's port: only the one DorkOS navigated
 * to, carrying its boot nonce, does.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Frame, Page, Request, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';
import {
  actualFrame,
  ready,
  open,
  preserveFailureAndFinish,
  clickRecord,
  noTurn,
} from './doc-frame-sdk-fixture';

const OFFLINE = 'Page is offline. Reload to reconnect.';

/**
 * An outside page that does everything a hostile one could: answers any
 * challenge with no nonce, a guessed one, and ANY boot nonce it can find in its
 * own URL (query or fragment, which is where a redirect would carry one), uses
 * any port it is handed, and records every Doc message it was sent.
 */
const ECHO_PAGE = `<!doctype html><html><head><title>Outside</title></head><body>
<h1>Outside page</h1>
<script>
const seen = [];
const bootIn = (part) => {
  const found = /(?:^|[?#&])dorkos-boot=([^&#]*)/.exec(part);
  return found ? decodeURIComponent(found[1]) : null;
};
const boots = [bootIn(location.search), bootIn(location.hash)].filter(Boolean);
addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.protocol !== 'dorkos-doc') return;
  seen.push(data.kind);
  if (data.kind === 'challenge') {
    parent.postMessage({ ...data, kind: 'ack' }, '*');
    parent.postMessage({ ...data, kind: 'ack', boot: 'guessed-boot-nonce' }, '*');
    for (const boot of boots) parent.postMessage({ ...data, kind: 'ack', boot }, '*');
  }
  if (data.kind === 'connect' && event.ports[0]) {
    const id = '00000000-0000-4000-8000-0000000000ee';
    const { protocol, v, nonce, requestToken, loadToken, generation } = data;
    event.ports[0].postMessage({ protocol, v, nonce, requestToken, loadToken, generation,
      kind: 'emit', requestId: id, event: { v: 1, id, type: 'fixture.changed', payload: { text: 'outside' } } });
  }
});
window.__echo = {
  seen,
  boots,
  // Ordered after anything the host already posted here: same sender, same target.
  barrier(marker) {
    return new Promise((resolve) => {
      addEventListener('message', function reply(event) {
        if (event.data && event.data.echoBarrierReply === marker) {
          removeEventListener('message', reply);
          resolve(seen.slice());
        }
      });
      parent.postMessage({ echoBarrier: marker }, '*');
    });
  },
};
</script></body></html>`;

type EchoWindow = Window & {
  __echo: { seen: string[]; boots: string[]; barrier(marker: string): Promise<string[]> };
};

/** Another site on its own port: `/echo` (any method) and `/redirect` to it. */
async function startOutsideSite(): Promise<{ origin: string; server: Server }> {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/echo' }).end();
      return;
    }
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(ECHO_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://localhost:${(server.address() as AddressInfo).port}`, server };
}

/** The host page answers the outside page's barrier, so absence can be asserted. */
async function answerBarriers(page: Page) {
  await page.evaluate(() => {
    window.addEventListener('message', (event) => {
      const marker = (event.data as { echoBarrier?: unknown } | null)?.echoBarrier;
      if (typeof marker === 'string' && event.source)
        (event.source as Window).postMessage({ echoBarrierReply: marker }, '*');
    });
  });
}

/** Wait for the outside page in `frame`, then read what the host sent it. */
async function outsideSaw(frame: Frame): Promise<string[]> {
  await expect(frame.getByRole('heading', { name: 'Outside page', exact: true })).toBeVisible();
  return frame.evaluate(
    (marker) => (window as unknown as EchoWindow).__echo.barrier(marker),
    randomUUID()
  );
}

/** Count every page event the browser posts to any document. */
function countEventPosts(page: Page) {
  const counter = { posted: 0 };
  const observe = (r: Request) => {
    if (
      r.method() === 'POST' &&
      /\/api\/canvas\/docs\/[^/]+\/events$/.test(new URL(r.url()).pathname)
    )
      counter.posted++;
  };
  page.on('request', observe);
  return { counter, stop: () => page.off('request', observe) };
}

/** Registered inside the browser-driving spec, on its test-mode project. */
export function registerDocFrameOutsideBrowserTests() {
  test.describe('Page channel — a served frame that leaves DorkOS', () => {
    test('a connected served page that follows a link, sets location or posts a form to another site never connects it', async ({
      page,
      request,
    }) => {
      const outside = await startOutsideSite();
      const events = countEventPosts(page);
      try {
        await preserveFailureAndFinish(page, request, async () => {
          const f = await open(page, request);
          noTurn((await clickRecord(f.frame)).receipt);
          await answerBarriers(page);
          const ways: Record<string, (frame: Frame, url: string) => Promise<void>> = {
            'a link click': async (frame, url) => {
              await frame.evaluate((href) => {
                const link = document.createElement('a');
                link.href = href;
                link.textContent = 'Leave for the outside page';
                document.body.append(link);
              }, url);
              await frame.getByRole('link', { name: 'Leave for the outside page' }).click();
            },
            'window.location': async (frame, url) => {
              await frame.evaluate((href) => {
                window.location.href = href;
              }, url);
            },
            'a form post': async (frame, url) => {
              await frame.evaluate((action) => {
                const form = document.createElement('form');
                form.method = 'post';
                form.action = action;
                document.body.append(form);
                form.submit();
              }, url);
            },
          };
          let frame = f.frame;
          for (const [way, leave] of Object.entries(ways)) {
            await leave(frame, `${outside.origin}/echo`);
            const seen = await outsideSaw(frame);
            // Not even challenged: the frame's later documents never hold the nonce.
            expect(seen, way).toEqual([]);
            expect(events.counter.posted, way).toBe(1);
            await expect(page.getByText(OFFLINE, { exact: true }), way).toBeVisible();
            // Reload is a new DorkOS navigation, so the served page is back and connected.
            await page.getByRole('button', { name: 'Reload', exact: true }).click();
            frame = await actualFrame(page);
            await ready(frame);
          }
        });
      } finally {
        events.stop();
        await new Promise<void>((resolve) => outside.server.close(() => resolve()));
      }
    });

    test('a served navigation that a redirect sends to another site is challenged and still never connected', async ({
      page,
      request,
    }) => {
      const outside = await startOutsideSite();
      const events = countEventPosts(page);
      const pattern = '**/api/workbench/serve/**';
      let redirected = false;
      const handler = async (route: Route) => {
        if (redirected || !route.request().isNavigationRequest()) return route.continue();
        redirected = true;
        await route.fulfill({ status: 302, headers: { Location: `${outside.origin}/redirect` } });
      };
      try {
        await preserveFailureAndFinish(page, request, async () => {
          await open(page, request);
          await answerBarriers(page);
          await page.route(pattern, handler);
          // DorkOS's own navigation, with a fresh nonce, lands on the outside
          // page: it IS the first document, so it is challenged.
          await page.getByRole('button', { name: 'Reload', exact: true }).click();
          const frame = await actualFrame(page);
          await expect(
            frame.getByRole('heading', { name: 'Outside page', exact: true })
          ).toBeVisible();
          await expect
            .poll(() => frame.evaluate(() => (window as unknown as EchoWindow).__echo.seen.slice()))
            .toContain('challenge');
          const seen = await outsideSaw(frame);
          expect(redirected).toBe(true);
          // A redirect's `Location` replaces the query the nonce rides in, so
          // the target never holds it (a fragment would have been carried
          // forward). It answered with none, a guessed one, and whatever its
          // URL held: nothing earned a port, and nothing was sent.
          expect(seen).toEqual(['challenge']);
          expect(events.counter.posted).toBe(0);
          expect(
            await frame.evaluate(() => (window as unknown as EchoWindow).__echo.boots)
          ).toEqual([]);
        });
      } finally {
        events.stop();
        await page.unroute(pattern, handler).catch(() => {});
        await new Promise<void>((resolve) => outside.server.close(() => resolve()));
      }
    });
  });
}
