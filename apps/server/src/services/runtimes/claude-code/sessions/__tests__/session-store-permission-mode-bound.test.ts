/**
 * Changing permission mode is bounded (DOR-1301).
 *
 * `PATCH /api/sessions/:id` awaits `SessionStore.updateSession`, which asks the
 * live query to move mode. On a session winding down, DorkOS has already ended
 * that query's stdin, so the SDK drops the write in silence and hands back a
 * promise nothing will settle — the PATCH hung, and the best-effort catch
 * written for exactly this case (ADR-0261) was unreachable because the promise
 * never rejected either.
 *
 * These tests drive the store against a query that answers the way the SDK does
 * in the wind-down: not at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { SessionSettings } from '@dorkos/shared/types';
import { SessionStore } from '../session-store.js';
import { PERMISSION_MODE_ACK_TIMEOUT_MS } from '../bounded-control.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ forkSession: vi.fn() }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SESSION_ID = 'session-under-patch';

/** How the fake query answers `setPermissionMode`. */
type Answer = 'acks' | 'rejects' | 'never-settles';

function fakeQuery(answer: Answer) {
  const calls: string[] = [];
  const query = {
    setPermissionMode: (mode: string): Promise<unknown> => {
      calls.push(mode);
      if (answer === 'rejects') return Promise.reject(new Error('mode change refused'));
      if (answer === 'never-settles') return new Promise<never>(() => {});
      return Promise.resolve(undefined);
    },
  } as unknown as Query;
  return { query, calls };
}

/** A store holding one live session whose turn is running on `query`. */
function storeWithLiveTurn(query: Query): SessionStore {
  const store = new SessionStore();
  store.ensureSession(SESSION_ID, { permissionMode: 'default' });
  store.findSession(SESSION_ID)!.activeQuery = query;
  return store;
}

describe('changing permission mode is bounded (DOR-1301)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns from a PATCH whose CLI never answers, keeping the mode the operator chose', async () => {
    const { query, calls } = fakeQuery('never-settles');
    const store = storeWithLiveTurn(query);

    const patched = store.updateSession(SESSION_ID, { permissionMode: 'plan' });
    await vi.advanceTimersByTimeAsync(PERMISSION_MODE_ACK_TIMEOUT_MS);

    await expect(patched).resolves.toBe(true);
    expect(calls).toEqual(['plan']);
    // Best-effort (ADR-0261): the choice is kept and applies next turn. It is
    // never reverted just because the live process could not be told.
    expect(store.findSession(SESSION_ID)!.permissionMode).toBe('plan');
  });

  it('persists the new mode before asking the live process, so an unanswered ask loses nothing', async () => {
    const saved: SessionSettings[] = [];
    const { query } = fakeQuery('never-settles');
    const store = new SessionStore();
    store.configureSettings(
      {
        getSessionSettings: async () => null,
        saveSessionSettings: async (_id, settings) => {
          saved.push(settings);
        },
        rekeySessionSettings: async () => {},
      },
      'default'
    );
    store.ensureSession(SESSION_ID, { permissionMode: 'default' });
    store.findSession(SESSION_ID)!.activeQuery = query;

    const patched = store.updateSession(SESSION_ID, { permissionMode: 'bypassPermissions' });
    await vi.advanceTimersByTimeAsync(PERMISSION_MODE_ACK_TIMEOUT_MS);

    await expect(patched).resolves.toBe(true);
    expect(saved).toEqual([{ permissionMode: 'bypassPermissions' }]);
  });

  it('does not wait on the clock when the CLI answers', async () => {
    const { query, calls } = fakeQuery('acks');
    const store = storeWithLiveTurn(query);

    // No timer is advanced: an acked change must settle on its own.
    await expect(store.updateSession(SESSION_ID, { permissionMode: 'plan' })).resolves.toBe(true);

    expect(calls).toEqual(['plan']);
    expect(store.findSession(SESSION_ID)!.permissionMode).toBe('plan');
    // No clock is left running behind an ack that already arrived.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the mode when the CLI refuses the change outright', async () => {
    const { query, calls } = fakeQuery('rejects');
    const store = storeWithLiveTurn(query);

    await expect(store.updateSession(SESSION_ID, { permissionMode: 'plan' })).resolves.toBe(true);

    expect(calls).toEqual(['plan']);
    expect(store.findSession(SESSION_ID)!.permissionMode).toBe('plan');
  });
});
