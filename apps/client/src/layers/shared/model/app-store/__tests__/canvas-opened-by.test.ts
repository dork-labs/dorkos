/**
 * The window reads "opened by" only from the server's record of a document,
 * never from its content (DOR-3293, Security 2026-11-10).
 */
import { describe, expect, it } from 'vitest';
import type { CanvasDocument as ServerCanvasDocument } from '@dorkos/shared/room-schemas';
import { fromServer } from '../canvas-document-model';

function row(overrides: Partial<ServerCanvasDocument> = {}): ServerCanvasDocument {
  return {
    id: 'doc-1',
    scope: 'session:s',
    roomId: null,
    content: { type: 'browser', url: 'http://localhost:5173/', title: 'Preview' },
    title: 'Preview',
    contentType: 'browser',
    authorId: 'owner',
    pinned: false,
    rev: 1,
    lastTouchedBy: 'owner',
    lastTouchedAt: '2026-11-10T00:00:00.000Z',
    openedAt: '2026-11-10T00:00:00.000Z',
    lastActiveAt: '2026-11-10T00:00:00.000Z',
    ...overrides,
  } as ServerCanvasDocument;
}

describe('the opened-by label on a reload', () => {
  it('comes from the record the host wrote', () => {
    expect(fromServer(row({ openedBy: { extensionId: 'desk' } })).openedBy).toEqual({
      extensionId: 'desk',
    });
  });

  it('never comes from the content, whoever put it there', () => {
    const forged = row({
      content: {
        type: 'browser',
        url: 'http://localhost:5173/',
        openedBy: { extensionId: 'desk' },
      } as unknown as ServerCanvasDocument['content'],
    });
    expect(fromServer(forged).openedBy).toBeUndefined();
  });

  it('goes when the record no longer has it, even if this window did', () => {
    const before = fromServer(row({ openedBy: { extensionId: 'desk' } }));
    expect(fromServer(row({ rev: 2 }), before).openedBy).toBeUndefined();
  });
});
