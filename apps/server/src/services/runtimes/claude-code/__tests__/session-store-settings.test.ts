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
  };
}

/** Minimal TranscriptReader stub — only `hasTranscript` is used by ensureForMessage. */
function fakeTranscript(hasTranscript: boolean): TranscriptReader {
  return { hasTranscript: vi.fn().mockResolvedValue(hasTranscript) } as unknown as TranscriptReader;
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

  it('functions without a settings port (port is optional)', async () => {
    // No configureSettings() call — settingsPort is undefined.
    const session = await store.ensureForMessage('s1', fakeTranscript(false), '/cwd');
    expect(session.permissionMode).toBe('default'); // hardcoded fallback default
    await expect(store.updateSession('s1', { permissionMode: 'plan' })).resolves.toBe(true);
  });
});
