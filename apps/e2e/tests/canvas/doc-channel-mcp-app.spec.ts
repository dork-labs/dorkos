/** Real stdio resource, negotiated opaque-origin MCP App and native session delivery. */
import { test, expect } from '@playwright/test';
import { startIsolatedConsumerHost } from '../../fixtures/doc-channel-consumer/server.js';
import { signInOriginalConsumerHost } from '../../fixtures/doc-channel-consumer/browser-bootstrap.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';

test('MCP App negotiates document events, refuses forged requests and preserves its live draft across native replies', async ({
  page,
}, testInfo) => {
  const host = await startIsolatedConsumerHost('session');
  let failure: { cause: unknown } | undefined;
  try {
    const opened = await host.openOriginalMcpApp();
    expect(typeof opened.documentId).toBe('string');
    expect(typeof opened.generation).toBe('string');
    if (typeof opened.documentId !== 'string' || typeof opened.generation !== 'string')
      throw new Error('Original MCP App identity unavailable');
    const originalIdentity = { documentId: opened.documentId, generation: opened.generation };
    await page.goto(
      host.origin + '/session?session=' + host.sessionId + '&dir=' + encodeURIComponent(host.root)
    );
    await signInOriginalConsumerHost(page, host);
    const panel = new RightPanelPage(page);
    await panel.ensureTabStripOpen();
    await panel.canvasTab.click();
    await page.getByRole('tab', { name: 'Original document MCP App', exact: true }).click();
    const app = page.frameLocator(
      'iframe[title="Original document MCP App"][sandbox="allow-scripts"]'
    );
    await expect(app.getByRole('heading', { name: 'Original document MCP App' })).toBeVisible();
    const result = app.locator('#result');
    const invoke = async (name: string) => {
      const prior = await result.getAttribute('data-settled');
      await app.getByRole('button', { name, exact: true }).click();
      await expect.poll(() => result.getAttribute('data-settled')).not.toBe(prior);
    };
    await invoke('Send app event');
    await expect(result).toHaveText('Refused');
    expect((await host.readOriginalMcpAppData()).events).toHaveLength(0);
    await app.getByRole('button', { name: 'Connect document', exact: true }).click();
    await expect(app.locator('#permission')).toHaveText('Document connected');
    for (const name of [
      'Wrong document',
      'Wrong generation',
      'Wrong bridge generation',
      'Reserved host event',
      'Try tools call',
      'Try downstream request',
    ]) {
      await invoke(name);
      await expect(result).toHaveText('Refused');
    }
    expect((await host.readOriginalMcpAppData()).events).toHaveLength(0);
    const bridgeGeneration = await app
      .locator('#permission')
      .getAttribute('data-bridge-generation');
    expect(bridgeGeneration).toMatch(/^[0-9a-f-]{36}$/u);
    if (typeof bridgeGeneration !== 'string')
      throw new Error('Original MCP bridge generation unavailable');
    // A host-window sender is not the captured opaque App window, even with copied document DATA.
    await page.evaluate(
      (identity) => {
        window.postMessage(
          {
            jsonrpc: '2.0',
            id: 700,
            method: 'dorkos/app.emit',
            params: {
              v: 1,
              documentId: identity.documentId,
              generation: identity.generation,
              bridgeGeneration: identity.bridgeGeneration,
              event: {
                v: 1,
                id: '70000000-0000-4000-8000-000000000001',
                type: 'task.changed',
                payload: { forged: true },
              },
            },
          },
          window.location.origin
        );
      },
      { ...originalIdentity, bridgeGeneration }
    );
    await invoke('Send app event');
    await expect(result).toHaveText('recorded');
    const eventId = await result.getAttribute('data-event-id');
    const docSeq = await result.getAttribute('data-doc-seq');
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/u);
    await invoke('Retry original event');
    await expect(result).toHaveText(/^(recorded|duplicate)$/u);
    await expect(result).toHaveAttribute('data-event-id', eventId!);
    await expect(result).toHaveAttribute('data-doc-seq', docSeq!);
    await invoke('Send app event');
    await expect(result).toHaveText('recorded');
    const secondEventId = await result.getAttribute('data-event-id');
    const secondDocSeq = await result.getAttribute('data-doc-seq');
    expect(secondEventId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(secondEventId).not.toBe(eventId);
    await invoke('Retry original event');
    await expect(result).toHaveText(/^(recorded|duplicate)$/u);
    await expect(result).toHaveAttribute('data-event-id', secondEventId!);
    await expect(result).toHaveAttribute('data-doc-seq', secondDocSeq!);
    const recorded = await host.readOriginalMcpAppData();
    expect(recorded.events).toHaveLength(2);
    expect(recorded.deliveries).toHaveLength(2);
    expect(recorded.admissions).toHaveLength(0);
    expect(recorded.scenarioStarts).toBe(0);
    expect(recorded.downstreamProducerStarts).toBe(0);
    const draft = app.getByRole('textbox', { name: 'App draft' });
    await draft.fill('My preserved MCP App draft');
    await draft.press('Home');
    await draft.press('Shift+ArrowRight');
    await draft.press('Shift+ArrowRight');
    const mounted = await draft.elementHandle();
    if (!mounted) throw new Error('Original MCP App input unavailable');
    const before = await mounted.evaluate((node: HTMLInputElement) => {
      const scroll = node.ownerDocument.scrollingElement;
      if (!scroll) throw new Error('Original App scrolling document unavailable');
      scroll.scrollTop = 40;
      if (scroll.scrollTop !== 40) throw new Error('Original App scroll unavailable');
      return { start: node.selectionStart, end: node.selectionEnd, scroll: scroll.scrollTop };
    });
    expect(before.end! - before.start!).toBe(2);
    expect(recorded.batches).toHaveLength(1);
    expect(recorded.batches[0].inputEventIds).toEqual([eventId, secondEventId]);
    await expect
      .poll(
        async () => Date.parse((await host.readOriginalMcpAppData()).batches[0].dueAt) <= Date.now()
      )
      .toBe(true);
    await host.pumpOriginalMcpApp();
    await expect
      .poll(async () => {
        const data = await host.readOriginalMcpAppData();
        return {
          admissions: data.admissions.length,
          starts: data.scenarioStarts,
          locked: data.targetLocked,
        };
      })
      .toEqual({ admissions: 1, starts: 1, locked: false });
    const emitted = await host.emitOriginalMcpAppDownstream();
    expect(emitted.downstreamProducerStarts).toBe(1);
    await expect(app.locator('#downstream')).toHaveText('app.reply');
    await expect(app.locator('#downstream')).toHaveAttribute(
      'data-event-id',
      String(emitted.replyEventId)
    );
    await expect(app.locator('#downstream')).toHaveAttribute(
      'data-ack-event-id',
      String(emitted.ackEventId)
    );
    await expect(app.locator('#state')).toHaveText('Original MCP state arrived');
    await expect(app.locator('#state')).toHaveAttribute('data-state-rev', '2');
    await expect(app.locator('#state')).toHaveAttribute('data-large-length', String(24 * 1024));
    await expect(app.locator('#downstream')).toHaveAttribute('data-ack-input-ids', eventId!);
    await expect(app.locator('#downstream')).toHaveAttribute(
      'data-reply-input-ids',
      secondEventId!
    );
    expect(emitted.stateRev).toBe(2);
    expect(
      await mounted.evaluate((node: HTMLInputElement) => ({
        value: node.value,
        mounted: node.isConnected && node.ownerDocument.getElementById('draft') === node,
        focused: node.ownerDocument.activeElement === node,
        start: node.selectionStart,
        end: node.selectionEnd,
        scroll: node.ownerDocument.scrollingElement?.scrollTop,
      }))
    ).toEqual({
      value: 'My preserved MCP App draft',
      mounted: true,
      focused: true,
      start: before.start,
      end: before.end,
      scroll: before.scroll,
    });
    const complete = await host.readOriginalMcpAppData();
    expect(complete.events).toHaveLength(6);
    expect(complete.deliveries).toHaveLength(2);
    expect(complete.deliveries[0]).toMatchObject({ eventId, ackOutcome: 'handled' });
    expect(complete.deliveries[1]).toMatchObject({ eventId: secondEventId, ackOutcome: null });
    expect(complete.admissions).toHaveLength(1);
    expect(complete.admissions[0]).toMatchObject({
      sourceId: complete.deliveries[0].batchId,
      turnStartSeq: expect.any(Number),
    });
    expect(complete.admissions[0].sourceGeneration).toBe(complete.admissions[0].batchGeneration);
    expect(complete.scenarioStarts).toBe(2);
    expect(complete.downstreamProducerStarts).toBe(1);
    expect(complete.events.map((event) => event.type)).toEqual([
      'task.changed',
      'task.changed',
      'app.ack',
      'app.reply',
      'state.changed',
      'state.changed',
    ]);
    // Capture only the sanitized App after state/draft/native assertions pass,
    // while its original frame and preserved selection are still live.
    const visualPath = testInfo.outputPath('mcp-app-live-state-draft.png');
    await page
      .locator('iframe[title="Original document MCP App"][sandbox="allow-scripts"]')
      .screenshot({ path: visualPath });
    await testInfo.attach('MCP App live state and preserved draft', {
      path: visualPath,
      contentType: 'image/png',
    });
    // A confirmed retry inspects the original native receipt; it is not a new submission.
    await invoke('Retry original event');
    await expect(result).toHaveText(/^(recorded|duplicate)$/u);
    await expect(result).toHaveAttribute('data-event-id', secondEventId!);
    await expect(result).toHaveAttribute('data-doc-seq', secondDocSeq!);
    // The explicit original downstream producer is distinct from the one App admission.
    const originalIframe = await page
      .locator('iframe[title="Original document MCP App"][sandbox="allow-scripts"]')
      .elementHandle();
    const originalFrame = await originalIframe?.contentFrame();
    if (!originalFrame) throw new Error('Original MCP App frame unavailable');
    await Promise.all([
      originalFrame.waitForNavigation(),
      originalFrame.evaluate(() => location.reload()),
    ]);
    await expect(app.getByRole('heading', { name: 'Original document MCP App' })).toBeVisible();
    await app.getByRole('button', { name: 'Connect document', exact: true }).click();
    await expect(app.locator('#permission')).toHaveText('No document permission');
    await expect(result).toHaveText('Refused');
    const retired = await host.readOriginalMcpAppData();
    expect(retired.events).toHaveLength(6);
    expect(retired.admissions).toHaveLength(1);
    expect(retired.scenarioStarts).toBe(2);
  } catch (cause) {
    failure ??= { cause };
  } finally {
    const pageRetirement = (async () => {
      try {
        await page.goto('about:blank');
      } catch (cause) {
        failure ??= { cause };
      }
    })();
    const hostRetirement = (async () => {
      try {
        await host.close();
      } catch (cause) {
        failure ??= { cause };
      }
    })();
    await Promise.all([pageRetirement, hostRetirement]);
  }
  if (failure) throw failure.cause;
});
