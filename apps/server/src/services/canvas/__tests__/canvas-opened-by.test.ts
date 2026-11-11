/**
 * "Opened by" (DOR-3293, Security 2026-11-10): host-written metadata on a
 * canvas document's record, never in its content. Only the session route sets
 * it, for the host, when an app's frame asks; no agent can write or keep it.
 *
 * Runs against a real SQLite database and the real `CanvasService`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { canvasDocuments, createDb, eq, runMigrations, type Db } from '@dorkos/db';
import type { UiCommand } from '@dorkos/shared/schemas';
import { CanvasDocumentStore } from '../canvas-document-store.js';
import { CanvasService } from '../canvas-service.js';
import { roomScope, sessionScope, SESSION_AGENT_AUTHOR, SESSION_OWNER_AUTHOR } from '../scopes.js';

const SCOPE = sessionScope('sess-opened-by');
const PAGE = { type: 'browser', url: 'http://localhost:5173/', title: 'Preview' } as const;

let db: Db;
let canvas: CanvasService;

beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
  canvas = new CanvasService({
    documents: new CanvasDocumentStore(db),
    channels: { publish: () => {}, viewers: () => 0 },
  });
});

function applyAsAgent(command: UiCommand) {
  return canvas.apply({
    scope: SCOPE,
    authorId: SESSION_AGENT_AUTHOR,
    command,
    defaultTarget: 'active-in-view',
  });
}

const storedOpenedBy = (id: string) =>
  db.select().from(canvasDocuments).where(eq(canvasDocuments.id, id)).get()?.openedByExtensionId;

describe('a document an app opened', () => {
  it('carries the app on its record, never in its content', () => {
    const doc = canvas.open(SCOPE, SESSION_OWNER_AUTHOR, PAGE, { openedByExtensionId: 'desk' });
    expect(doc.openedBy).toEqual({ extensionId: 'desk' });
    expect(doc.content).not.toHaveProperty('openedBy');
    expect(storedOpenedBy(doc.id)).toBe('desk');
    // A reload reads it from the record.
    expect(canvas.get(SCOPE, doc.id)?.openedBy).toEqual({ extensionId: 'desk' });
  });

  it('always opens a new document, even for an address already open', () => {
    const mine = canvas.open(SCOPE, SESSION_OWNER_AUTHOR, PAGE);
    const appOpened = canvas.open(SCOPE, SESSION_OWNER_AUTHOR, PAGE, {
      openedByExtensionId: 'desk',
    });
    expect(appOpened.id).not.toBe(mine.id);
    // The person's own tab keeps no label and is not navigated.
    expect(canvas.get(SCOPE, mine.id)?.openedBy).toBeUndefined();
  });
});

describe('what an agent can never do (Security tests 1 and 2)', () => {
  it('cannot label a document by putting openedBy in content it opens', () => {
    const forged = { ...PAGE, openedBy: { extensionId: 'desk' } } as unknown as typeof PAGE;
    const result = applyAsAgent({ action: 'open_canvas', content: forged });
    const id = 'document' in result && result.document ? result.document.id : undefined;
    const doc = id ? canvas.get(SCOPE, id) : canvas.list(SCOPE)[0];
    expect(doc?.openedBy).toBeUndefined();
    expect(doc && storedOpenedBy(doc.id)).toBeNull();
  });

  it('cannot keep the label by updating with openedBy in its content', () => {
    const doc = canvas.open(SCOPE, SESSION_OWNER_AUTHOR, PAGE, { openedByExtensionId: 'desk' });
    const forged = {
      type: 'markdown',
      content: 'changed',
      openedBy: { extensionId: 'desk' },
    } as unknown as UiCommand extends { content: infer C } ? C : never;
    applyAsAgent({ action: 'update_canvas', documentId: doc.id, content: forged } as UiCommand);
    expect(canvas.get(SCOPE, doc.id)?.openedBy).toBeUndefined();
    expect(storedOpenedBy(doc.id)).toBeNull();
  });

  it('drops the label when an agent updates an app-opened document', () => {
    const doc = canvas.open(SCOPE, SESSION_OWNER_AUTHOR, PAGE, { openedByExtensionId: 'desk' });
    canvas.update(SCOPE, SESSION_AGENT_AUTHOR, doc.id, { type: 'markdown', content: 'agent text' });
    expect(canvas.get(SCOPE, doc.id)?.openedBy).toBeUndefined();
    expect(storedOpenedBy(doc.id)).toBeNull();
  });
});

describe('room canvases (Security test 3)', () => {
  it('carry no label: every room open goes through the paths that cannot set one', () => {
    const room = roomScope('room-1');
    db.$client
      .prepare(
        'INSERT INTO rooms (id, kind, slug, title, topic, archived, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        'room-1',
        'channel',
        'room-1',
        '#room-1',
        null,
        0,
        '2026-11-10T10:00:00Z',
        '2026-11-10T10:00:00Z'
      );
    const doc = canvas.open(room, SESSION_OWNER_AUTHOR, {
      ...PAGE,
      openedBy: { extensionId: 'desk' },
    } as unknown as typeof PAGE);
    expect(doc.openedBy).toBeUndefined();
    expect(storedOpenedBy(doc.id)).toBeNull();
  });
});
