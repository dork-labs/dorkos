/**
 * The visual companion's real flow, end to end with the test-mode runtime: an
 * agent opens a served page and a dev-server preview with an `agent:owner`
 * route, approves it as the opener, and a click in either page starts the
 * owner's turn with the event in its `doc_events` context.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Frame, Page } from '@playwright/test';
import { CanvasChannelEventReceiptSchema } from '@dorkos/shared/canvas-channel-schemas';
import { test, expect } from '../../fixtures';
import { ChatPage } from '../../pages/ChatPage';
import { RightPanelPage } from '../../pages/RightPanelPage';
import { preserveFailureAndFinish, seedScenario, type SdkWindow } from './doc-frame-sdk-fixture';

const OFFLINE = 'Page is offline. Reload to reconnect.';
const DOC_TURN = 'Companion doc turn:';

// The same page the scenario writes as a served file
// (`doc-frame-companion-scenario.ts`), here served by a dev server instead.
const COMPANION_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Companion fixture</title></head>
<body><button id="send" type="button">Send choice</button>
<output id="status">waiting</output><output id="receipt"></output>
<script>
const status = document.getElementById('status');
const receipt = document.getElementById('receipt');
const channel = window.dorkos && window.dorkos.channel;
const show = () => { status.textContent = channel ? channel.status : 'absent'; };
if (channel) channel.on('status', show);
show();
document.getElementById('send').addEventListener('click', async () => {
  if (!channel || channel.status !== 'ready') { receipt.textContent = 'not ready'; return; }
  const ev = { type: 'click', choice: 'b', screen: 'layout', where: location.protocol };
  try {
    receipt.textContent = JSON.stringify(await channel.emit('companion.review.send', ev));
  } catch (error) { receipt.textContent = 'refused ' + error.outcome; }
});
</script></body></html>`;

async function startCompanionServer(): Promise<{ port: number; server: Server }> {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(COMPANION_PAGE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, server };
}

/** Show one page's tab, by the name the tab strip gives it, and return its frame. */
async function showPage(page: Page, tab: RegExp): Promise<Frame> {
  await page.getByRole('tab', { name: tab }).click();
  const element = page.locator('iframe[title="Embedded browser"]');
  await expect(element).toBeVisible();
  const frame = await (await element.elementHandle())?.contentFrame();
  if (!frame) throw new Error('The companion page frame is absent.');
  await expect(frame.locator('#send')).toBeVisible();
  return frame;
}

// A page mid-reload has no context to read; that is "not yet", never a failure.
const sdkStatus = (frame: Frame) =>
  frame
    .evaluate(() => (window as SdkWindow).dorkos?.channel?.status ?? 'absent')
    .catch(() => 'navigating');

/** Click Send the way a person does and return the page's own receipt. */
async function send(frame: Frame) {
  await frame.getByRole('button', { name: 'Send choice' }).click();
  await expect(frame.locator('#receipt')).toContainText('"receipt"');
  return CanvasChannelEventReceiptSchema.parse(
    JSON.parse(await frame.locator('#receipt').innerText())
  );
}

/** Registered inside the browser-driving spec, on its test-mode project. */
export function registerDocFrameCompanionBrowserTests() {
  test.describe('Page channel — the visual companion flow', () => {
    test('a served page and a dev-server preview each wake their owner with the event', async ({
      page,
      request,
    }) => {
      const dev = await startCompanionServer();
      try {
        await preserveFailureAndFinish(page, request, async () => {
          const { agentDir, draftId } = await seedScenario(request, 'doc-frame-companion');
          const chat = new ChatPage(page);
          await chat.goto(draftId, { dir: agentDir, runtime: 'claude-code', draft: true });
          await chat.sendAndLand(`Show me the companion at http://localhost:${dev.port}/`);
          const assistant = page.locator('[data-testid="message-item"][data-role="assistant"]');
          await expect(assistant.first()).toContainText('Companion pages open:');
          const opened = /Companion pages open: (\S+) (\S+)\./.exec(
            await assistant.first().innerText()
          );
          if (!opened) throw new Error('The scenario did not name the two pages.');
          const [, servedId, previewId] = opened;
          const sessionId = new URL(page.url()).searchParams.get('session');
          if (!sessionId) throw new Error('The session is absent.');

          // Before any route is approved the page is a plain page: offline, and
          // no notice asks the person to reload, because reloading would not help.
          await new RightPanelPage(page).selectView('Page previews');
          const served = await showPage(page, /^sdk-/);
          await expect.poll(() => sdkStatus(served)).toBe('offline');
          await expect(page.getByText(OFFLINE, { exact: true })).toHaveCount(0);

          // The agent approves its own route; nobody is asked, and the page
          // that is already on screen connects by itself.
          expect((await request.post('/api/test/step', { data: { sessionId } })).ok()).toBe(true);
          await expect(assistant.first()).toContainText('Companion routes approved.');
          await expect.poll(() => sdkStatus(served), { timeout: 15_000 }).toBe('ready');
          await chat.waitForTurnToEnd();

          const first = await send(served);
          expect(first.receipt.status).toBe('recorded');
          expect(first.deliveries).toHaveLength(1);
          expect(first.deliveries[0]).toMatchObject({ routeId: 'companion' });
          await expect(assistant.filter({ hasText: DOC_TURN })).toHaveCount(1, { timeout: 20_000 });
          await expect(assistant.filter({ hasText: DOC_TURN })).toContainText(first.receipt.id);
          await expect(assistant.filter({ hasText: DOC_TURN })).toContainText(
            'companion.review.send'
          );
          await chat.waitForTurnToEnd();

          const preview = await showPage(page, /^localhost$/);
          await expect.poll(() => sdkStatus(preview), { timeout: 15_000 }).toBe('ready');
          // The companion reloads itself for every new screen: the reloaded page
          // reconnects on its own, and nobody is told to reload.
          await preview.evaluate(() => location.reload());
          await expect(preview.locator('#send')).toBeVisible();
          await expect.poll(() => sdkStatus(preview), { timeout: 15_000 }).toBe('ready');
          await expect(page.getByText(OFFLINE, { exact: true })).toHaveCount(0);
          const second = await send(preview);
          await expect(assistant.filter({ hasText: DOC_TURN })).toHaveCount(2, { timeout: 20_000 });
          await expect(assistant.filter({ hasText: DOC_TURN }).last()).toContainText(
            second.receipt.id
          );
          await chat.waitForTurnToEnd();

          // Each event started exactly one turn, and its receipt says which.
          for (const [documentId, sent] of [
            [servedId!, first],
            [previewId!, second],
          ] as const) {
            const reply = await request.get(
              `/api/canvas/docs/${encodeURIComponent(documentId)}/events/${sent.receipt.id}`
            );
            const stored = CanvasChannelEventReceiptSchema.parse(await reply.json());
            expect(stored.deliveries).toHaveLength(1);
            expect(stored.deliveries[0]!.turnId).not.toBeNull();
            expect(['turn_started', 'turn_done', 'handled']).toContain(
              stored.deliveries[0]!.status
            );
          }
        });
      } finally {
        await new Promise<void>((resolve) => dev.server.close(() => resolve()));
      }
    });
  });
}
