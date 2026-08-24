import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStore } from '../sessions/session-store.js';
import type { TranscriptReader } from '../sessions/transcript-reader.js';
import type { SessionSettings, SessionSettingsPort } from '@dorkos/shared/agent-runtime';

/**
 * Tests for the durable session-settings hydrate/write-through (ADR-0260) wired
 * into SessionStore via `configureSettings`. These cover the reported bug: a
 * session whose in-memory state was evicted/restarted must hydrate the
 * operator's persisted mode on the next message instead of reverting to default.
 */

/** In-memory fake of the core SessionSettingsPort, with spies and an exposed store. */
function createFakePort() {
  const store = new Map<string, SessionSettings>();
  return {
    store,
    getSessionSettings: vi.fn(async (id: string) => store.get(id) ?? null),
    saveSessionSettings: vi.fn(async (id: string, s: SessionSettings) => {
      store.set(id, { ...store.get(id), ...s });
    }),
    // Models the real store: the row MOVES, it is never copied.
    rekeySessionSettings: vi.fn(async (fromId: string, toId: string) => {
      const row = store.get(fromId);
      if (!row) return;
      store.set(toId, { ...store.get(toId), ...row });
      store.delete(fromId);
    }),
  };
}

/**
 * Minimal TranscriptReader stub — only `hasTranscript` is used by
 * ensureForMessage. It answers with the account the transcript was found under
 * as well as the verdict, which is how the store learns a session's account.
 */
function fakeTranscript(exists: boolean, root = '/staged/.claude'): TranscriptReader {
  return {
    hasTranscript: vi.fn().mockResolvedValue(exists ? { exists, root } : { exists }),
  } as unknown as TranscriptReader;
}

describe('SessionStore session-settings hydration (ADR-0260)', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  it('hydrates bypassPermissions from the store on a cold session (regression for the reported bug)', async () => {
    const port = createFakePort();
    port.store.set('s1', { permissionMode: 'bypassPermissions' });
    store.configureSettings(port, 'default');

    // Cold path: no in-memory session (evicted/restarted), transcript exists.
    const session = await store.ensureForMessage('s1', fakeTranscript(true), '/cwd');

    expect(port.getSessionSettings).toHaveBeenCalledWith('s1');
    expect(session.permissionMode).toBe('bypassPermissions');
  });

  it('hydrates all settings, not just permissionMode', async () => {
    const port = createFakePort();
    port.store.set('s1', {
      permissionMode: 'plan',
      model: 'claude-haiku-4-5-20251001',
      effort: 'high',
      fastMode: true,
    });
    store.configureSettings(port, 'default');

    const session = await store.ensureForMessage('s1', fakeTranscript(true), '/cwd');

    expect(session).toMatchObject({
      permissionMode: 'plan',
      model: 'claude-haiku-4-5-20251001',
      effort: 'high',
      fastMode: true,
    });
  });

  it('applies precedence: per-send opts override persisted settings', async () => {
    const port = createFakePort();
    port.store.set('s1', { permissionMode: 'bypassPermissions' });
    store.configureSettings(port, 'default');

    const session = await store.ensureForMessage('s1', fakeTranscript(false), '/cwd', {
      permissionMode: 'plan',
    });

    expect(session.permissionMode).toBe('plan');
  });

  it('falls back to the runtime default when nothing is persisted', async () => {
    const port = createFakePort();
    store.configureSettings(port, 'acceptEdits'); // runtime-declared default

    const session = await store.ensureForMessage('new-session', fakeTranscript(false), '/cwd');

    expect(session.permissionMode).toBe('acceptEdits');
  });

  it('does NOT persist a per-send override taken on the message path', async () => {
    const port = createFakePort();
    store.configureSettings(port, 'default');

    await store.ensureForMessage('s1', fakeTranscript(false), '/cwd', {
      permissionMode: 'bypassPermissions',
    });

    // Hydration reads but never writes — transient overrides stay transient.
    expect(port.saveSessionSettings).not.toHaveBeenCalled();
  });

  it('write-through: updateSession persists only the changed settings', async () => {
    const port = createFakePort();
    store.configureSettings(port, 'default');
    store.ensureSession('s1', { permissionMode: 'default' });

    await store.updateSession('s1', { permissionMode: 'bypassPermissions', model: 'sonnet' });

    expect(port.saveSessionSettings).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ permissionMode: 'bypassPermissions', model: 'sonnet' })
    );
    expect(port.store.get('s1')).toMatchObject({
      permissionMode: 'bypassPermissions',
      model: 'sonnet',
    });
  });

  it('rebindSdkSession moves the stored row AND the reverse index to the canonical id', async () => {
    const port = createFakePort();
    store.configureSettings(port, 'default');
    store.ensureSession('request-id', { permissionMode: 'default' });
    await store.updateSession('request-id', { permissionMode: 'bypassPermissions' });

    await store.rebindSdkSession('request-id', 'canonical', 'request-id');

    expect(port.store.get('canonical')).toEqual({ permissionMode: 'bypassPermissions' });
    expect(port.store.has('request-id')).toBe(false);
    // The canonical id now resolves to the same live session via the index.
    expect(store.hasSession('canonical')).toBe(true);
  });

  it('rebindSdkSession is a no-op when the SDK keeps the id it was given', async () => {
    const port = createFakePort();
    store.configureSettings(port, 'default');
    store.ensureSession('s1', { permissionMode: 'plan' });

    await store.rebindSdkSession('s1', 's1', 's1');

    expect(port.rekeySessionSettings).not.toHaveBeenCalled();
    expect(store.hasSession('s1')).toBe(true);
  });

  it('functions without a settings port (port is optional)', async () => {
    // No configureSettings() call — settingsPort is undefined.
    const session = await store.ensureForMessage('s1', fakeTranscript(false), '/cwd');
    expect(session.permissionMode).toBe('default'); // hardcoded fallback default
    await expect(store.updateSession('s1', { permissionMode: 'plan' })).resolves.toEqual({
      updated: true,
    });
  });

  it('updateSession hydrates persisted settings on a cold auto-create (regression, DOR-1151)', async () => {
    // A PATCH that changes only model/effort/fastMode (or a title rename) can
    // reach updateSession for a session that was evicted or the server
    // restarted since. Pre-fix, the auto-create branch never consulted the
    // durable row, so it silently reset a bypassPermissions session back to
    // 'default' — the DB row (and the cockpit's display overlay reading it)
    // kept showing bypassPermissions while every subsequent turn actually ran
    // 'default'.
    const port = createFakePort();
    port.store.set('s1', { permissionMode: 'bypassPermissions' });
    store.configureSettings(port, 'default');

    // s1 is NOT in memory — no ensureSession/ensureForMessage call precedes
    // this. updateSession must hit its own auto-create branch.
    const result = await store.updateSession('s1', { model: 'claude-sonnet-4' });

    expect(result).toEqual({ updated: true });
    expect(port.getSessionSettings).toHaveBeenCalledWith('s1');
    expect(store.findSession('s1')!.permissionMode).toBe('bypassPermissions');
    expect(store.findSession('s1')!.model).toBe('claude-sonnet-4');
  });

  it('updateSession hydrates persisted model/effort/fastMode on a cold auto-create too', async () => {
    const port = createFakePort();
    port.store.set('s1', {
      permissionMode: 'plan',
      model: 'claude-haiku-4-5-20251001',
      effort: 'high',
      fastMode: true,
    });
    store.configureSettings(port, 'default');

    await store.updateSession('s1', { fastMode: false });

    const session = store.findSession('s1')!;
    expect(session.permissionMode).toBe('plan');
    expect(session.model).toBe('claude-haiku-4-5-20251001');
    expect(session.effort).toBe('high');
    // The explicit opt for this call still wins over the persisted value.
    expect(session.fastMode).toBe(false);
  });

  it('updateSession: explicit opts.permissionMode still wins over persisted on a cold auto-create', async () => {
    const port = createFakePort();
    port.store.set('s1', { permissionMode: 'bypassPermissions' });
    store.configureSettings(port, 'default');

    await store.updateSession('s1', { permissionMode: 'plan' });

    expect(store.findSession('s1')!.permissionMode).toBe('plan');
  });
});
