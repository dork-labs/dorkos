import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readCanvasSession, writeCanvasSession } from '../app-store/app-store-helpers';
import { STORAGE_KEYS, MAX_CANVAS_SESSIONS } from '@/layers/shared/lib';
import type { CanvasSessionEntry } from '../app-store/app-store-helpers';

/** A multi-document canvas entry for a session. */
function entry(overrides: Partial<CanvasSessionEntry> = {}): CanvasSessionEntry {
  return { open: true, documents: [], activeDocumentId: null, accessedAt: 1000, ...overrides };
}

describe('readCanvasSession', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null when no data exists in localStorage', () => {
    expect(readCanvasSession('session-1')).toBeNull();
  });

  it('returns null when session ID is not in the map', () => {
    localStorage.setItem(STORAGE_KEYS.CANVAS_SESSIONS, JSON.stringify({ other: entry() }));
    expect(readCanvasSession('session-1')).toBeNull();
  });

  it('returns the document array when the session exists', () => {
    const doc = {
      id: 'doc-1',
      content: { type: 'markdown' as const, content: '# Hello', title: 'Test' },
      openedAt: 1,
      lastActiveAt: 2,
      sourceLabel: 'Test',
    };
    const stored = entry({ documents: [doc], activeDocumentId: 'doc-1' });
    localStorage.setItem(STORAGE_KEYS.CANVAS_SESSIONS, JSON.stringify({ 'session-1': stored }));

    const result = readCanvasSession('session-1');
    expect(result?.documents).toHaveLength(1);
    expect(result?.activeDocumentId).toBe('doc-1');
    expect(result?.documents[0].content.type).toBe('markdown');
  });

  it('migrates the legacy single-content shape into a one-document array', () => {
    // Pre-DOR-219 entries stored `{ open, content }` with no `documents`.
    const legacy = { open: true, content: { type: 'json', data: { a: 1 } }, accessedAt: 500 };
    localStorage.setItem(STORAGE_KEYS.CANVAS_SESSIONS, JSON.stringify({ 'session-1': legacy }));

    const result = readCanvasSession('session-1');
    expect(result?.open).toBe(true);
    expect(result?.documents).toHaveLength(1);
    expect(result?.documents[0].content.type).toBe('json');
    expect(result?.activeDocumentId).toBe(result?.documents[0].id);
  });

  it('returns null when localStorage contains corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEYS.CANVAS_SESSIONS, 'not-valid-json{{{');
    expect(readCanvasSession('session-1')).toBeNull();
  });

  it('returns null when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readCanvasSession('session-1')).toBeNull();
    vi.restoreAllMocks();
  });
});

describe('writeCanvasSession', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('writes a new entry to localStorage', () => {
    writeCanvasSession('session-1', entry({ accessedAt: 0 }));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.CANVAS_SESSIONS)!);
    expect(stored['session-1']).toBeDefined();
    expect(stored['session-1'].open).toBe(true);
    expect(stored['session-1'].accessedAt).toBeGreaterThan(0);
  });

  it('updates an existing entry', () => {
    writeCanvasSession('session-1', entry({ open: true, accessedAt: 0 }));
    writeCanvasSession('session-1', entry({ open: false, accessedAt: 0 }));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.CANVAS_SESSIONS)!);
    expect(stored['session-1'].open).toBe(false);
  });

  it('preserves other sessions when writing', () => {
    writeCanvasSession('session-1', entry({ accessedAt: 0 }));
    writeCanvasSession('session-2', entry({ open: false, accessedAt: 0 }));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.CANVAS_SESSIONS)!);
    expect(stored['session-1']).toBeDefined();
    expect(stored['session-2']).toBeDefined();
  });

  it('evicts oldest entries when exceeding MAX_CANVAS_SESSIONS', () => {
    const map: Record<string, CanvasSessionEntry> = {};
    for (let i = 0; i < MAX_CANVAS_SESSIONS; i++) {
      map[`session-${i}`] = entry({ open: false, accessedAt: i });
    }
    localStorage.setItem(STORAGE_KEYS.CANVAS_SESSIONS, JSON.stringify(map));

    writeCanvasSession('session-new', entry({ accessedAt: 0 }));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.CANVAS_SESSIONS)!);
    expect(Object.keys(stored).length).toBe(MAX_CANVAS_SESSIONS);
    expect(stored['session-0']).toBeUndefined();
    expect(stored['session-new']).toBeDefined();
  });

  it('does not throw when localStorage is full', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(() => writeCanvasSession('session-1', entry({ accessedAt: 0 }))).not.toThrow();
    vi.restoreAllMocks();
  });
});
