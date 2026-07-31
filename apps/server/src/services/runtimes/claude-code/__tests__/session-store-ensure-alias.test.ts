/**
 * What happens when a caller starts a turn using an id the live session has
 * already been renamed away from.
 *
 * A room binding persists the SDK id it first saw and keeps asking with it, so
 * once Claude Code renames the conversation that id is an index alias rather
 * than the key the session is stored under. `ensureSession` used to look only
 * for a map key, find none, and build a SECOND session object for the same
 * conversation — the live one, mid-turn, shadowed by an empty twin the next
 * lookup returns instead. The room's replies come back from a session with no
 * memory of the exchange it just had.
 *
 * A genuine reuse is still a creation: once the session is evicted the alias
 * is gone with it, and asking again starts a fresh session as it should.
 */
import { describe, it, expect, vi } from 'vitest';
import { SessionStore } from '../sessions/session-store.js';
import type { TranscriptReader } from '../sessions/transcript-reader.js';
import type { SessionLockManager } from '../../../session/session-lock.js';

/** The id the caller minted and asked the first turn with. */
const REQUESTED = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
/** The id the SDK assigned on the first turn — what a room binding persists. */
const FIRST = 'sdk-canonical-first';
/** The id the SDK assigned when it renamed the session again on a resume. */
const SECOND = 'sdk-canonical-second';

/** A disk that holds one transcript, under `sessionId`. */
function diskHolding(sessionId: string): TranscriptReader {
  return {
    hasTranscript: vi.fn(async (_cwd: string, id: string) =>
      id === sessionId ? { exists: true, root: '/staged/.claude' } : { exists: false }
    ),
  } as unknown as TranscriptReader;
}

/** One live session that the SDK has renamed once, still stored under REQUESTED. */
async function renamedSession(store: SessionStore) {
  const session = await store.ensureForMessage(REQUESTED, diskHolding(FIRST), '/repo/ana');
  session.sdkSessionId = FIRST;
  await store.rebindSdkSession(REQUESTED, FIRST, REQUESTED);
  return session;
}

describe('ensureSession asked by an id the session was renamed away from', () => {
  it('keeps the live session instead of forking a twin', async () => {
    const store = new SessionStore();
    const live = await renamedSession(store);

    store.ensureSession(FIRST, { permissionMode: 'default', cwd: '/repo/ana' });

    expect(store.findSession(FIRST), 'the alias resolved to a different object').toBe(live);
    expect(store.findSession(REQUESTED), 'the map key stopped resolving').toBe(live);
    expect(store.getInternalSessionId(FIRST)).toBe(FIRST);
  });

  it('leaves the live session mid-turn untouched', async () => {
    // The twin arrived with the caller's own defaults and hasStarted=false,
    // which is how a resumed conversation started over from nothing.
    const store = new SessionStore();
    const live = await renamedSession(store);
    live.permissionMode = 'acceptEdits';
    live.hasStarted = true;

    store.ensureSession(FIRST, { permissionMode: 'default', hasStarted: false });

    expect(live.permissionMode).toBe('acceptEdits');
    expect(live.hasStarted).toBe(true);
  });

  it('leaves nothing behind when the conversation is evicted', async () => {
    // A twin is stored under its own key with its own idle clock, so it
    // outlives the sweep that retires the conversation it was cloned from.
    const store = new SessionStore();
    const live = await renamedSession(store);

    store.ensureSession(FIRST, { permissionMode: 'default' });

    live.lastActivity = 0;
    const evicted = store.checkSessionHealth({ cleanup: vi.fn() } as unknown as SessionLockManager);

    expect(new Set(evicted)).toEqual(new Set([REQUESTED, FIRST]));
    expect(store.findSession(FIRST), 'a twin survived the sweep').toBeUndefined();
  });

  it('still creates a session when the alias died with an evicted one', async () => {
    // Eviction sweeps the whole alias chain, so nothing is being shadowed and
    // asking by that id again is a genuine new session.
    const store = new SessionStore();
    const live = await renamedSession(store);
    live.lastActivity = 0;
    store.checkSessionHealth({ cleanup: vi.fn() } as unknown as SessionLockManager);

    store.ensureSession(FIRST, { permissionMode: 'plan' });

    const fresh = store.findSession(FIRST);
    expect(fresh, 'a reused id after eviction got no session').toBeDefined();
    expect(fresh).not.toBe(live);
    expect(fresh?.permissionMode).toBe('plan');
  });
});
