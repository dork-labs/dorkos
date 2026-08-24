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
import type { PermissionMode, SessionSettings } from '@dorkos/shared/types';
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
function storeWithLiveTurn(query: Query, startingMode: PermissionMode = 'default'): SessionStore {
  const store = new SessionStore();
  store.ensureSession(SESSION_ID, { permissionMode: startingMode });
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

    await expect(patched).resolves.toMatchObject({ updated: true });
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

    await expect(patched).resolves.toMatchObject({ updated: true });
    expect(saved).toEqual([{ permissionMode: 'bypassPermissions' }]);
  });

  it('does not wait on the clock when the CLI answers', async () => {
    const { query, calls } = fakeQuery('acks');
    const store = storeWithLiveTurn(query);

    // No timer is advanced: an acked change must settle on its own.
    await expect(store.updateSession(SESSION_ID, { permissionMode: 'plan' })).resolves.toEqual({
      updated: true,
    });

    expect(calls).toEqual(['plan']);
    expect(store.findSession(SESSION_ID)!.permissionMode).toBe('plan');
    // No clock is left running behind an ack that already arrived.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the mode when the CLI refuses the change outright', async () => {
    const { query, calls } = fakeQuery('rejects');
    const store = storeWithLiveTurn(query);

    await expect(
      store.updateSession(SESSION_ID, { permissionMode: 'plan' })
    ).resolves.toMatchObject({ updated: true });

    expect(calls).toEqual(['plan']);
    expect(store.findSession(SESSION_ID)!.permissionMode).toBe('plan');
  });
});

/**
 * The honesty half (DOR-1435).
 *
 * Keeping the mode is right; reporting it as in force is not. When the running
 * turn never confirmed a TIGHTENING, it is still running under the looser mode
 * and nothing on this side can put the approval prompts back for it — so the
 * result says so, and `PATCH /api/sessions/:id` answers `202` off the back of
 * it. A loosening in the same position stays silent.
 */
describe('an unconfirmed permission change reports which direction it went (DOR-1435)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive one mode change against a CLI that never answers. */
  async function patchAgainstSilentCli(from: PermissionMode, to: PermissionMode) {
    const { query } = fakeQuery('never-settles');
    const store = storeWithLiveTurn(query, from);
    const patched = store.updateSession(SESSION_ID, { permissionMode: to });
    await vi.advanceTimersByTimeAsync(PERMISSION_MODE_ACK_TIMEOUT_MS);
    return patched;
  }

  it('says a stricter mode has not reached the reply already running', async () => {
    // The case the ticket was filed on: the turn keeps bypassing every approval
    // while the person believes they just took that away.
    await expect(patchAgainstSilentCli('bypassPermissions', 'default')).resolves.toEqual({
      updated: true,
      permissionModePendingUntilNextTurn: true,
    });
  });

  it('says so for a narrowing of reach too, not only for more asking', async () => {
    // `default` → `plan` keeps asking always and takes the editing away, so the
    // unconfirmed turn goes on editing files a person just confined to reading.
    await expect(patchAgainstSilentCli('default', 'plan')).resolves.toEqual({
      updated: true,
      permissionModePendingUntilNextTurn: true,
    });
  });

  it('stays quiet about a LOOSER mode that went unconfirmed', async () => {
    // The self-correcting direction: the turn keeps asking for approvals it no
    // longer needs to, which costs prompts and nothing else.
    await expect(patchAgainstSilentCli('default', 'bypassPermissions')).resolves.toEqual({
      updated: true,
    });
  });

  it('stays quiet when the person re-picks the mode the session is already on', async () => {
    // Nothing was taken away, so there is nothing to be out of step with — even
    // though the CLI went silent and a turn is running. Pinned at the seam that
    // produces the 202, not only on the pure comparison: a `>` that slipped to
    // `>=` would toast "starts on your next message" at somebody who changed
    // nothing.
    await expect(patchAgainstSilentCli('bypassPermissions', 'bypassPermissions')).resolves.toEqual({
      updated: true,
    });
  });

  it('says so when the mode the turn started under is one this runtime no longer declares', async () => {
    // Fail-closed, at the seam. A session persisted in a since-retired mode
    // still loads and runs, and nothing can weigh what it permits — so the
    // honest answer is "this may not have taken", not silence.
    await expect(
      patchAgainstSilentCli('a-mode-nobody-declares' as PermissionMode, 'default')
    ).resolves.toEqual({ updated: true, permissionModePendingUntilNextTurn: true });
  });

  it('stays quiet when the CLI confirms the tightening', async () => {
    const { query } = fakeQuery('acks');
    const store = storeWithLiveTurn(query, 'bypassPermissions');

    await expect(store.updateSession(SESSION_ID, { permissionMode: 'default' })).resolves.toEqual({
      updated: true,
    });
  });

  it('stays quiet when no turn is running — there is nothing to be out of step with', async () => {
    const store = new SessionStore();
    store.ensureSession(SESSION_ID, { permissionMode: 'bypassPermissions' });

    await expect(store.updateSession(SESSION_ID, { permissionMode: 'default' })).resolves.toEqual({
      updated: true,
    });
  });
});
