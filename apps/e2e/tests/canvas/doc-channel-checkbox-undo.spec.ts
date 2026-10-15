/** Real browser FILE marker mutation and inverse under original busy holder/native cancellation. */
import { createHash } from 'node:crypto';
import { originalHeldTurnHasText } from '../../fixtures/doc-channel-consumer/live-session-snapshot.js';
import { test, expect } from '@playwright/test';
import { startIsolatedConsumerHost } from '../../fixtures/doc-channel-consumer/server.js';
import { signInOriginalConsumerHost } from '../../fixtures/doc-channel-consumer/browser-bootstrap.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';
import { WriteFileRequestSchema } from '@dorkos/shared/schemas';
import {
  CanvasChannelEventReceiptSchema,
  CanvasChannelCheckboxReceiptSchema,
} from '@dorkos/shared/canvas-channel-schemas';

test('own-session browser toggle and inverse Undo retain both receipts, restore exact bytes and start no additional native turns', async ({
  page,
}) => {
  const host = await startIsolatedConsumerHost('session');
  let failed = false,
    first: unknown,
    held = false;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const step = async () => {
    await expect
      .poll(async () => {
        const response = await page.request.post(host.origin + '/api/test/step', {
          data: { sessionId: host.sessionId },
        });
        if (!response.ok()) throw new Error('Original busy release refused');
        return (await response.json()).released;
      })
      .toBe(true);
  };
  try {
    const opened = await host.openCheckboxFile();
    await page.goto(
      host.origin + '/session?session=' + host.sessionId + '&dir=' + encodeURIComponent(host.root)
    );
    await signInOriginalConsumerHost(page, host);
    const configured = await page.request.post(host.origin + '/api/test/scenario', {
      data: { sessionId: host.sessionId, name: 'stoppable-turn' },
    });
    expect(configured.ok()).toBe(true);
    held = true;
    const busy = await page.request.post(
      host.origin + '/api/sessions/' + host.sessionId + '/messages',
      { data: { content: 'Actual own-session checkbox admission barrier', cwd: host.root } }
    );
    expect(busy.status()).toBe(202);
    await expect
      .poll(async () => (await host.readOriginalCheckboxPairData()).targetLocked)
      .toBe(true);
    // The native lock alone can precede scenario capture; observe the real held producer.
    await expect
      .poll(() =>
        originalHeldTurnHasText(
          page,
          host.sessionId,
          host.root,
          'STOPPABLE-TURN: working, and I will not finish on my own.'
        )
      )
      .toBe(true);
    const prior = await host.readOriginalCheckboxPairData();
    expect(prior.scenarioStarts).toBe(1);
    expect(prior.events).toHaveLength(0);
    const panel = new RightPanelPage(page);
    await panel.ensureTabStripOpen();
    await panel.canvasTab.click();
    await page.getByText('Native checkbox file', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Edit file', exact: true }).click();
    const checkbox = page.getByRole('checkbox', { name: 'Native browser task', exact: true });
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');
    const mounted = await checkbox.elementHandle();
    if (!mounted) throw new Error('Original mounted FILE checkbox unavailable');
    const responseFor = () =>
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url() === host.origin + '/api/canvas/docs/' + opened.documentId + '/checkbox'
      );

    const firstResponse = responseFor();
    await checkbox.click();
    const changedResponse = await firstResponse;
    expect(changedResponse.ok()).toBe(true);
    const changed = CanvasChannelCheckboxReceiptSchema.parse(await changedResponse.json());
    expect(changed.status).toBe('changed');
    if (changed.status !== 'changed') throw new Error('Original toggle receipt was not changed');

    await expect(checkbox).toHaveAttribute('aria-checked', 'true');
    const undoResponse = responseFor();
    await checkbox.click();
    const revertedResponse = await undoResponse;
    expect(revertedResponse.ok()).toBe(true);
    const undone = CanvasChannelCheckboxReceiptSchema.parse(await revertedResponse.json());
    expect(undone.status).toBe('changed');
    if (undone.status !== 'changed') throw new Error('Original Undo receipt was not changed');
    expect(undone.receipt.id).not.toBe(changed.receipt.id);
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');
    expect(
      await mounted.evaluate(
        (node) => node.isConnected && node === document.querySelector('[role="checkbox"]')
      )
    ).toBe(true);

    const restored = await host.readOriginalCheckboxPairData();
    expect(restored.baselineRestored).toBe(true);
    expect(restored.targetLocked).toBe(true);
    expect(restored.events.map((event) => event.eventId)).toEqual([
      changed.receipt.id,
      undone.receipt.id,
    ]);
    expect(restored.events[1]!.docSeq).toBeGreaterThan(restored.events[0]!.docSeq);
    expect(restored.receipts.map((row) => row.receipt.id)).toEqual([
      changed.receipt.id,
      undone.receipt.id,
    ]);
    expect(restored.deliveries).toHaveLength(2);
    expect(restored.deliveries.every((row) => row.status === 'cancelled')).toBe(true);
    expect(restored.batches.length).toBeGreaterThan(0);
    expect(
      restored.batches.every(
        (row) => row.status === 'cancelled' && row.errorCode === 'checkbox_baseline_restored'
      )
    ).toBe(true);
    await step();
    held = false;
    await expect
      .poll(async () => (await host.readOriginalCheckboxPairData()).targetLocked)
      .toBe(false);
    expect(await host.pumpCheckboxAfterRelease()).toEqual({ pumped: true });

    const after = await host.readOriginalCheckboxPairData();
    expect(after.scenarioStarts).toBe(prior.scenarioStarts);
    expect(after.admissions).toBe(0);
    expect(after.privateAdmissions).toBe(0);
    expect(after.spend).toBe(0);
    expect(after.baselineRestored).toBe(true);
    expect(after.events).toEqual(restored.events);
    expect(after.receipts).toEqual(restored.receipts);
  } catch (cause) {
    remember(cause);
  }
  if (held)
    try {
      await step();
    } catch (cause) {
      remember(cause);
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
});

test('own-session Blintz draft, selection, focus, scroll and prior Undo survive confirmed checkbox acknowledgements', async ({
  page,
}) => {
  const host = await startIsolatedConsumerHost('session');
  let failed = false,
    first: unknown,
    held = false;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  let releaseAcknowledgement: (() => void) | undefined;
  const routeHandlers: Promise<void>[] = [];
  const step = async () => {
    await expect
      .poll(async () => {
        const response = await page.request.post(host.origin + '/api/test/step', {
          data: { sessionId: host.sessionId },
        });
        if (!response.ok()) throw new Error('Original busy release refused');
        return (await response.json()).released;
      })
      .toBe(true);
  };
  try {
    const opened = await host.openCheckboxFile();
    await page.goto(
      host.origin + '/session?session=' + host.sessionId + '&dir=' + encodeURIComponent(host.root)
    );
    await signInOriginalConsumerHost(page, host);
    const configured = await page.request.post(host.origin + '/api/test/scenario', {
      data: { sessionId: host.sessionId, name: 'stoppable-turn' },
    });
    expect(configured.ok()).toBe(true);
    held = true;
    const busy = await page.request.post(
      host.origin + '/api/sessions/' + host.sessionId + '/messages',
      { data: { content: 'Actual own-session checkbox admission barrier', cwd: host.root } }
    );
    expect(busy.status()).toBe(202);
    await expect
      .poll(async () => (await host.readOriginalCheckboxPairData()).targetLocked)
      .toBe(true);
    // The native lock alone can precede scenario capture; observe the real held producer.
    await expect
      .poll(() =>
        originalHeldTurnHasText(
          page,
          host.sessionId,
          host.root,
          'STOPPABLE-TURN: working, and I will not finish on my own.'
        )
      )
      .toBe(true);
    const prior = await host.readOriginalCheckboxPairData();
    expect(prior.scenarioStarts).toBe(1);
    expect(prior.events).toHaveLength(0);
    const panel = new RightPanelPage(page);
    await panel.ensureTabStripOpen();
    await panel.canvasTab.click();
    await page.getByText('Native checkbox file', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Edit file', exact: true }).click();
    const checkbox = page.getByRole('checkbox', { name: 'Native browser task', exact: true });
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');
    const editor = page.locator('.dorkos-markdown .ProseMirror').last();
    const draft = 'Preserved draft paragraph with genuine editor history. '.repeat(100);
    const ordinarySave = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/files/content'
    );
    await editor.click();
    await editor.press('ControlOrMeta+End');
    await editor.press('Enter');
    await page.keyboard.insertText(draft);

    const savedDraft = await ordinarySave;
    expect(savedDraft.ok()).toBe(true);
    const uploaded: unknown = savedDraft.request().postDataJSON();
    const fileUrl =
      host.origin +
      '/api/files/content?cwd=' +
      encodeURIComponent(host.root) +
      '&path=' +
      encodeURIComponent(host.root + '/native-browser-checkbox.md');
    const readOwnFile = async () => {
      const response = await page.request.get(fileUrl);
      expect(response.ok()).toBe(true);
      const body = await response.json();
      if (typeof body.content !== 'string') throw new Error('Original own FILE bytes unavailable');
      return body.content;
    };
    await expect.poll(readOwnFile).toContain(draft);
    const confirmedDraft = await readOwnFile();
    // Correlate the fixed native log audit with the actual original HTTP writer
    // operation and returned receipt, not merely a reserved event type.
    const originalSave = WriteFileRequestSchema.parse(uploaded);
    if (!originalSave.documentSave)
      throw new Error('Original long-draft native save identity missing');
    expect(originalSave).toMatchObject({
      cwd: host.root,
      path: host.root + '/native-browser-checkbox.md',
      content: confirmedDraft,
      documentSave: { documentId: opened.documentId },
    });
    const saveBody: unknown = await savedDraft.json();
    if (!saveBody || typeof saveBody !== 'object' || !('documentReceipt' in saveBody))
      throw new Error('Original long-draft native save receipt missing');
    const saveReceipt = CanvasChannelEventReceiptSchema.parse(saveBody.documentReceipt);
    expect(saveReceipt.receipt).toMatchObject({
      id: originalSave.documentSave.eventId,
      status: 'recorded',
    });
    const savedAudit = await host.readOriginalCheckboxPairData();
    expect(savedAudit.savedEvents).toHaveLength(1);
    expect(savedAudit.savedEvents[0]).toMatchObject({
      eventId: originalSave.documentSave.eventId,
      docSeq: saveReceipt.receipt.docSeq,
      payload: {
        previousFileHash: originalSave.documentSave.expectedFileHash,
        fileHash: createHash('sha256').update(originalSave.content).digest('hex'),
      },
    });
    expect(savedAudit.savedEvents[0].receipt.deliveries).toEqual([]);

    await editor.press('ControlOrMeta+End');
    for (let n = 0; n < 5; n++) await editor.press('Shift+ArrowLeft');
    const editorNode = await editor.elementHandle();
    if (!editorNode) throw new Error('Original Blintz editor unavailable');
    const snapshot = () =>
      editorNode.evaluate((node) => {
        const selection = window.getSelection();
        const path = (target: Node | null) => {
          if (!target || !node.contains(target))
            throw new Error('Original editor selection left its model');
          const result: number[] = [];
          while (target !== node) {
            const parent: ParentNode | null = target?.parentNode ?? null;
            if (!parent) throw new Error('Original editor selection detached');
            result.unshift(Array.from(parent.childNodes).indexOf(target as ChildNode));
            target = parent;
          }
          return result;
        };
        // CanvasBody owns the content scroll viewport; overflowing editor content
        // alone is not a scroll container (Blintz uses overflow: visible).
        const scroll = node.closest<HTMLElement>('[role="tabpanel"]');
        if (
          !scroll ||
          !scroll.contains(node) ||
          !['auto', 'scroll'].includes(getComputedStyle(scroll).overflowY) ||
          scroll.scrollHeight <= scroll.clientHeight
        )
          throw new Error('Long genuine editor has no scrolling ancestor');
        // Checkbox SVGs are decorative NodeView DOM, not document text. Checked
        // and unchecked Lucide templates contain different formatting newlines.
        const documentText = node.cloneNode(true);
        if (!(documentText instanceof HTMLElement))
          throw new Error('Original editor document clone unavailable');
        for (const icon of documentText.querySelectorAll(
          '[role="checkbox"][contenteditable="false"] .milkdown-icon svg'
        ))
          icon.remove();
        return {
          text: documentText.textContent,
          anchor: path(selection?.anchorNode ?? null),
          focus: path(selection?.focusNode ?? null),
          start: selection?.anchorOffset,
          end: selection?.focusOffset,
          selected: selection?.toString(),
          scroll: scroll.scrollTop,
        };
      });
    const acknowledge = async (done: boolean) => {
      let reached!: () => void, rejectCommit!: (cause: unknown) => void;
      const committed = new Promise<void>((resolve, reject) => {
        reached = resolve;
        rejectCommit = reject;
      });
      // Attach immediately; the original rejection is still awaited below.
      void committed.catch(() => {});
      const delivery = new Promise<void>((resolve) => {
        releaseAcknowledgement = resolve;
      });
      const url = host.origin + '/api/canvas/docs/' + opened.documentId + '/checkbox';
      let receipt: ReturnType<typeof CanvasChannelCheckboxReceiptSchema.parse> | undefined;
      let handler: Promise<void> | undefined;
      await page.route(url, (route) => {
        handler = (async () => {
          try {
            // Execute the genuine owning HTTP writer, holding only its response delivery.
            const response = await route.fetch();
            expect(response.ok()).toBe(true);
            receipt = CanvasChannelCheckboxReceiptSchema.parse(await response.json());
            reached();
            await delivery;
            await route.fulfill({ response });
          } catch (cause) {
            remember(cause);
            rejectCommit(cause);
            try {
              await route.abort();
            } catch (cleanupCause) {
              remember(cleanupCause);
            }
          }
        })();
        routeHandlers.push(handler);
        return handler;
      });

      await checkbox.click();

      await committed;

      await checkbox.focus();

      await editorNode.evaluate((node) => {
        const scroll = node.closest<HTMLElement>('[role="tabpanel"]');
        if (
          !scroll ||
          !scroll.contains(node) ||
          !['auto', 'scroll'].includes(getComputedStyle(scroll).overflowY) ||
          scroll.scrollHeight <= scroll.clientHeight
        )
          throw new Error('Genuine editor scroll unavailable');
        scroll.scrollTop = Math.min(120, scroll.scrollHeight - scroll.clientHeight);
      });

      const before = await snapshot();

      expect(before.selected?.length).toBeGreaterThan(0);

      expect(before.scroll).toBeGreaterThan(0);

      releaseAcknowledgement!();
      releaseAcknowledgement = undefined;
      await handler;
      if (failed) throw first;
      if (!receipt || receipt.status !== 'changed')
        throw new Error('Original native marker was not changed');

      await expect(checkbox).toHaveAttribute('aria-checked', done ? 'true' : 'false');
      expect(await snapshot()).toEqual(before);
      await expect(checkbox).toBeFocused();
      await page.unroute(url);
      return receipt;
    };
    const mounted = await checkbox.elementHandle();
    if (!mounted) throw new Error('Original mounted FILE checkbox unavailable');
    const changed = await acknowledge(true);
    await expect(checkbox).toHaveAttribute('aria-checked', 'true');
    const undone = await acknowledge(false);
    expect(undone.receipt.id).not.toBe(changed.receipt.id);
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');
    expect(
      await mounted.evaluate(
        (node) => node.isConnected && node === document.querySelector('[role="checkbox"]')
      )
    ).toBe(true);
    const restored = await host.readOriginalCheckboxPairData();
    expect(restored.savedEvents).toEqual(savedAudit.savedEvents);
    expect(await readOwnFile()).toBe(confirmedDraft);
    expect(restored.targetLocked).toBe(true);
    expect(restored.events.map((event) => event.eventId)).toEqual([
      changed.receipt.id,
      undone.receipt.id,
    ]);
    expect(restored.events[1]!.docSeq).toBeGreaterThan(restored.events[0]!.docSeq);
    expect(restored.receipts.map((row) => row.receipt.id)).toEqual([
      changed.receipt.id,
      undone.receipt.id,
    ]);
    expect(restored.deliveries).toHaveLength(2);
    expect(restored.deliveries.every((row) => row.status === 'cancelled')).toBe(true);
    expect(restored.batches.length).toBeGreaterThan(0);
    expect(
      restored.batches.every(
        (row) => row.status === 'cancelled' && row.errorCode === 'checkbox_baseline_restored'
      )
    ).toBe(true);
    await step();
    held = false;
    await expect
      .poll(async () => (await host.readOriginalCheckboxPairData()).targetLocked)
      .toBe(false);
    expect(await host.pumpCheckboxAfterRelease()).toEqual({ pumped: true });
    const after = await host.readOriginalCheckboxPairData();
    expect(after.scenarioStarts).toBe(prior.scenarioStarts);
    expect(after.admissions).toBe(0);
    expect(after.privateAdmissions).toBe(0);
    expect(after.spend).toBe(0);
    expect(await readOwnFile()).toBe(confirmedDraft);
    expect(after.events).toEqual(restored.events);
    expect(after.receipts).toEqual(restored.receipts);
    // Confirmed marker transactions must not consume the user's preceding edit history.
    await editor.click();
    await editor.press('ControlOrMeta+z');
    await expect(editor).not.toContainText(draft);
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');
  } catch (cause) {
    remember(cause);
  }
  releaseAcknowledgement?.();
  const drainedRoutes = await Promise.allSettled(routeHandlers);
  for (const result of drainedRoutes) if (result.status === 'rejected') remember(result.reason);
  if (held)
    try {
      await step();
    } catch (cause) {
      remember(cause);
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
});

test('Room canvas keeps another member’s agent-cwd FILE read-only', async ({ page }) => {
  const host = await startIsolatedConsumerHost('room');
  let failed = false,
    first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    await host.openCheckboxFile();
    await page.goto(
      host.origin + '/channels?id=' + host.roomId + '&dir=' + encodeURIComponent(host.root)
    );
    await signInOriginalConsumerHost(page, host);
    const panel = new RightPanelPage(page);
    await panel.ensureTabStripOpen();
    await panel.canvasTab.click();
    await page.getByText('Native checkbox file', { exact: true }).first().click();
    await expect(
      page.getByText(
        'Another member’s project isn’t open to you. Ask them to share it, or open your copy.',
        { exact: true }
      )
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit file', exact: true })).toHaveCount(0);
    const data = await host.readOriginalCheckboxPairData();
    expect(data.events).toEqual([]);
    expect(data.admissions).toBe(0);
    expect(data.privateAdmissions).toBe(0);
    expect(data.spend).toBe(0);
  } catch (cause) {
    remember(cause);
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
});
