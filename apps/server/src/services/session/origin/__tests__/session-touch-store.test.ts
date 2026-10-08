/**
 * `session_touches` through its store (spec `your-activity-first` D1): opened
 * and wrote are kept apart, neither ever moves backwards, writing counts as
 * opening, and a rekey carries the row to the canonical id.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { SessionTouchStore, laterIso } from '../session-touch-store.js';

const NINE = '2026-10-08T09:00:00.000Z';
const TEN = '2026-10-08T10:00:00.000Z';
const ELEVEN = '2026-10-08T11:00:00.000Z';

describe('SessionTouchStore', () => {
  let store: SessionTouchStore;

  beforeEach(() => {
    store = new SessionTouchStore(createTestDb());
  });

  it('records an open with no write', () => {
    store.recordOpened('chat-1', NINE);
    expect(store.resolve(['chat-1']).get('chat-1')).toEqual({ openedAt: NINE, wroteAt: null });
  });

  it('counts a write as an open too', () => {
    store.recordWrote('chat-1', TEN);
    expect(store.resolve(['chat-1']).get('chat-1')).toEqual({ openedAt: TEN, wroteAt: TEN });
  });

  it('keeps the later time when an older one arrives late', () => {
    store.recordOpened('chat-1', ELEVEN);
    store.recordOpened('chat-1', NINE);
    store.recordWrote('chat-1', TEN);
    store.recordWrote('chat-1', NINE);
    expect(store.resolve(['chat-1']).get('chat-1')).toEqual({ openedAt: ELEVEN, wroteAt: TEN });
  });

  it('moves a later open forward over an earlier write', () => {
    store.recordWrote('chat-1', NINE);
    store.recordOpened('chat-1', ELEVEN);
    expect(store.resolve(['chat-1']).get('chat-1')).toEqual({ openedAt: ELEVEN, wroteAt: NINE });
  });

  it('resolves many chats in one call and leaves untouched ones out', () => {
    store.recordOpened('chat-1', NINE);
    store.recordWrote('chat-2', TEN);
    const found = store.resolve(['chat-1', 'chat-2', 'chat-3', 'chat-1']);
    expect([...found.keys()].sort()).toEqual(['chat-1', 'chat-2']);
  });

  it('resolves more ids than one batch holds', () => {
    const ids = Array.from({ length: 1_200 }, (_, i) => `chat-${i}`);
    store.recordOpened('chat-1199', NINE);
    expect(store.resolve(ids).get('chat-1199')?.openedAt).toBe(NINE);
  });

  it('moves a row to the canonical id, merging with one already there', () => {
    store.recordOpened('asked-id', ELEVEN);
    store.recordWrote('canonical-id', NINE);
    store.move('asked-id', 'canonical-id');
    const found = store.resolve(['asked-id', 'canonical-id']);
    expect(found.has('asked-id')).toBe(false);
    expect(found.get('canonical-id')).toEqual({ openedAt: ELEVEN, wroteAt: NINE });
  });

  it('moves nothing when nothing is stored under the old id', () => {
    store.recordOpened('canonical-id', NINE);
    store.move('asked-id', 'canonical-id');
    expect(store.resolve(['canonical-id']).get('canonical-id')).toEqual({
      openedAt: NINE,
      wroteAt: null,
    });
  });
});

describe('laterIso', () => {
  it('compares instants, not strings', () => {
    // 10:30+02:00 is 08:30Z, earlier than 09:00Z, though it sorts later as text.
    expect(laterIso('2026-10-08T10:30:00+02:00', NINE)).toBe(NINE);
  });

  it('lets a missing side lose', () => {
    expect(laterIso(null, NINE)).toBe(NINE);
    expect(laterIso(NINE, undefined)).toBe(NINE);
    expect(laterIso(null, null)).toBeNull();
  });
});
