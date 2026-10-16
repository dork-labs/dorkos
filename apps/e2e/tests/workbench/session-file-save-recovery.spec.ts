/** Explicit current-birth receipt recovery; no draft persistence, effect replay or delivery claim. */
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Page, Request } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { RightPanelPage } from '../../pages/RightPanelPage';
import {
  FileSaveDiscoverySchema,
  FileSaveRecoverResultSchema,
} from '@dorkos/shared/file-save/recovery';
import {
  openRecoveryFile,
  openRecoveryDatabase,
  intent,
  refuseReceipt,
  recordLostSave,
  remountRecovery,
  replace,
  cleanup,
} from '../../fixtures/file-save-recovery';
test.use({ trace: 'retain-on-failure', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial' });
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function effects(page: Page, path: string) {
  const puts: Request[] = [],
    recoveries: Request[] = [];
  const listener = (request: Request) => {
    const url = new URL(request.url());
    if (
      request.method() === 'PUT' &&
      url.pathname === '/api/files/content' &&
      request.postDataJSON().path === path
    )
      puts.push(request);
    if (request.method() === 'POST' && /\/file-saves\/[^/]+\/recover$/u.test(url.pathname))
      recoveries.push(request);
  };
  page.on('request', listener);
  return { puts, recoveries, stop: () => page.off('request', listener) };
}
async function discovery(page: Page, documentId: string) {
  const response = await page.request.get(
    `/api/canvas/docs/${encodeURIComponent(documentId)}/file-saves`
  );
  expect(response.ok()).toBe(true);
  return FileSaveDiscoverySchema.parse(await response.json());
}
function identity(stat: Stats) {
  return { dev: stat.dev, ino: stat.ino };
}

test('refresh discovers the original committed UUID without restoring a disposed draft or repeating a write', async ({
  page,
  request,
}, testInfo) => {
  const db = await openRecoveryDatabase(
    testInfo.project.name,
    testInfo.project.metadata.fileSaveRecoveryHome
  );
  let stop: undefined | (() => void);
  try {
    const f = await openRecoveryFile(page, request),
      wire = effects(page, f.path);
    stop = wire.stop;
    const input = await recordLostSave(page, f.path, 'Original committed browser recovery bytes.');
    const eventId = input.documentSave!.eventId,
      birth = input.documentSave!.incarnation;
    const original = intent(db, f.documentId, eventId),
      physical = identity(await fs.stat(f.path));
    expect(original.status).toBe('committed');
    // This later draft was NEVER admitted. Refresh intentionally loses it; discovery must not resurrect it.
    const disposed = 'Unsaved private draft must not be reconstructed from receipt history.';
    await replace(page, f.editor, disposed);
    await page.getByRole('button', { name: 'Finish editing', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry original save', exact: true })
    ).toBeEnabled();
    const panel = await remountRecovery(page);
    await expect(
      panel.getByText(`${eventId}: Historical save recorded`, { exact: true })
    ).toBeVisible();
    const found = await discovery(page, f.documentId);
    expect(found.incarnation).toEqual(birth);
    expect(found.entries).toHaveLength(1);
    expect(found.entries[0]).toMatchObject({ eventId, state: 'receipt', historical: true });
    expect(wire.puts).toHaveLength(1);
    expect(wire.recoveries).toHaveLength(0);
    expect(intent(db, f.documentId, eventId)).toEqual(original);
    expect(identity(await fs.stat(f.path))).toEqual(physical);
    expect(
      (await f.channel()).events.filter((frame) => frame.event.type === 'doc.saved')
    ).toHaveLength(1);
    await page.getByRole('button', { name: 'Edit file', exact: true }).click();
    await expect(page.locator('.cm-content[contenteditable="true"]')).toHaveText(input.content);
    await expect(page.locator('.cm-content[contenteditable="true"]')).not.toHaveText(disposed);
  } finally {
    try {
      stop?.();
      await cleanup(page, request);
    } finally {
      db.close();
    }
  }
});

test('explicit proof recovery settles the staged original UUID without PUT, replacement or new event identity', async ({
  page,
  request,
}, testInfo) => {
  const db = await openRecoveryDatabase(
    testInfo.project.name,
    testInfo.project.metadata.fileSaveRecoveryHome
  );
  let allow: undefined | (() => void), stop: undefined | (() => void);
  try {
    const f = await openRecoveryFile(page, request),
      wire = effects(page, f.path);
    stop = wire.stop;
    allow = refuseReceipt(db, f.documentId);
    const input = await recordLostSave(
      page,
      f.path,
      'One genuine replacement; original receipt was refused.',
      { failedReceipt: true }
    );
    const eventId = input.documentSave!.eventId,
      original = intent(db, f.documentId, eventId);
    expect(original.status).toBe('in_doubt');
    expect(original.replacement_inode).not.toBeNull();
    expect(
      (await f.channel()).events.filter((frame) => frame.event.type === 'doc.saved')
    ).toHaveLength(0);
    const physical = identity(await fs.stat(f.path));
    allow();
    allow = undefined;
    const panel = await remountRecovery(page);
    await expect(
      panel.getByText(`${eventId}: Original save needs review`, { exact: true })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit file', exact: true })).toBeDisabled();
    expect(wire.recoveries).toHaveLength(0);
    expect(wire.puts).toHaveLength(1);
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname.endsWith(`/file-saves/${eventId}/recover`)
    );
    await panel.getByRole('button', { name: 'Recover original receipt', exact: true }).click();
    const settled = await response;
    expect(settled.ok()).toBe(true);
    const result = FileSaveRecoverResultSchema.parse(await settled.json());
    expect(result.entry).toMatchObject({
      eventId,
      state: 'receipt',
      historical: true,
      currentFileMatch: 'same_saved_replacement',
      receipt: {
        eventId,
        fileHash: hash(input.content),
        incarnation: input.documentSave!.incarnation,
      },
    });
    await expect(
      panel.getByText('Previous save confirmed. Your current draft may differ.', { exact: true })
    ).toBeVisible();
    expect(wire.recoveries).toHaveLength(1);
    expect(wire.puts).toHaveLength(1);
    expect(wire.recoveries[0]!.postDataJSON()).toEqual({
      expectedIncarnation: input.documentSave!.incarnation,
    });
    const after = intent(db, f.documentId, eventId);
    expect(after).toEqual({ ...original, status: 'committed', doc_seq: expect.any(Number) });
    expect(identity(await fs.stat(f.path))).toEqual(physical);
    expect(await fs.readFile(f.path, 'utf8')).toBe(input.content);
    const events = (await f.channel()).events.filter((frame) => frame.event.type === 'doc.saved');
    expect(events).toHaveLength(1);
    expect(events[0]!.event.id).toBe(eventId);
    expect(
      db
        .prepare('SELECT count(*) AS n FROM canvas_doc_file_save_intents WHERE document_id=?')
        .get(f.documentId)
    ).toEqual({ n: 1 });
    // A separate explicit load reads current bytes, not the receipt's historical hash as a cache value.
    const later = 'An independent writer changed the file after that historical receipt.';
    await fs.writeFile(f.path, later);
    await panel.getByRole('button', { name: 'Load current file', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit file', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Edit file', exact: true }).click();
    await expect(page.locator('.cm-content[contenteditable="true"]')).toHaveText(later);
    expect(wire.puts).toHaveLength(1);
  } finally {
    try {
      allow?.();
      stop?.();
      await cleanup(page, request);
    } finally {
      db.close();
    }
  }
});

test('a durable prepared phase without replacement proof stays manual and never means vacant', async ({
  page,
  request,
}, testInfo) => {
  const db = await openRecoveryDatabase(
    testInfo.project.name,
    testInfo.project.metadata.fileSaveRecoveryHome
  );
  let allow: undefined | (() => void), stop: undefined | (() => void);
  try {
    const f = await openRecoveryFile(page, request),
      wire = effects(page, f.path);
    stop = wire.stop;
    allow = refuseReceipt(db, f.documentId);
    const input = await recordLostSave(
      page,
      f.path,
      'Real input retained with intentionally unavailable staged proof.',
      { failedReceipt: true }
    );
    const eventId = input.documentSave!.eventId;
    expect(intent(db, f.documentId, eventId).status).toBe('in_doubt');
    allow();
    allow = undefined;
    // Controlled durable-phase simulation, not a claim that a real process crashed before rename.
    // Original UUID/request/owner/source/birth stay real; erase only staged proof and respect all CHECKs.
    const changed = db
      .prepare(
        "UPDATE canvas_doc_file_save_intents SET status='prepared',replacement_device=NULL,replacement_inode=NULL,doc_seq=NULL WHERE document_id=? AND event_id=? AND status='in_doubt'"
      )
      .run(f.documentId, eventId);
    expect(changed.changes).toBe(1);
    const before = intent(db, f.documentId, eventId),
      physical = identity(await fs.stat(f.path));
    const panel = await remountRecovery(page);
    await expect(
      panel.getByText('This save needs manual review. These controls won’t write the file.', {
        exact: true,
      })
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Recover original receipt', exact: true })
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit file', exact: true })).toBeDisabled();
    const found = await discovery(page, f.documentId);
    expect(found.admission).toBe('blocked');
    expect(found.entries).toEqual([
      expect.objectContaining({ eventId, state: 'review', reason: 'prepared_without_replacement' }),
    ]);
    await panel.getByRole('button', { name: 'Check previous saves', exact: true }).click();
    await expect(panel.getByText('Checking previous saves…', { exact: true })).toHaveCount(0);
    expect(wire.recoveries).toHaveLength(0);
    expect(wire.puts).toHaveLength(1);
    expect(intent(db, f.documentId, eventId)).toEqual(before);
    expect(identity(await fs.stat(f.path))).toEqual(physical);
    expect(
      (await f.channel()).events.filter((frame) => frame.event.type === 'doc.saved')
    ).toHaveLength(0);
  } finally {
    try {
      allow?.();
      stop?.();
      await cleanup(page, request);
    } finally {
      db.close();
    }
  }
});

test('an old hidden view’s held current-file read cannot replace the reopened owner’s newer draft or selection', async ({
  page,
  request,
}) => {
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  let failure: unknown;
  let handler: undefined | Parameters<Page['route']>[1];
  let heldOnce = false;
  let finish!: () => void;
  const finished = new Promise<void>((done) => {
    finish = done;
  });
  try {
    const f = await openRecoveryFile(page, request);
    await page.getByRole('button', { name: 'Finish editing', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Previous file saves' });
    handler = async (route) => {
      const url = new URL(route.request().url());
      if (
        heldOnce ||
        route.request().method() !== 'GET' ||
        url.searchParams.get('path') !== f.path
      ) {
        await route.continue();
        return;
      }
      heldOnce = true;
      try {
        const response = await route.fetch();
        entered();
        await held;
        await route.fulfill({ response });
      } catch (cause) {
        failure = cause;
        entered();
        await route.abort().catch(() => {});
      } finally {
        finish();
      }
    };
    await page.route('**/api/files/content?*', handler);
    await panel.getByRole('button', { name: 'Load current file', exact: true }).click();
    await started;
    await expect(page.getByRole('button', { name: 'Edit file', exact: true })).toBeDisabled();
    // X hides the view; it is deliberately NOT the Remove document/DELETE action.
    const views = new RightPanelPage(page);
    await views.header
      .getByRole('button', { name: 'Close Ordinary save receipt view', exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    const fresh = 'A different current file observed by the reopened view.';
    await fs.writeFile(f.path, fresh);
    await views.header.getByRole('button', { name: 'Add view', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Ordinary save receipt', exact: true }).click();
    const reopened = page.getByRole('region', { name: 'Previous file saves' });
    await expect(page.getByRole('button', { name: 'Edit file', exact: true })).toBeEnabled();
    await reopened.getByRole('button', { name: 'Load current file', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit file', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Edit file', exact: true }).click();
    await expect(page.locator('.cm-content[contenteditable="true"]')).toHaveText(fresh);
    const editor = page.locator('.cm-content[contenteditable="true"]');
    await replace(page, editor, 'A newer local draft retains its own selection.');
    await editor.evaluate((element) => {
      const text = element.firstChild?.firstChild ?? element.firstChild;
      if (!text) throw new Error('Missing source text');
      const range = document.createRange();
      range.setStart(text, 2);
      range.setEnd(text, 7);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    const selected = await page.evaluate(() => window.getSelection()?.toString());
    expect(selected).toBeTruthy();
    release();
    await finished;
    if (failure) throw failure;
    await page.unroute('**/api/files/content?*', handler);
    handler = undefined;
    await expect(
      reopened.getByRole('button', { name: 'Load current file', exact: true })
    ).toBeDisabled();
    await expect(editor).toHaveText('A newer local draft retains its own selection.');
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected);
  } finally {
    release?.();
    if (handler) await page.unroute('**/api/files/content?*', handler);
    await cleanup(page, request);
  }
});

test('hiding and reopening an uncertain view shows original history but does not clear the retained local removal barrier', async ({
  page,
  request,
}) => {
  let deletes = 0;
  const listener = (r: Request) => {
    if (r.method() === 'DELETE' && new URL(r.url()).pathname.includes('/canvas/')) deletes++;
  };
  page.on('request', listener);
  try {
    const f = await openRecoveryFile(page, request);
    const input = await recordLostSave(
      page,
      f.path,
      'Committed bytes with an unconfirmed former view.'
    );
    const views = new RightPanelPage(page);
    await views.header
      .getByRole('button', { name: 'Close Ordinary save receipt view', exact: true })
      .click();
    await expect(page.getByRole('region', { name: 'Previous file saves' })).toHaveCount(0);
    await views.header.getByRole('button', { name: 'Add view', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Ordinary save receipt', exact: true }).click();
    await expect(
      page.getByText(`${input.documentSave!.eventId}: Historical save recorded`, { exact: true })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Add view', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Remove document', exact: true }).click();
    // The async refusal must finish, rather than only asserting the already-present tab.
    await expect(
      page.getByText('Save this document before closing it', { exact: true })
    ).toBeVisible();
    expect(deletes).toBe(0);
    await expect(
      page.getByRole('tab', { name: 'Ordinary save receipt', exact: true })
    ).toBeVisible();
    expect((await discovery(page, f.documentId)).entries).toEqual([
      expect.objectContaining({ eventId: input.documentSave!.eventId, state: 'receipt' }),
    ]);
  } finally {
    page.off('request', listener);
    await cleanup(page, request);
  }
});

test('the bounded recent window does not hide an older unresolved admission fence', async ({
  page,
  request,
}, testInfo) => {
  const db = await openRecoveryDatabase(
    testInfo.project.name,
    testInfo.project.metadata.fileSaveRecoveryHome
  );
  try {
    const f = await openRecoveryFile(page, request);
    await page.getByRole('button', { name: 'Finish editing', exact: true }).click();
    const birth = (await f.channel()).incarnation;
    if (!birth) throw new Error('Current real birth missing');
    const ids: string[] = [];
    const physical = identity(await fs.stat(f.path));
    // Produce authentic no-op evidence through the real installed file API, not invented summary rows.
    for (let index = 0; index < 27; index++) {
      const eventId = randomUUID();
      ids.push(eventId);
      const result = await request.put('/api/files/content', {
        data: {
          cwd: f.cwd,
          path: f.path,
          content: f.initial,
          expectedContent: f.initial,
          documentSave: { documentId: f.documentId, eventId, incarnation: birth },
        },
      });
      expect(result.ok()).toBe(true);
      expect(intent(db, f.documentId, eventId).status).toBe('no_op');
    }
    expect(ids).toHaveLength(27);
    const oldest = db
      .prepare(
        "SELECT event_id FROM canvas_doc_file_save_intents WHERE document_id=? AND status='no_op' ORDER BY updated_at ASC,intent_id ASC LIMIT 1"
      )
      .get(f.documentId) as { event_id: string };
    // Simulate a retained early prepared phase on the oldest authentic input; no effect is replayed.
    expect(
      db
        .prepare(
          "UPDATE canvas_doc_file_save_intents SET status='prepared' WHERE document_id=? AND event_id=? AND status='no_op'"
        )
        .run(f.documentId, oldest.event_id).changes
    ).toBe(1);
    const panel = await remountRecovery(page),
      found = await discovery(page, f.documentId);
    expect(found.entries).toHaveLength(25);
    expect(found.hasMore).toBe(true);
    expect(found.admission).toBe('blocked');
    expect(found.entries.map((entry) => entry.eventId)).not.toContain(oldest.event_id);
    await expect(
      panel.getByText('Only the latest 25 matching saves are shown. Older evidence is omitted.', {
        exact: true,
      })
    ).toBeVisible();
    await expect(
      panel.getByText(
        'An unresolved original save blocks this file. This list may not include the blocking operation.',
        { exact: true }
      )
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit file', exact: true })).toBeDisabled();
    expect(identity(await fs.stat(f.path))).toEqual(physical);
    expect(await fs.readFile(f.path, 'utf8')).toBe(f.initial);
    expect(
      (await f.channel()).events.filter((frame) => frame.event.type === 'doc.saved')
    ).toHaveLength(0);
  } finally {
    try {
      await cleanup(page, request);
    } finally {
      db.close();
    }
  }
});
