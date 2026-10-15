/** Real operator editor receipts: physical save and a lost response after actual server commit. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { ChatPage } from '../../pages/ChatPage';
import { RightPanelPage } from '../../pages/RightPanelPage';
import {
  WriteFileRequestSchema,
  WriteFileResponseSchema,
  FileDocumentSaveReceiptSchema,
  type WriteFileRequest,
} from '@dorkos/shared/schemas';
import { CanvasChannelReplayResponseSchema } from '@dorkos/shared/canvas-channel-schemas';

// Retain no browser media containing source text or private correlation evidence.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial' });
const FILE = 'ordinary-file-save-receipt.txt';
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
async function open(page: Page, request: APIRequestContext) {
  const draftId = randomUUID();
  const seeded = await request.post('/api/test/seed-agent', { data: { instance: randomUUID() } });
  expect(seeded.ok()).toBe(true);
  const { agentDir } = (await seeded.json()) as { agentDir: string };
  const selected = await request.post('/api/test/scenario', {
    data: { name: 'ordinary-file-save-receipt', sessionId: draftId },
  });
  expect(
    selected.ok(),
    'Run only in the credential-free chromium-browser-driving test-mode project.'
  ).toBe(true);
  const chat = new ChatPage(page);
  await chat.goto(draftId, { dir: agentDir, runtime: 'test-mode', draft: true });
  await chat.sendAndLand('Open my private save-receipt fixture');
  const panel = new RightPanelPage(page);
  await panel.ensureTabStripOpen();
  await panel.selectView('Canvas');
  await page.getByRole('tab', { name: 'Ordinary save receipt', exact: true }).click();
  const sessionId = new URL(page.url()).searchParams.get('session');
  if (!sessionId) throw new Error('The real session was not retained in the address.');
  const listing = await request.get(`/api/sessions/${encodeURIComponent(sessionId)}/canvas`);
  expect(listing.ok()).toBe(true);
  const { documents } = (await listing.json()) as {
    documents: Array<{ id: string; title: string }>;
  };
  const document = documents.find((row) => row.title === 'Ordinary save receipt');
  if (!document) throw new Error('The production file document is absent.');
  const channelUrl = `/api/canvas/docs/${encodeURIComponent(document.id)}/channel`;
  const channel = async () => {
    const result = await request.get(channelUrl);
    expect(result.ok()).toBe(true);
    return CanvasChannelReplayResponseSchema.parse(await result.json());
  };
  await expect.poll(async () => (await channel()).incarnation?.documentId).toBe(document.id);
  const path = join(agentDir, FILE);
  const initial = await fs.readFile(path, 'utf8');
  const edit = page.getByRole('button', { name: 'Edit file', exact: true });
  await expect(edit).toHaveAttribute('data-document-save-observation', 'ready');
  await expect(edit).toBeEnabled();
  await edit.click();
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await expect(editor).toBeVisible();
  return { path, initial, documentId: document.id, channel, editor };
}
async function replace(page: Page, editor: ReturnType<Page['locator']>, text: string) {
  await editor.click();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}
async function cleanup(page: Page, request: APIRequestContext) {
  // Unmount while its owned file still exists so real final-drain logic is exercised.
  const sessionId = new URL(page.url()).searchParams.get('session');
  await page.goto('about:blank');
  if (sessionId) {
    const scenario = await request.post('/api/test/scenario', {
      data: { name: 'simple-text', sessionId },
    });
    expect(scenario.ok()).toBe(true);
  }
  // The seeded instance and its one private file remain inside the established throwaway DORK_HOME.
  // Its host teardown owns removal after all unmount/final-drain requests close; never unlink under a possible live save.
}
test('an ordinary file edit records its genuine saved receipt and current file bytes', async ({
  page,
  request,
}) => {
  let failure: unknown;
  try {
    const f = await open(page, request);
    const text = 'Genuine ordinary browser save.';
    const savedResponse = page.waitForResponse(
      (r) =>
        r.request().method() === 'PUT' &&
        new URL(r.url()).pathname === '/api/files/content' &&
        r.request().postDataJSON().path === f.path
    );
    await replace(page, f.editor, text);
    const response = await savedResponse;
    const input = WriteFileRequestSchema.parse(response.request().postDataJSON());
    expect(response.ok()).toBe(true);
    expect(input.documentSave).toMatchObject({ documentId: f.documentId });
    const body = WriteFileResponseSchema.parse(await response.json());
    const receipt = FileDocumentSaveReceiptSchema.parse(body.documentReceipt);
    expect(receipt).toMatchObject({
      eventId: input.documentSave!.eventId,
      documentId: f.documentId,
      incarnation: input.documentSave!.incarnation,
      status: 'accepted',
      fileHash: hash(input.content),
    });
    expect(await fs.readFile(f.path, 'utf8')).toBe(text);
    const events = (await f.channel()).events.filter((frame) => frame.event.type === 'doc.saved');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      docSeq: receipt.docSeq,
      event: { id: receipt.eventId, direction: 'system' },
    });
    await expect(page.getByText('Save recorded', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Finish editing', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit file', exact: true })).toBeVisible();
  } catch (cause) {
    failure = cause;
  } finally {
    await cleanup(page, request).catch((cause) => {
      failure ??= cause;
    });
  }
  if (failure) throw failure;
});
test('a dropped committed response retries the exact original UUID without another effect and preserves the newer draft', async ({
  page,
  request,
}) => {
  const work = new Set<Promise<void>>();
  const requests: WriteFileRequest[] = [];
  const replies: Array<ReturnType<typeof FileDocumentSaveReceiptSchema.parse>> = [];
  let failure: unknown;
  let mode: 'drop' | 'retry' | 'later' = 'drop';
  const routeUrl = '**/api/files/content';
  let handler: ((route: Route) => Promise<void>) | undefined;
  try {
    const f = await open(page, request);
    handler = (route) => {
      const pending = (async () => {
        try {
          if (
            route.request().method() !== 'PUT' ||
            route.request().postDataJSON().path !== f.path
          ) {
            await route.continue();
            return;
          }
          const input = WriteFileRequestSchema.parse(route.request().postDataJSON());
          if (!input.documentSave)
            throw new Error('The real editor omitted its document save binding.');
          const currentMode = mode;
          if (currentMode === 'retry') expect(input).toEqual(requests[0]);
          requests.push(input);
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          const receipt = FileDocumentSaveReceiptSchema.parse(
            WriteFileResponseSchema.parse(await response.json()).documentReceipt
          );
          expect(receipt.eventId).toBe(input.documentSave.eventId);
          expect(await fs.readFile(f.path, 'utf8')).toBe(input.content);
          const saved = (await f.channel()).events.filter(
            (frame) => frame.event.type === 'doc.saved'
          );
          expect(
            saved.filter((frame) => frame.event.id === input.documentSave!.eventId)
          ).toHaveLength(1);
          if (currentMode === 'drop') {
            expect(receipt.status).toBe('accepted');
            replies.push(receipt);
            // Only after the real commit and independent disk/event checks do we lose the browser response.
            await route.abort('failed');
          } else {
            if (currentMode === 'retry')
              expect(receipt).toEqual({ ...replies[0], status: 'duplicate' });
            replies.push(receipt);
            await route.fulfill({ response });
          }
        } catch (cause) {
          failure ??= cause;
          await route.abort().catch(() => undefined);
        }
      })();
      work.add(pending);
      void pending.finally(() => work.delete(pending));
      return pending;
    };
    await page.route(routeUrl, handler);
    await replace(page, f.editor, 'First committed browser bytes.');
    const retry = page.getByRole('button', { name: 'Retry original save', exact: true });
    await expect(retry).toBeEnabled();
    if (failure) throw failure;
    expect(requests).toHaveLength(1);
    expect(replies).toHaveLength(1);
    const identity = await fs.stat(f.path, { bigint: true });
    const later = 'A newer draft must survive the original retry.';
    await replace(page, f.editor, later);
    // A real final-save attempt cancels the debounce and proves the pending operation fences the newer draft.
    await page.getByRole('button', { name: 'Finish editing', exact: true }).click();
    await expect(retry).toBeEnabled();
    await expect(f.editor).toHaveText(later);
    expect(requests).toHaveLength(1);
    expect(await fs.readFile(f.path, 'utf8')).toBe(requests[0]!.content);
    mode = 'retry';
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
    if (failure) throw failure;
    expect(requests).toHaveLength(2);
    expect(replies).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    const afterRetry = await fs.stat(f.path, { bigint: true });
    expect({ dev: afterRetry.dev, ino: afterRetry.ino }).toEqual({
      dev: identity.dev,
      ino: identity.ino,
    });
    expect(
      (await f.channel()).events.filter((frame) => frame.event.type === 'doc.saved')
    ).toHaveLength(1);
    await expect(f.editor).toHaveText(later);
    mode = 'later';
    await page.getByRole('button', { name: 'Finish editing', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit file', exact: true })).toBeVisible();
    if (failure) throw failure;
    expect(requests).toHaveLength(3);
    expect(replies).toHaveLength(3);
    expect(requests[2]!.documentSave!.eventId).not.toBe(requests[0]!.documentSave!.eventId);
    expect(await fs.readFile(f.path, 'utf8')).toBe(later);
    expect(
      (await f.channel()).events.filter((frame) => frame.event.type === 'doc.saved')
    ).toHaveLength(2);
  } catch (cause) {
    failure ??= cause;
  } finally {
    if (handler) {
      await page.unroute(routeUrl, handler).catch((cause) => {
        failure ??= cause;
      });
    }
    await Promise.allSettled([...work]);
    await cleanup(page, request).catch((cause) => {
      failure ??= cause;
    });
  }
  if (failure) throw failure;
});

test('removing a receipt file waits for the genuine save ACK before DELETE', async ({
  page,
  request,
}) => {
  const work = new Set<Promise<void>>();
  const inputs: WriteFileRequest[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failure: unknown;
  let deletes = 0;
  let documentId: string | undefined;
  const observe = (request: import('@playwright/test').Request) => {
    if (
      request.method() === 'DELETE' &&
      documentId &&
      new URL(request.url()).pathname.endsWith('/canvas/' + documentId)
    )
      deletes++;
  };
  page.on('request', observe);
  let handler: ((route: Route) => Promise<void>) | undefined;
  const routeUrl = '**/api/files/content';
  try {
    const f = await open(page, request);
    documentId = f.documentId;
    const text = 'Buffered close must preserve these real file bytes.';
    handler = (route) => {
      const pending = (async () => {
        try {
          if (
            route.request().method() !== 'PUT' ||
            route.request().postDataJSON().path !== f.path
          ) {
            await route.continue();
            return;
          }
          const input = WriteFileRequestSchema.parse(route.request().postDataJSON());
          expect(input.documentSave?.documentId).toBe(f.documentId);
          inputs.push(input);
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          const receipt = FileDocumentSaveReceiptSchema.parse(
            WriteFileResponseSchema.parse(await response.json()).documentReceipt
          );
          expect(receipt).toMatchObject({
            eventId: input.documentSave!.eventId,
            status: 'accepted',
            fileHash: hash(text),
          });
          expect(await fs.readFile(f.path, 'utf8')).toBe(text);
          expect(
            (await f.channel()).events.filter((frame) => frame.event.type === 'doc.saved')
          ).toHaveLength(1);
          await held;
          await route.fulfill({ response });
        } catch (cause) {
          failure ??= cause;
          await route.abort().catch(() => undefined);
        }
      })();
      work.add(pending);
      void pending.finally(() => work.delete(pending));
      return pending;
    };
    await page.route(routeUrl, handler);
    await replace(page, f.editor, text);
    const deleted = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        new URL(response.url()).pathname.endsWith('/canvas/' + f.documentId)
    );
    void deleted.catch(() => undefined);
    await page.getByRole('button', { name: 'Add view', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Remove document', exact: true }).click();
    await expect.poll(() => inputs.length).toBe(1);
    expect(deletes).toBe(0);
    await expect(f.editor).toHaveText(text);
    await expect(
      page.getByRole('tab', { name: 'Ordinary save receipt', exact: true })
    ).toBeVisible();
    release();
    const response = await deleted;
    expect(response.ok()).toBe(true);
    await expect(page.getByRole('tab', { name: 'Ordinary save receipt', exact: true })).toHaveCount(
      0
    );
    if (failure) throw failure;
    expect(deletes).toBe(1);
    expect(inputs).toHaveLength(1);
    expect(await fs.readFile(f.path, 'utf8')).toBe(text);
  } catch (cause) {
    failure ??= cause;
  } finally {
    release();
    await Promise.allSettled([...work]);
    if (handler)
      await page.unroute(routeUrl, handler).catch((cause) => {
        failure ??= cause;
      });
    page.off('request', observe);
    await cleanup(page, request).catch((cause) => {
      failure ??= cause;
    });
  }
  if (failure) throw failure;
});
