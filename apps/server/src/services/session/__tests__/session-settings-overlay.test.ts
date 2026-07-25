/**
 * Unit tests for the shared persisted-settings overlay (ADR-0260, DOR-463) —
 * the ONE resolver every session read path uses, so the list endpoint, the
 * detail endpoint, and the `/events` ctx cannot key the store differently.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Session, SessionSettings } from '@dorkos/shared/types';
import {
  overlayStoredSettings,
  applyStoredSettings,
  resolveSettingsKey,
  type SessionSettingsOverlayPort,
} from '../session-settings-overlay.js';

function makeSession(id: string, runtime?: string): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    permissionMode: 'default',
    ...(runtime !== undefined ? { runtime } : {}),
  };
}

/**
 * Build an overlay port over a fixed settings table and a fixed id-alias map.
 *
 * @param rows - Persisted settings keyed by the id they are stored under
 * @param alias - Client-facing id → the runtime's canonical id
 * @param registered - Runtime types this server has registered
 */
function makePort(
  rows: Record<string, SessionSettings>,
  alias: Record<string, string> = {},
  registered: string[] = ['fake']
): SessionSettingsOverlayPort & { readKeys: string[][] } {
  const readKeys: string[][] = [];
  return {
    readKeys,
    getSessionSettingsMany: vi.fn((ids: string[]) => {
      readKeys.push(ids);
      const map = new Map<string, SessionSettings>();
      for (const id of ids) {
        const row = rows[id];
        if (row) map.set(id, row);
      }
      return map;
    }),
    has: (type: string) => registered.includes(type),
    get: () => ({ getInternalSessionId: (id: string) => alias[id] }),
  };
}

describe('resolveSettingsKey', () => {
  it('returns the runtime canonical id when the runtime holds an alias', () => {
    const runtime = { getInternalSessionId: () => 'canonical' };
    expect(resolveSettingsKey('request-id', runtime)).toBe('canonical');
  });

  it('returns the id unchanged when the runtime has no alias for it', () => {
    const runtime = { getInternalSessionId: () => undefined };
    expect(resolveSettingsKey('request-id', runtime)).toBe('request-id');
  });

  it('returns the id unchanged when the runtime cannot be resolved', () => {
    // An unregistered runtime tag must not throw the whole list — the id is
    // then its own key.
    expect(resolveSettingsKey('request-id', undefined)).toBe('request-id');
  });
});

describe('applyStoredSettings', () => {
  it('lets the store win over runtime-derived values, field by field', () => {
    const session = makeSession('s1');
    session.model = 'transcript-model';

    applyStoredSettings(session, { permissionMode: 'plan', effort: 'high' });

    expect(session.permissionMode).toBe('plan');
    expect(session.effort).toBe('high');
    // A field the store has no value for keeps the runtime-derived one.
    expect(session.model).toBe('transcript-model');
  });
});

describe('overlayStoredSettings', () => {
  it('keys each session by its runtime canonical id, not the id it is listed under', () => {
    // The regression: the row lives under the canonical id (where PATCH wrote
    // it) while the session is listed under the id DorkOS minted. The canonical
    // key leads; the session's own id trails it as a fallback.
    const sessions = [makeSession('request-id', 'fake')];
    const port = makePort({ canonical: { permissionMode: 'plan' } }, { 'request-id': 'canonical' });

    overlayStoredSettings(sessions, port);

    expect(port.readKeys).toEqual([['canonical', 'request-id']]);
    expect(sessions[0]!.permissionMode).toBe('plan');
  });

  it('prefers the canonical row over one stored under the session id', () => {
    const sessions = [makeSession('request-id', 'fake')];
    const port = makePort(
      { canonical: { permissionMode: 'plan' }, 'request-id': { permissionMode: 'acceptEdits' } },
      { 'request-id': 'canonical' }
    );

    overlayStoredSettings(sessions, port);

    expect(sessions[0]!.permissionMode).toBe('plan');
  });

  it('falls back to the REQUESTED id for a single-session read of a retired id', () => {
    // `GET /api/sessions/:id` is the one route that still accepts a retired id;
    // the session it returns is the successor, so the successor's id is not
    // where a pre-alias row lives.
    const sessions = [makeSession('canonical', 'fake')];
    const port = makePort({ retired: { permissionMode: 'plan' } }, {});

    overlayStoredSettings(sessions, port, 'retired');

    expect(port.readKeys).toEqual([['canonical', 'retired']]);
    expect(sessions[0]!.permissionMode).toBe('plan');
  });

  it('ignores a requested-id fallback for a multi-session listing', () => {
    // No per-row request id exists for a listing; applying one id to every row
    // would cross-contaminate them.
    const sessions = [makeSession('a', 'fake'), makeSession('b', 'fake')];
    const port = makePort({ retired: { permissionMode: 'plan' } }, {});

    overlayStoredSettings(sessions, port, 'retired');

    expect(port.readKeys[0]).toEqual(['a', 'b']);
    expect(sessions.map((s) => s.permissionMode)).toEqual(['default', 'default']);
  });

  it('reads every key in ONE batch query — no N+1', () => {
    const sessions = [makeSession('a', 'fake'), makeSession('b', 'fake'), makeSession('c', 'fake')];
    const port = makePort({ b: { permissionMode: 'plan' } });

    overlayStoredSettings(sessions, port);

    expect(port.getSessionSettingsMany).toHaveBeenCalledTimes(1);
    expect(port.readKeys[0]).toEqual(['a', 'b', 'c']);
    expect(sessions.map((s) => s.permissionMode)).toEqual(['default', 'plan', 'default']);
  });

  it('dedupes keys when two listed sessions resolve to the same canonical id', () => {
    // A resume-as-new leaves the old transcript listed alongside the new one;
    // both resolve to the runtime's current canonical id.
    const sessions = [makeSession('old', 'fake'), makeSession('new', 'fake')];
    const port = makePort({ new: { permissionMode: 'bypassPermissions' } }, { old: 'new' });

    overlayStoredSettings(sessions, port);

    // 'new' is queried once even though both rows resolve to it.
    expect(port.readKeys[0]).toEqual(['new', 'old']);
    expect(sessions[0]!.permissionMode).toBe('bypassPermissions');
    expect(sessions[1]!.permissionMode).toBe('bypassPermissions');
  });

  it('falls back to the raw id for a session tagged with an unregistered runtime', () => {
    const sessions = [makeSession('s1', 'gone')];
    const port = makePort({ s1: { permissionMode: 'acceptEdits' } }, {}, ['fake']);

    overlayStoredSettings(sessions, port);

    expect(port.readKeys[0]).toEqual(['s1']);
    expect(sessions[0]!.permissionMode).toBe('acceptEdits');
  });

  it('leaves runtime-derived values alone when nothing is persisted', () => {
    const sessions = [makeSession('s1', 'fake')];
    sessions[0]!.permissionMode = 'plan';

    overlayStoredSettings(sessions, makePort({}));

    expect(sessions[0]!.permissionMode).toBe('plan');
  });

  it('skips the query entirely for an empty list', () => {
    const port = makePort({});

    overlayStoredSettings([], port);

    expect(port.getSessionSettingsMany).not.toHaveBeenCalled();
  });
});
