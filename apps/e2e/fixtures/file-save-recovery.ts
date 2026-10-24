/** Real production open/save front door; only fault injection touches the private test-mode SQLite. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { expect } from '../fixtures';
import { ChatPage } from '../pages/ChatPage';
import { RightPanelPage } from '../pages/RightPanelPage';
import { CanvasChannelReplayResponseSchema } from '@dorkos/shared/canvas-channel-schemas';
import { WriteFileRequestSchema, type WriteFileRequest } from '@dorkos/shared/schemas';
const FILE = 'ordinary-file-save-receipt.txt';
/** Open the real session FILE through the maintained credential-free turn and editor UI. */
export async function openRecoveryFile(page: Page, request: APIRequestContext) {
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
  return {
    path,
    cwd: agentDir,
    initial,
    sessionId,
    documentId: document.id,
    channel,
    editor,
    url: page.url(),
  };
}
/** Enter a draft through the real CodeMirror editable surface. */
export async function replace(page: Page, editor: ReturnType<Page['locator']>, text: string) {
  await editor.click();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}
/** Unmount while the owned source exists and reset only this session scenario. */
export async function cleanup(page: Page, request: APIRequestContext) {
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

/** Only the maintained credential-free project and its existing private home may inject SQLite faults. */
export async function openRecoveryDatabase(
  projectName: string,
  home: unknown
): Promise<Database.Database> {
  if (projectName !== 'chromium-browser-driving')
    throw new Error('Recovery faults require the credential-free test-mode project');
  if (typeof home !== 'string' || !/^\/tmp\/dorkos-test-mode-\d{4,5}$/u.test(home))
    throw new Error('Missing maintained private test-mode home');
  const path = join(home, 'dork.db');
  const actual = await fs.realpath(path),
    root = await fs.realpath(home);
  if (actual !== join(root, 'dork.db')) throw new Error('Refuse symlinked test database');
  const homeStat = await fs.stat(home);
  if ((homeStat.mode & 0o777) !== 0o700 || homeStat.uid !== process.getuid?.())
    throw new Error('Refuse nonprivate/nonowned test home');
  const db = new Database(path, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}
/** Read the original durable evidence without disclosing it through a new application endpoint. */
export function intent(db: Database.Database, documentId: string, eventId: string) {
  const row = db
    .prepare(
      'SELECT intent_id,event_id,document_id,status,request_hash,incarnation,source,owner,canonical_path,before_device,before_inode,before_hash,after_hash,replacement_device,replacement_inode,doc_seq FROM canvas_doc_file_save_intents WHERE document_id=? AND event_id=?'
    )
    .get(documentId, eventId);
  if (!row || typeof row !== 'object')
    throw new Error('The genuine original durable intent is missing');
  return row as Record<string, unknown>;
}
/** Fixed document-only INSERT refusal, after the real operation has staged/replaced the file. */
export function refuseReceipt(db: Database.Database, documentId: string): () => void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(documentId)) throw new Error('Unexpected document identifier');
  if (
    !db.prepare('SELECT document_id FROM canvas_doc_channels WHERE document_id=?').get(documentId)
  )
    throw new Error('Database is not the actual opened document server');
  const name = `recovery_receipt_${randomUUID().replaceAll('-', '')}`;
  db.exec(
    `CREATE TRIGGER ${name} BEFORE INSERT ON canvas_doc_events WHEN NEW.document_id='${documentId}' AND NEW.type='doc.saved' BEGIN SELECT RAISE(ABORT,'browser receipt proof fault'); END`
  );
  return () => db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}
/**
 * Reload the actual session and wait until its previous-saves check settles.
 *
 * Returns the notice region, which exists only when the file needs the person:
 * a healthy file shows nothing above it, so callers assert its presence or
 * absence themselves.
 */
export async function remountRecovery(page: Page) {
  await page.reload();
  const panel = new RightPanelPage(page);
  await panel.ensureTabStripOpen();
  await panel.selectView('Canvas');
  await page.getByRole('tab', { name: 'Ordinary save receipt', exact: true }).click();
  await expect(page.getByText('Checking previous saves…', { exact: true })).toHaveCount(0);
  const evidence = page.getByRole('region', { name: 'Previous file saves' });
  // The original physical document must still be selectable; reload never opens a replacement document.
  await expect(page.getByRole('button', { name: 'Edit file', exact: true })).toHaveAttribute(
    'data-document-save-observation',
    'ready'
  );
  return evidence;
}
/** Lose the browser reply only after the installed server processed the genuine bound save. */
export async function recordLostSave(
  page: Page,
  path: string,
  content: string,
  { failedReceipt = false }: { failedReceipt?: boolean } = {}
) {
  let input: WriteFileRequest | undefined, failure: unknown;
  const calls: WriteFileRequest[] = [];
  const handler = async (route: Route) => {
    if (route.request().method() !== 'PUT' || route.request().postDataJSON().path !== path) {
      await route.continue();
      return;
    }
    try {
      input = WriteFileRequestSchema.parse(route.request().postDataJSON());
      calls.push(input);
      if (!input.documentSave) throw new Error('Bound receipt input missing');
      const response = await route.fetch();
      expect(response.ok()).toBe(!failedReceipt);
      // Even the failed receipt path must have performed the one real replacement before its fault.
      expect(await fs.readFile(path, 'utf8')).toBe(content);
      await route.abort('failed');
    } catch (cause) {
      failure = cause;
      await route.abort().catch(() => {});
    }
  };
  await page.route('**/api/files/content', handler);
  try {
    await replace(page, page.locator('.cm-content[contenteditable="true"]'), content);
    await expect(
      page.getByRole('button', { name: 'Retry original save', exact: true })
    ).toBeEnabled();
    if (failure) throw failure;
    expect(calls).toHaveLength(1);
    if (!input?.documentSave) throw new Error('Original bound operation was not captured');
    return input;
  } finally {
    await page.unroute('**/api/files/content', handler);
  }
}
