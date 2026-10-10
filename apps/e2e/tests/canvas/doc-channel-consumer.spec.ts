/** Temporary writer/store/browser seams only; never personal-vault or paid/runtime acceptance. */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, type Frame, type Locator } from '@playwright/test';
import {
  startConsumerFixture,
  startIsolatedConsumerHost,
  type ConsumerFixture,
} from '../../fixtures/doc-channel-consumer/server.js';
import { openNativeConsumerStore } from '../../fixtures/doc-channel-consumer/channel-store.js';
import {
  createConsumerVault,
  canonical,
  digest,
} from '../../fixtures/doc-channel-consumer/writer.js';
import { originalHeldTurnHasText } from '../../fixtures/doc-channel-consumer/live-session-snapshot.js';
import { AuthPage } from '../../pages/AuthPage.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';
import type { CanvasService as OriginalCanvasService } from '../../../server/src/services/canvas/index.js';

/** Preserve the original ready failure while recording the actual physical navigation. */
async function expectOriginalFrameReady(frame: Frame, element: Locator): Promise<void> {
  try {
    await expect
      .poll(() =>
        frame.evaluate(
          () =>
            (window as unknown as { dorkos?: { channel?: { status?: string } } }).dorkos?.channel
              ?.status
        )
      )
      .toBe('ready');
  } catch (cause) {
    // Read only the original frame, before its owning host cleanup navigates it away.
    // Diagnostic failure must never replace the actual readiness assertion cause.
    try {
      const physical = await frame.evaluate(() => ({
        isBlank: location.href === 'about:blank',
        readyState: document.readyState,
        contentType: document.contentType,
        title: document.title,
        scripts: document.scripts.length,
        injectedDocShim: Array.from(document.scripts).some((script) =>
          script.textContent?.includes("protocol:'dorkos-doc'")
        ),
        hasNamespace: Object.prototype.hasOwnProperty.call(window, 'dorkos'),
      }));
      process.stderr.write(
        JSON.stringify({
          originalDocFrameReadyFailure: {
            sourceIsBlank: (await element.getAttribute('src')) === 'about:blank',
            sandbox: await element.getAttribute('sandbox'),
            handshakeFrontier: await element.getAttribute('data-original-doc-handshake-frontier'),
            physical,
          },
        }) + '\n'
      );
    } catch {
      /* Original assertion remains the first failure. */
    }
    throw cause;
  }
}

async function owned<T>(run: (fixture: ConsumerFixture) => Promise<T>): Promise<T> {
  const fixture = await startConsumerFixture();
  let failed = false;
  let first: unknown;
  let result: T | undefined;
  try {
    result = await run(fixture);
  } catch (cause) {
    failed = true;
    first = cause;
  }
  try {
    await fixture.close();
  } catch (cause) {
    if (!failed) {
      failed = true;
      first = cause;
    }
  }
  if (failed) throw first;
  return result as T;
}
test('lost writer response and same request retry retain one mutation and one actual channel event', async ({
  request,
}) => {
  await owned(async (f) => {
    const operationId = randomUUID();
    const input = { operationId, kind: 'comment', text: 'Sanitized comment' };
    f.loseNextWriterResponse();
    await expect(request.post(f.origin + '/write', { data: input })).rejects.toThrow();
    const retry = await request.post(f.origin + '/write', { data: input });
    expect(retry.status()).toBe(200);
    const saved = await retry.json();
    expect(saved.writerReceipt.operationId).toBe(operationId);
    expect(saved.handoff).toBe('pending');
    expect(saved.requestHash).toBe(digest(canonical(input)));
    expect(saved.envelopeHash).not.toBe(saved.requestHash);
    expect((await f.vault.snapshot()).ledger.mutations).toBe(1);
    expect((await f.vault.snapshot()).producerCounters.physicalReplacements).toBe(1);
    expect(await f.flushStore()).toHaveLength(1);
    expect(await f.flushStore()).toHaveLength(0);
    const replay = await f.channel.replay();
    expect(replay.events.filter((frame) => frame.event.type === 'task.comment')).toHaveLength(1);
    expect(replay.receipts.filter((row) => row.receipt.id === operationId)).toHaveLength(1);
    const op = (await f.vault.snapshot()).ledger.operations[operationId]!;
    expect(op.writerReceipt?.operationId).toBe(op.channelReceipt?.receipt.id);
    expect((await request.get(f.origin + '/snapshot')).ok()).toBe(true);
  });
});
test('canonical hash ignores object key order; conflicting same ID refuses; identical comments with different IDs remain separate', async () => {
  await owned(async (f) => {
    const id = randomUUID();
    await f.vault.write({ operationId: id, kind: 'comment', text: 'same text' });
    await f.vault.write({ text: 'same text', kind: 'comment', operationId: id });
    await expect(
      f.vault.write({ operationId: id, kind: 'comment', text: 'different' })
    ).rejects.toThrow('OPERATION_ID_CONFLICT');
    const other = randomUUID();
    await f.vault.write({ operationId: other, kind: 'comment', text: 'same text' });
    expect((await f.vault.snapshot()).ledger.mutations).toBe(2);
    expect(await f.flushStore()).toHaveLength(2);
    const snapshot = await f.vault.snapshot();
    expect(snapshot.markdown.match(/same text/g)).toHaveLength(2);
    expect(
      (await f.channel.replay()).events.filter((frame) => frame.event.type === 'task.comment')
    ).toHaveLength(2);
  });
});
test('write-before-ingest reload restores pending handoff without another file mutation', async () => {
  await owned(async (f) => {
    const id = randomUUID();
    await f.vault.write({ operationId: id, kind: 'comment', text: 'recover handoff' });
    await f.recover();
    expect(await f.vault.pending()).toHaveLength(1);
    expect(await f.flushStore()).toHaveLength(1);
    expect((await f.vault.snapshot()).ledger.mutations).toBe(1);
    expect(await f.flushStore()).toHaveLength(0);
  });
});
test('crash after file replace reconciles original effect; crash before effect remains unknown and never repeats', async ({
  request,
}) => {
  for (const stage of ['file-replaced', 'intent-durable'] as const)
    await owned(async (f) => {
      const id = randomUUID();
      const body = { operationId: id, kind: 'comment', text: 'crash subject' };
      f.crashNextWrite(stage);
      expect((await request.post(f.origin + '/write', { data: body })).status()).toBe(409);
      await f.recover();
      const snapshot = await f.vault.snapshot();
      if (stage === 'file-replaced') {
        expect(snapshot.ledger.mutations).toBe(1);
        expect(snapshot.producerCounters.physicalReplacements).toBe(1);
        expect(snapshot.markdown.match(/crash subject/g)).toHaveLength(1);
        expect(await f.flushStore()).toHaveLength(1);
      } else {
        expect(snapshot.ledger.health).toBe('in_doubt');
        expect(snapshot.ledger.mutations).toBe(0);
        expect(snapshot.producerCounters.physicalReplacements).toBe(0);
        await expect(f.vault.write(body)).rejects.toThrow('WRITER_EFFECT_IN_DOUBT');
        expect(await f.flushStore()).toHaveLength(0);
      }
    });
});
test('unknown handoff queries original receipt and never flushes an admitted event again', async () => {
  await owned(async (f) => {
    const id = randomUUID();
    const op = await f.vault.write({ operationId: id, kind: 'comment', text: 'receipt lost' });
    await f.vault.beginHandoff(id);
    await f.channel.emit(op.event);
    await f.recover();
    expect(await f.flushStore()).toHaveLength(0);
    await f.reconcileHandoff(id);
    expect((await f.channel.replay()).events.filter((frame) => frame.event.id === id)).toHaveLength(
      1
    );
    expect((await f.vault.snapshot()).ledger.operations[id]!.handoff).toBe('recorded');
  });
});
test('a forged page receipt never withdraws pending ownership or labels notification saved', async ({
  request,
}) => {
  await owned(async (f) => {
    const operationId = randomUUID();
    await f.vault.write({ operationId, kind: 'comment', text: 'actual receipt required' });
    await f.vault.beginHandoff(operationId);
    const response = await request.post(f.origin + '/handoff/receipt', {
      data: {
        operationId,
        receipt: { receipt: { id: operationId, status: 'recorded', docSeq: 99 }, deliveries: [] },
      },
    });
    expect(response.status()).toBe(409);
    expect(
      (await f.vault.snapshot()).ledger.operations[operationId]!.channelReceipt
    ).toBeUndefined();
    await f.recover();
    expect((await f.vault.snapshot()).ledger.operations[operationId]!.handoff).toBe('in_doubt');
    expect(await f.flushStore()).toHaveLength(0);
  });
});
test('real owning scope rename/restart preserves operation/channel receipt identity before dispatch', async () => {
  await owned(async (f) => {
    const id = randomUUID();
    await f.vault.write({ operationId: id, kind: 'comment', text: 'busy subject' });
    await f.flushStore();
    const prior = await f.channel.receipt(id);
    await f.channel.restartCanonical();
    const after = await f.channel.receipt(id);
    expect(after.receipt.id).toBe(id);
    expect(after.receipt.docSeq).toBe(prior.receipt.docSeq);
    expect((await f.vault.snapshot()).ledger.mutations).toBe(1);
    expect(await f.flushStore()).toHaveLength(0);
    // Actual first-turn/start/completion/app ack requires original F2 callback adopter below, not a fake DTO.
  });
});
test('external restore refuses fresh mutation; five-minute Undo retains independent receipts', async () => {
  let clock = 1000;
  const vault = await createConsumerVault(() => clock);
  try {
    const toggle = await vault.write({ operationId: randomUUID(), kind: 'toggle', checked: true });
    const undo = await vault.write({
      operationId: randomUUID(),
      kind: 'undo',
      originalOperationId: toggle.request.operationId,
    });
    expect(undo.writerReceipt?.afterHash).toBe(toggle.writerReceipt?.beforeHash);
    expect((await vault.snapshot()).ledger.mutations).toBe(2);
    const next = await vault.write({ operationId: randomUUID(), kind: 'toggle', checked: true });
    clock += 300001;
    await expect(
      vault.write({
        operationId: randomUUID(),
        kind: 'undo',
        originalOperationId: next.request.operationId,
      })
    ).rejects.toThrow('UNDO_EXPIRED_OR_UNAVAILABLE');
    await writeFile(join(vault.root, 'notes/task.md'), '# External replacement\n');
    await expect(
      vault.write({ operationId: randomUUID(), kind: 'comment', text: 'must refuse' })
    ).rejects.toThrow('EXTERNAL_RESTORE_OR_EDIT');
  } finally {
    await vault.close();
  }
});
test('browser keeps sessionStorage draft, focused caret/selection/scroll and separates file save from absent channel', async ({
  page,
}) => {
  await owned(async (f) => {
    await page.goto(f.origin + '/dashboard');
    await page.getByRole('button', { name: 'Open discussion' }).click();
    const draft = page.getByRole('textbox', { name: 'Comment' });
    await draft.fill('draft survives\n'.repeat(40));
    await draft.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.focus();
      input.setSelectionRange(3, 8);
      input.scrollTop = 70;
    });
    const before = await draft.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      return { start: input.selectionStart, end: input.selectionEnd, scroll: input.scrollTop };
    });
    await page
      .getByRole('button', { name: 'Retry pending notification' })
      .evaluate((element) => (element as HTMLButtonElement).click());
    expect(
      await draft.evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        return { start: input.selectionStart, end: input.selectionEnd, scroll: input.scrollTop };
      })
    ).toEqual(before);
    await expect(draft).toBeFocused();
    await page.reload();
    await page.getByRole('button', { name: 'Open discussion' }).click();
    await expect(draft).toHaveValue('draft survives\n'.repeat(40));
    await draft.fill('File save only');
    await page.getByRole('button', { name: 'Save comment' }).click();
    await expect(page.locator('.file')).toHaveText('File saved');
    await expect(page.locator('.notification')).toHaveText('Notification pending');
    await expect(page.locator('.ack')).toHaveText('Awaiting app acknowledgement');
    await page.getByRole('button', { name: 'Open note' }).click();
    await expect(page.locator('#note-text')).toContainText('File save only');
    const counters = (await (await page.request.get(f.origin + '/snapshot')).json()).counters;
    expect(counters).toEqual({ legacyNotifier: 0, ackWatcherResends: 0 });
  });
});
test('genuine frame host: busy→restart→one canonical turn→partial app ack and correlated reply preserve iframe/draft/focus/unseen', async ({
  page,
}) => {
  const host = await startIsolatedConsumerHost('room', 'none', 'canonical');
  let failed = false,
    first: unknown,
    canonicalId: string | undefined,
    interactiveHeld = false;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    await page.goto(host.origin + '/channels?id=' + host.roomId);
    await new AuthPage(page).signIn(host.ownerEmail, host.ownerPassword);
    // Each isolated host is a fresh installation outside globalSetup's server list.
    await page.getByRole('button', { name: 'Skip all setup', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Welcome to DorkOS' })).toBeHidden();
    await page.getByRole('button', { name: 'Keep asking me first', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'DorkOS runs at full power' })).toBeHidden();
    const panel = new RightPanelPage(page);
    await panel.ensureTabStripOpen();
    await panel.browserTab.click();
    const frameElement = page.locator('iframe[title="Temporary task dashboard"]');
    await expect(frameElement).toBeVisible();
    const mounted = await frameElement.elementHandle(),
      frame = await mounted?.contentFrame();
    if (!frame || !mounted) throw new Error('Original mounted document unavailable');
    await expectOriginalFrameReady(frame, frameElement);
    await frame.getByRole('button', { name: 'Open discussion' }).click();
    expect(
      (
        await page.request.post(host.origin + '/api/test/scenario', {
          data: { sessionId: host.sessionId, name: 'native-canonical-rekey' },
        })
      ).ok()
    ).toBe(true);
    interactiveHeld = true;
    expect(
      (
        await page.request.post(host.origin + '/api/sessions/' + host.sessionId + '/messages', {
          data: { content: 'Original canonical recovery subject', cwd: host.root },
        })
      ).status()
    ).toBe(202);
    await expect
      .poll(() =>
        originalHeldTurnHasText(page, host.sessionId, host.root, 'NATIVE_CANONICAL_REKEY_WAITING')
      )
      .toBe(true);
    const eventIds: string[] = [];
    for (const text of [
      'First accepted input before canonical move',
      'Second accepted input before canonical move',
    ]) {
      await frame.getByLabel('Comment').fill(text);
      const saved = await frame.evaluate(() =>
        JSON.parse(sessionStorage.getItem('temporary-doc-consumer:draft')!)
      );
      eventIds.push(saved.operationId);
      await frame.getByRole('button', { name: 'Save comment' }).click();
      await expect(
        frame.locator('[data-operation-id="' + saved.operationId + '"] .notification')
      ).toHaveText('Notification saved; waiting');
    }
    const replay = async () => {
      const response = await page.request.get(
        host.origin + '/api/canvas/docs/' + host.documentId + '/channel'
      );
      if (!response.ok()) throw new Error('Original document replay refused');
      return response.json();
    };
    const before = await replay();
    expect(
      before.events.filter((row: { event: { type: string } }) => row.event.type === 'app.ack')
    ).toHaveLength(0);
    const held = await host.readOriginalRoomScenarioData();
    expect(held.targetLocked).toBe(true);
    const subjects = held.batches.filter((batch) =>
      batch.eventIds.some((id) => eventIds.includes(id))
    );
    expect(subjects).toHaveLength(1);
    const originalBatch = subjects[0]!;
    expect(originalBatch.eventIds).toEqual(eventIds);
    await host.canonicalAction('pause');
    expect(
      (
        await page.request.post(host.origin + '/api/test/step', {
          data: { sessionId: host.sessionId },
        })
      ).ok()
    ).toBe(true);
    await expect
      .poll(async () => {
        const data = await host.readCanonicalRecoveryData();
        return data.canonicalId !== host.sessionId ? data.canonicalId : 'WAITING';
      })
      .not.toBe('WAITING');
    await expect
      .poll(async () => {
        const data = await host.readCanonicalRecoveryData();
        if (data.canonicalId === host.sessionId) return false;
        return originalHeldTurnHasText(
          page,
          data.canonicalId,
          host.root,
          'NATIVE_CANONICAL_REKEY_HELD'
        );
      })
      .toBe(true);
    const moved = await host.canonicalAction('capture');
    canonicalId = moved.canonicalId;
    if (!canonicalId || canonicalId === host.sessionId)
      throw new Error('Original canonical identity was not assigned');
    // The scenario's existing interaction key remains the original session key.
    expect(
      (
        await page.request.post(host.origin + '/api/test/step', {
          data: { sessionId: host.sessionId },
        })
      ).ok()
    ).toBe(true);
    await expect.poll(async () => (await host.readCanonicalRecoveryData()).closed).toBe(true);
    interactiveHeld = false;
    const draft = frame.getByLabel('Comment'),
      text = 'Unsaved across original native restart\n'.repeat(40);
    await draft.fill(text);
    await draft.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.focus();
      input.setSelectionRange(7, 19);
      input.scrollTop = 65;
    });
    const dom = await draft.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      return { start: input.selectionStart, end: input.selectionEnd, scroll: input.scrollTop };
    });
    expect(await host.canonicalAction('restart')).toEqual({ canonicalId, closed: true });
    const firstRow = frame.locator('[data-operation-id="' + eventIds[0] + '"]');
    const secondRow = frame.locator('[data-operation-id="' + eventIds[1] + '"]');
    await expect(firstRow.locator('.ack')).toHaveText('App acknowledged');
    await expect(secondRow.locator('.ack')).toHaveText('Awaiting app acknowledgement');
    await expect(draft).toHaveValue(text);
    await expect(draft).toBeFocused();
    expect(
      await draft.evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        return { start: input.selectionStart, end: input.selectionEnd, scroll: input.scrollTop };
      })
    ).toEqual(dom);
    expect(await frameElement.evaluate((element, original) => element === original, mounted)).toBe(
      true
    );
    const partial = await replay();
    expect(partial.incarnation).toEqual(before.incarnation);
    for (const id of eventIds) {
      expect(partial.events.find((row: { event: { id: string } }) => row.event.id === id)).toEqual(
        before.events.find((row: { event: { id: string } }) => row.event.id === id)
      );
    }
    const ack = partial.events.filter(
      (row: { event: { type: string } }) => row.event.type === 'app.ack'
    );
    expect(ack).toHaveLength(1);
    expect(ack[0].event.payload.eventIds).toEqual([eventIds[0]]);
    await frame.getByRole('button', { name: 'Close discussion' }).click();
    const focus = frame.getByRole('button', { name: 'Open discussion' });
    await focus.focus();
    expect(
      (
        await page.request.post(host.origin + '/api/test/step', {
          data: { sessionId: canonicalId },
        })
      ).ok()
    ).toBe(true);
    await expect(frame.locator('#unseen')).toBeVisible();
    await expect(focus).toBeFocused();
    await expect
      .poll(async () => {
        const data = await host.readOriginalRoomScenarioData();
        const rows = data.batches.filter(
          (batch) =>
            batch.batchId === originalBatch.batchId && batch.generation === originalBatch.generation
        );
        if (rows.length !== 1 || !rows[0]!.evidence) return 'UNKNOWN';
        return rows[0]!.evidence!.scenarioStarts === 1 && rows[0]!.evidence!.retired
          ? 'ONE_RETIRED'
          : 'ACTIVE';
      })
      .toBe('ONE_RETIRED');
    const final = await replay();
    const replies = final.events.filter(
      (row: { event: { type: string } }) => row.event.type === 'agent.reply'
    );
    expect(replies).toHaveLength(1);
    expect(replies[0].event.payload.inReplyTo).toEqual([eventIds[1]]);
    expect(
      final.events.filter((row: { event: { type: string } }) => row.event.type === 'app.ack')
    ).toHaveLength(1);
    await focus.click();
    await expect(frame.locator('#unseen')).toBeHidden();
    await expect(draft).toHaveValue(text);
    expect(
      await draft.evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        return { start: input.selectionStart, end: input.selectionEnd, scroll: input.scrollTop };
      })
    ).toEqual(dom);
  } catch (cause) {
    remember(cause);
  } finally {
    if (interactiveHeld) {
      try {
        await page.request.post(
          host.origin + '/api/sessions/' + (canonicalId ?? host.sessionId) + '/interrupt'
        );
      } catch (cause) {
        remember(cause);
      }
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
  }
  if (failed) throw first;
});

for (const target of ['session', 'room'] as const) {
  test(`isolated authenticated ${target} Canvas host and cookie preview deliver the real SDK receipt after durable file save`, async ({
    page,
  }) => {
    const host = await startIsolatedConsumerHost(target);
    let failed = false;
    let first: unknown;
    let interactiveMayBeHeld = false;
    try {
      // Signed-out context must be rejected by the real app/session gate.
      expect(
        (
          await page.request.get(host.origin + '/api/canvas/docs/' + host.documentId + '/channel')
        ).status()
      ).toBe(401);
      await page.goto(
        host.origin +
          (target === 'room'
            ? '/channels?id=' + host.roomId
            : '/session?session=' + host.sessionId + '&dir=' + encodeURIComponent(host.root))
      );
      await new AuthPage(page).signIn(host.ownerEmail, host.ownerPassword);
      // Each isolated host is a fresh installation outside globalSetup's server list.
      await page.getByRole('button', { name: 'Skip all setup', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Welcome to DorkOS' })).toBeHidden();
      await page.getByRole('button', { name: 'Keep asking me first', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'DorkOS runs at full power' })).toBeHidden();
      if (target === 'room') {
        const roomResponse = await page.request.get(host.origin + '/api/rooms/' + host.roomId);
        expect(roomResponse.status(), await roomResponse.text()).toBe(200); // Original cookie caller + registered SAME RoomService.
        expect((await roomResponse.json()).id).toBe(host.roomId);
      }
      const panel = new RightPanelPage(page);
      await panel.ensureTabStripOpen();
      await panel.browserTab.click();
      const frameElement = page.locator('iframe[title="Temporary task dashboard"]');
      await expect(frameElement).toBeVisible();
      const mounted = await frameElement.elementHandle();
      const frame = await mounted?.contentFrame();
      if (!frame) throw new Error('Actual stored-document mounted frame unavailable');
      await expectOriginalFrameReady(frame, frameElement);
      // The actual preview source differs from the privileged host origin. No
      // script is assigned to window.dorkos, and the handshake is production-owned.
      const preview = new URL(frame.url());
      expect(preview.origin).not.toBe(host.origin);
      expect(preview.origin).not.toBe(host.apiOrigin);
      const denied = await page.request.get(preview.origin + '/snapshot', {
        headers: { Cookie: '' },
      });
      expect(denied.status()).toBe(401); // Original preview cookie is required before upstream fetch.
      await frame.getByRole('button', { name: 'Open discussion' }).click();
      if (target === 'room') {
        // Actual authenticated detached dispatcher creates the original holder;
        // its registered scenario parks on the real interaction gate.
        expect(
          (
            await page.request.post(host.origin + '/api/test/scenario', {
              data: { sessionId: host.sessionId, name: 'stoppable-turn' },
            })
          ).ok()
        ).toBe(true);
        interactiveMayBeHeld = true;
        expect(
          (
            await page.request.post(host.origin + '/api/sessions/' + host.sessionId + '/messages', {
              data: { content: 'Temporary original busy subject', cwd: host.root },
            })
          ).status()
        ).toBe(202);
        await expect
          .poll(async () => (await host.readOriginalRoomScenarioData()).targetLocked)
          .toBe(true);
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
        // The running scenario already captured its function. Only a subsequent
        // original document turn uses simple-text after the held step is released.
        expect(
          (
            await page.request.post(host.origin + '/api/test/scenario', {
              data: { sessionId: host.sessionId, name: 'simple-text' },
            })
          ).ok()
        ).toBe(true);
      }
      await frame.getByLabel('Comment').fill('Actual sandbox writer and parent-native channel');
      const originalDraft = await frame.evaluate(() =>
        JSON.parse(sessionStorage.getItem('temporary-doc-consumer:draft')!)
      );
      expect(originalDraft.operationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      await host.loseNextWriterResponse();
      await frame.getByRole('button', { name: 'Save comment' }).click();
      await expect(frame.locator('#channel-status')).toHaveText(
        'File save unconfirmed; retry keeps operation ID'
      );
      await expect(frame.getByLabel('Comment')).toHaveValue(originalDraft.text);
      const retainedDraft = await frame.evaluate(() =>
        JSON.parse(sessionStorage.getItem('temporary-doc-consumer:draft')!)
      );
      expect(retainedDraft.operationId).toBe(originalDraft.operationId);
      const ambiguous = await frame.evaluate(async () => (await fetch('/snapshot')).json());
      expect(Object.keys(ambiguous.ledger.operations)).toEqual([originalDraft.operationId]);
      expect(ambiguous.ledger.operations[originalDraft.operationId].writerReceipt.operationId).toBe(
        originalDraft.operationId
      );
      expect(ambiguous.producerCounters.physicalReplacements).toBe(1);
      // Pending notification recovery may race this retry. Both paths retain the
      // same original ID; neither may repeat the physical writer effect.
      await frame.getByRole('button', { name: 'Save comment' }).click();
      await expect(frame.locator('.file')).toHaveText('File saved');
      await expect(frame.locator('.notification')).toHaveText('Notification saved; waiting');
      await expect(frame.locator('.ack')).toHaveText('Awaiting app acknowledgement');
      const saved = await frame.evaluate(async () => (await fetch('/snapshot')).json());
      const operations = Object.values(saved.ledger.operations) as Array<{
        request: { operationId: string };
        writerReceipt?: { operationId: string };
        channelReceipt?: { receipt: { id: string; docSeq: number } };
      }>;
      expect(operations).toHaveLength(1);
      const operation = operations[0]!;
      expect(operation.request.operationId).toBe(originalDraft.operationId);
      expect(operation.writerReceipt?.operationId).toBe(operation.request.operationId);
      expect(operation.channelReceipt?.receipt.id).toBe(operation.request.operationId);
      expect(operation.channelReceipt?.receipt.docSeq).toBeGreaterThan(0);
      expect(saved.producerCounters.physicalReplacements).toBe(1);
      const channelResponse = await page.request.get(
        host.origin + '/api/canvas/docs/' + host.documentId + '/channel'
      );
      expect(channelResponse.ok()).toBe(true);
      const replay = await channelResponse.json();
      expect(replay.incarnation.documentId).toBe(host.documentId);
      expect(replay.scope).toBe(
        target === 'room' ? 'room:' + host.roomId : 'session:' + host.sessionId
      );
      expect(
        replay.events.filter(
          (record: { event: { id: string } }) => record.event.id === operation.request.operationId
        )
      ).toHaveLength(1);
      expect(
        replay.events.filter(
          (record: { event: { type: string } }) => record.event.type === 'app.ack'
        )
      ).toHaveLength(0);
      if (target === 'room') {
        // Keep a distinct unsaved draft and actual focused DOM while querying
        // original Room evidence; retirement may already precede this capture.
        const draft = frame.getByLabel('Comment');
        const nextDraft = 'Unsaved after notification\n'.repeat(40);
        await draft.fill(nextDraft);
        await draft.evaluate((element) => {
          const input = element as HTMLTextAreaElement;
          input.focus();
          input.setSelectionRange(7, 19);
          input.scrollTop = 65;
        });
        const retainedDOM = await draft.evaluate((element) => {
          const input = element as HTMLTextAreaElement;
          return { start: input.selectionStart, end: input.selectionEnd, scroll: input.scrollTop };
        });
        const held = await host.readOriginalRoomScenarioData();
        expect(held.targetSessionId).toBe(host.sessionId);
        expect(held.targetLocked).toBe(true);
        expect(
          held.batches.filter((batch) => batch.eventIds.includes(operation.request.operationId))
        ).toHaveLength(1);
        // Absence of provider evidence is UNKNOWN; it is never asserted as zero.
        let stepAttempts = 0;
        await expect
          .poll(async () => {
            if (++stepAttempts > 16) throw new Error('Original step readiness control bound');
            const step = await page.request.post(host.origin + '/api/test/step', {
              data: { sessionId: host.sessionId },
            });
            if (!step.ok()) throw new Error('Original temporary step refused');
            return (await step.json()).released;
          })
          .toBe(true);
        interactiveMayBeHeld = false;
        // This comes from SAME native service/registered TestMode stream after
        // original COMMIT/FIRST. No synthetic completion or zero fallback.
        await expect
          .poll(async () => {
            const data = await host.readOriginalRoomScenarioData();
            const subjects = data.batches.filter((batch) =>
              batch.eventIds.includes(operation.request.operationId)
            );
            if (subjects.length !== 1 || !subjects[0]!.evidence) return 'UNKNOWN';
            const evidence = subjects[0]!.evidence!;
            return evidence.scenarioStarts === 1 && evidence.retired === true
              ? 'ONE_RETIRED_ORIGINAL_SCENARIO'
              : 'OBSERVED_NOT_COMPLETE';
          })
          .toBe('ONE_RETIRED_ORIGINAL_SCENARIO');
        const data = await host.readOriginalRoomScenarioData();
        expect(data.documentId).toBe(host.documentId);
        expect(data.scope).toBe('room:' + host.roomId);
        expect(data.birth).toEqual(replay.incarnation);
        const subjects = data.batches.filter((batch) =>
          batch.eventIds.includes(operation.request.operationId)
        );
        expect(subjects).toHaveLength(1);
        const subject = subjects[0]!;
        expect(subject.eventIds).toEqual([operation.request.operationId]);
        expect(subject.evidence).toMatchObject({
          documentId: host.documentId,
          batchId: subject.batchId,
          generation: subject.generation,
          sessionId: host.sessionId,
          scenarioStarts: 1,
          retired: true,
        });
        // Actual scenario completion remains separate from an app acknowledgement.
        await expect(frame.locator('.ack')).toHaveText('Awaiting app acknowledgement');
        expect(
          await frameElement.evaluate((element, original) => element === original, mounted)
        ).toBe(true);
        await expect(draft).toBeFocused();
        await expect(draft).toHaveValue(nextDraft);
        expect(
          await draft.evaluate((element) => {
            const input = element as HTMLTextAreaElement;
            return {
              start: input.selectionStart,
              end: input.selectionEnd,
              scroll: input.scrollTop,
            };
          })
        ).toEqual(retainedDOM);
        expect(
          await frame.evaluate(
            () => JSON.parse(sessionStorage.getItem('temporary-doc-consumer:draft')!).text
          )
        ).toBe(nextDraft);
      }
      // This proves only the authored mount/writer/native HTTP seam when run.
      // Native Room acquisition/COMMIT/FIRST and cancellation have separate controls.
    } catch (cause) {
      failed = true;
      first = cause;
    }
    if (interactiveMayBeHeld) {
      try {
        const interrupted = await page.request.post(
          host.origin + '/api/sessions/' + host.sessionId + '/interrupt'
        );
        if (!interrupted.ok()) throw new Error('Original temporary interactive cleanup refused');
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    }
    try {
      await page.goto('about:blank');
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    try {
      const closing = host.close(),
        repeated = host.close();
      await Promise.all([closing, repeated]);
      expect(repeated).toBe(closing); // Both callers await the same child wait/EOF/cleanup result.
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    if (failed) throw first;
  });
}
test('original bootstrap and exact-owner cleanup preserve reentrant replacements and raw undefined causes', async () => {
  const { createRoomSubsystem, setRoomService, getRoomService, clearRoomService } =
    await import('../../../server/src/services/rooms/index.js');
  const { CanvasService, peekCanvasService, clearCanvasService } =
    await import('../../../server/src/services/canvas/index.js');
  const vault = await createConsumerVault();
  let native: Awaited<ReturnType<typeof openNativeConsumerStore>> | undefined;
  let replacement: ReturnType<typeof createRoomSubsystem> | undefined;
  let failed = false,
    first: unknown;
  const originalRegistration = CanvasService.prototype.onRemoved;
  const calls = new Map<OriginalCanvasService, number>();
  let reenter: (() => void) | undefined, throwingCanvas: OriginalCanvasService | undefined;
  CanvasService.prototype.onRemoved = function (this: OriginalCanvasService, listener) {
    const unsubscribe = originalRegistration.call(this, listener);
    return () => {
      calls.set(this, (calls.get(this) ?? 0) + 1);
      const run = reenter;
      reenter = undefined;
      run?.();
      unsubscribe(); // The real registration is removed even when the control throws.
      if (this === throwingCanvas) throw undefined;
    };
  }; // Cleanup callback fault only; no actor, principal, frame or native issuer is replaced.
  try {
    native = await openNativeConsumerStore(vault, 'http://127.0.0.1:4242/consumer/dashboard');
    expect(getRoomService()).toBe(native.rooms.service);
    expect(peekCanvasService()).toBe(native.rooms.canvas);
    expect((await native.replay()).incarnation.documentId).toBe(native.documentId);
    let observed = false;
    try {
      createRoomSubsystem({
        db: native.db,
        budget: native.budget,
        get readCursors(): never {
          throw undefined;
        },
      });
    } catch (cause) {
      observed = true;
      expect(cause).toBeUndefined();
    }
    expect(observed).toBe(true);
    expect(peekCanvasService()).toBeUndefined();
    replacement = createRoomSubsystem({ db: native.db, budget: native.budget });
    setRoomService(replacement.service);
    throwingCanvas = native.rooms.canvas;
    reenter = () => native!.rooms.service.canvas.dispose();
    const closing = native.close();
    let closeRefused = false;
    try {
      await closing;
    } catch (cause) {
      closeRefused = true;
      expect(cause).toBeUndefined();
    }
    expect(closeRefused).toBe(true);
    expect(native.close()).toBe(closing);
    await expect(native.close()).rejects.toBeUndefined();
    expect(calls.get(native.rooms.canvas)).toBe(1); // Reentry and repeat never invoke a second unsubscribe.
    expect(native.db.$client.open).toBe(false); // Throwing disposer did not skip the independently owned Db.
    expect(getRoomService()).toBe(replacement.service);
    expect(peekCanvasService()).toBe(replacement.canvas);
    expect(clearRoomService(native.rooms.service)).toBe(false);
    expect(clearCanvasService(native.rooms.canvas)).toBe(false);
  } catch (cause) {
    failed = true;
    first = cause;
  }
  // Restore the method before any further original construction, and dispose
  // all captured owners independently even when an assertion failed.
  CanvasService.prototype.onRemoved = originalRegistration;
  const drain = async (run: () => unknown) => {
    try {
      await run();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  };
  // The intentionally refused original close was already joined above.
  if (native && native.db.$client.open) await drain(() => native!.close());
  if (replacement) {
    await drain(() => replacement!.service.canvas.dispose());
    await drain(() => clearRoomService(replacement!.service));
    await drain(() => clearCanvasService(replacement!.canvas));
  }
  await drain(() => vault.close());
  if (failed) throw first;
});

test('durable Undo evidence names both actual channel receipts and rechecks the current physical baseline without issuing cancellation', async () => {
  await owned(async (fixture) => {
    const first = await fixture.vault.write({
      operationId: randomUUID(),
      kind: 'toggle',
      checked: true,
    });
    await expect(
      fixture.vault.inspectUndoPair(first.request.operationId, randomUUID())
    ).rejects.toThrow('BOTH_DURABLE_RECEIPTS_REQUIRED');
    await fixture.flushStore();
    const second = await fixture.vault.write({
      operationId: randomUUID(),
      kind: 'undo',
      originalOperationId: first.request.operationId,
    });
    await expect(
      fixture.vault.inspectUndoPair(first.request.operationId, second.request.operationId)
    ).rejects.toThrow('BOTH_DURABLE_RECEIPTS_REQUIRED');
    await fixture.flushStore();
    const evidence = await fixture.vault.inspectUndoPair(
      first.request.operationId,
      second.request.operationId
    );
    expect(evidence.operationIds).toEqual([first.request.operationId, second.request.operationId]);
    expect(evidence.writerReceipts.map((receipt) => receipt.operationId)).toEqual(
      evidence.operationIds
    );
    expect(evidence.channelReceipts.map((receipt) => receipt.receipt.id)).toEqual(
      evidence.operationIds
    );
    expect(evidence.currentPhysicalHash).toBe(first.beforeHash);
    expect((await fixture.vault.snapshot()).producerCounters.physicalReplacements).toBe(2);
    // Writer/store evidence has no native cancellation effect. An external
    // edit invalidates it even when the old two durable receipts still exist.
    await writeFile(join(fixture.vault.root, 'notes/task.md'), '# External restore\n');
    await expect(
      fixture.vault.inspectUndoPair(first.request.operationId, second.request.operationId)
    ).rejects.toThrow('BASELINE_CHANGED');
  });
});

test('native FILE initial empty replay carries genuine birth/scope and one admitted TestMode producer stays unacknowledged', async () => {
  const vault = await createConsumerVault();
  let native: Awaited<ReturnType<typeof openNativeConsumerStore>> | undefined;
  let failed = false,
    first: unknown;
  try {
    native = await openNativeConsumerStore(vault, 'http://127.0.0.1:1/dashboard');
    expect(native.initial.events).toHaveLength(0);
    expect(native.initial.incarnation?.documentId).toBe(native.documentId);
    expect(native.initial.scope).toBe('session:' + native.sessionId);
    const op = await vault.write({
      operationId: randomUUID(),
      kind: 'comment',
      text: 'native original subject',
    });
    expect(op.writerReceipt?.operationId).toBe(op.request.operationId);
    expect(op.handoff).toBe('pending');
    await vault.beginHandoff(op.request.operationId);
    const accepted = await native.emit(op.event);
    await vault.recordChannel(op.request.operationId, accepted);
    const admitted = native.admit();
    expect(native.startAccepted()).toBe(1);
    expect(native.startAccepted()).toBe(0);
    const actual = native;
    await expect.poll(() => actual.producerCounts().physicalStarts).toBe(1);
    await expect
      .poll(() =>
        actual.db.$client
          .prepare(
            "SELECT state, settle_outcome AS outcome FROM session_message_acceptance_receipts WHERE id=? AND source_kind='document_event_batch'"
          )
          .get(admitted.receipt.id)
      )
      .toMatchObject({ state: 'settled', outcome: 'completed' });
    const replay = await native.replay();
    expect(replay.events.filter((frame) => frame.event.id === op.request.operationId)).toHaveLength(
      1
    );
    expect(replay.events.filter((frame) => frame.event.type === 'app.ack')).toHaveLength(0);
    const delivery = replay.receipts.find(
      (row) => row.receipt.id === op.request.operationId
    )?.deliveries;
    expect(delivery).toHaveLength(1);
    expect(delivery![0]!.ackOutcome ?? null).toBeNull();
    // This is original session acceptance/TestMode I/O. It is not a Room FIRST/COMMIT
    // proof, an actual HTTP/frame mount, or a correlated acknowledgement substitute.
  } catch (cause) {
    failed = true;
    first = cause;
  }
  try {
    await native?.close();
  } catch (cause) {
    if (!failed) {
      failed = true;
      first = cause;
    }
  }
  try {
    await vault.close();
  } catch (cause) {
    if (!failed) {
      failed = true;
      first = cause;
    }
  }
  if (failed) throw first;
});

test('two original managed Doc frames correlate log-only receipts across tabs and refuse an unowned sibling', async ({
  page,
}) => {
  const host = await startIsolatedConsumerHost('session', 'none', 'none', 'log-only');
  let second: import('@playwright/test').Page | undefined;
  let secondNavigation: ReturnType<import('@playwright/test').Page['goto']> | undefined;
  let failed = false,
    first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const location =
    host.origin + '/session?session=' + host.sessionId + '&dir=' + encodeURIComponent(host.root);
  try {
    expect(host.frameDeclarationAbsent).toBe(true);
    await page.goto(location);
    await new AuthPage(page).signIn(host.ownerEmail, host.ownerPassword);
    await page.getByRole('button', { name: 'Skip all setup', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Welcome to DorkOS' })).toBeHidden();
    await page.getByRole('button', { name: 'Keep asking me first', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'DorkOS runs at full power' })).toBeHidden();
    // Load the second authenticated tab while the first original frame mounts.
    second = await page.context().newPage();
    secondNavigation = second.goto(location);
    // Observe concurrent rejection immediately; retain the original first cause.
    void secondNavigation.catch(remember);
    const firstPanel = new RightPanelPage(page);
    await firstPanel.ensureTabStripOpen();
    await firstPanel.browserTab.click();
    const firstElement = page.locator('iframe[title="Temporary task dashboard"]');
    await expect(firstElement).toBeVisible();
    const firstFrame = await (await firstElement.elementHandle())?.contentFrame();
    if (!firstFrame) throw new Error('First original managed frame unavailable');
    await expectOriginalFrameReady(firstFrame, firstElement);
    await secondNavigation;
    // Same authenticated owner/context; the next original per-launch consent is a real UI decision.
    const consent = second.getByRole('dialog', {
      name: 'Share anonymous usage data?',
      exact: true,
    });
    await expect(consent).toBeVisible();
    await consent.getByRole('button', { name: 'Don’t share', exact: true }).click();
    await expect(consent).toBeHidden();
    const secondPanel = new RightPanelPage(second);
    await secondPanel.ensureTabStripOpen();
    await secondPanel.browserTab.click();
    const secondElement = second.locator('iframe[title="Temporary task dashboard"]');
    await expect(secondElement).toBeVisible();
    const secondFrame = await (await secondElement.elementHandle())?.contentFrame();
    if (!secondFrame) throw new Error('Second original managed frame unavailable');
    await expectOriginalFrameReady(secondFrame, secondElement);
    expect(secondFrame).not.toBe(firstFrame);
    const siblingSource = firstFrame.url();
    const siblingSandbox = await firstElement.getAttribute('sandbox');
    if (!siblingSandbox) throw new Error('Original managed sandbox unavailable');
    await page.evaluate(
      ({ source, sandbox }) => {
        const iframe = document.createElement('iframe');
        iframe.title = 'Unowned original-source sibling';
        iframe.setAttribute('sandbox', sandbox);
        iframe.src = source;
        document.body.append(iframe);
      },
      { source: siblingSource, sandbox: siblingSandbox }
    );
    const siblingElement = page.locator('iframe[title="Unowned original-source sibling"]');
    await expect(siblingElement).toBeVisible();
    const sibling = await (await siblingElement.elementHandle())?.contentFrame();
    if (!sibling) throw new Error('Actual unowned sibling unavailable');
    await expect
      .poll(() =>
        sibling.evaluate(
          () =>
            (window as unknown as { dorkos?: { channel?: { status: string } } }).dorkos?.channel
              ?.status
        )
      )
      .toBe('offline');
    expect(
      await sibling.evaluate(async () => {
        const sdk = (
          window as unknown as {
            dorkos: {
              channel: {
                emit(type: string, payload: unknown): Promise<unknown>;
              };
            };
          }
        ).dorkos.channel;
        try {
          await sdk.emit('task.comment', { text: 'Unowned sibling' });
          return 'accepted';
        } catch (cause) {
          return cause && typeof cause === 'object' && 'outcome' in cause
            ? cause.outcome
            : 'unknown';
        }
      })
    ).toBe('cancelled');
    // Same-page code has only the public untrusted SDK; reserved host/application outcomes stay refused.
    expect(
      await firstFrame.evaluate(async () => {
        const sdk = (
          window as unknown as {
            dorkos: {
              channel: {
                emit(type: string, payload: unknown): Promise<unknown>;
              };
            };
          }
        ).dorkos.channel;
        try {
          await sdk.emit('app.ack', { outcome: 'handled' });
          return 'accepted';
        } catch (cause) {
          return cause && typeof cause === 'object' && 'outcome' in cause
            ? cause.outcome
            : 'unknown';
        }
      })
    ).toBe('refused');

    const before = await page.request.get(
      host.origin + '/api/canvas/docs/' + host.documentId + '/channel'
    );
    expect(before.status()).toBe(200);
    const baseline = await before.json();
    expect(baseline.routing.enabled).toBe(false);
    const inputs = [
      { id: randomUUID(), text: 'First original frame context' },
      { id: randomUUID(), text: 'Second original frame context' },
    ];
    const receipts = await Promise.all(
      [firstFrame, secondFrame].map((frame, index) =>
        frame.evaluate(async (input) => {
          const sdk = (
            window as unknown as {
              dorkos: {
                channel: {
                  emit(type: string, payload: unknown, options: { id: string }): Promise<unknown>;
                };
              };
            }
          ).dorkos.channel;
          return sdk.emit('task.comment', { text: input.text }, { id: input.id });
        }, inputs[index]!)
      )
    );
    for (const [index, receipt] of receipts.entries())
      expect(receipt).toMatchObject({
        receipt: { id: inputs[index]!.id, status: 'recorded', docSeq: expect.any(Number) },
        deliveries: [],
      });
    const response = await page.request.get(
      host.origin + '/api/canvas/docs/' + host.documentId + '/channel'
    );
    expect(response.status()).toBe(200);
    const replay = await response.json();
    expect(replay.incarnation).toEqual(baseline.incarnation);
    expect(replay.routing.enabled).toBe(false);
    const comments = replay.events.filter(
      (row: { event: { type: string } }) => row.event.type === 'task.comment'
    );
    expect(comments).toHaveLength(2);
    for (const input of inputs)
      expect(
        comments.filter(
          (row: { event: { id: string; payload: unknown } }) =>
            row.event.id === input.id &&
            JSON.stringify(row.event.payload) === JSON.stringify({ text: input.text })
        )
      ).toHaveLength(1);
    await expectOriginalFrameReady(firstFrame, firstElement);
    await expectOriginalFrameReady(secondFrame, secondElement);
  } catch (cause) {
    remember(cause);
  }
  const retire = [
    page.goto('about:blank').catch(remember),
    ...(second ? [second.close().catch(remember)] : []),
    ...(secondNavigation ? [secondNavigation.catch(remember)] : []),
    host.close().catch(remember),
  ];
  await Promise.allSettled(retire);
  if (failed) throw first;
});
