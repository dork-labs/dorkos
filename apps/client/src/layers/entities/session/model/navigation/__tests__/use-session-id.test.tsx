// @vitest-environment jsdom
/**
 * What `setSessionId` carries forward, and what it must not.
 *
 * The setter spreads the current search params so a session switch keeps the
 * things that describe WHERE you are — `dir` above all. The params that describe
 * an INSTRUCTION are the opposite case: they were aimed at one session, and this
 * function's whole job is changing which session that is.
 *
 * `continuedFrom` already worked that way. `prompt` and `send` did not, and the
 * consequence was not cosmetic: `/clear` calls this with a fresh uuid, so a
 * launch link that had not been consumed rode `...prev` into a session that was
 * empty by construction — where it typed itself into the composer and sent
 * itself. Two seeds, two sends, from one link the person used once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}));

const search: Record<string, unknown> = {};
vi.mock('../use-session-search', () => ({
  useSessionSearch: () => search,
}));

// Partial: the app store this hook pulls in reads other things from the same
// barrel, and replacing it wholesale takes the store down with it.
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  getPlatform: () => ({ isEmbedded: false }),
}));

import { useSessionId } from '../use-session-id';

/** The search params the setter would write, given what the URL currently holds. */
function searchAfterSet(
  prev: Record<string, unknown>,
  act: (set: (id: string | null, options?: { continuedFrom?: string }) => void) => void
): Record<string, unknown> {
  const { result } = renderHook(() => useSessionId());
  act(result.current[1]);
  const arg = navigate.mock.calls.at(-1)![0] as {
    search: (prev: Record<string, unknown>) => Record<string, unknown>;
  };
  return arg.search(prev);
}

describe('setSessionId', () => {
  beforeEach(() => {
    navigate.mockClear();
  });

  it('drops a launch prompt and its send opt-in when the session changes', () => {
    const next = searchAfterSet(
      { session: 'old', dir: '/proj', prompt: 'do the thing', send: '1' },
      (set) => set('fresh-uuid')
    );

    expect(next.session).toBe('fresh-uuid');
    expect(next.prompt).toBeUndefined();
    expect(next.send).toBeUndefined();
  });

  it('drops them on the /clear path specifically, which is where it bit', () => {
    // `/clear` mints a fresh id and records the link back. That new session is
    // empty, so anything the launch params survived into would apply there.
    const next = searchAfterSet(
      { session: 'old', dir: '/proj', prompt: 'do the thing', send: '1' },
      (set) => set('fresh-uuid', { continuedFrom: 'old' })
    );

    expect(next.continuedFrom).toBe('old');
    expect(next.prompt).toBeUndefined();
    expect(next.send).toBeUndefined();
  });

  it('still carries the params that describe where you are', () => {
    // The drop must stay surgical: `dir` is what makes a session switch land in
    // the same project, and losing it would be its own bug.
    const next = searchAfterSet({ dir: '/proj', runtime: 'codex' }, (set) => set('fresh-uuid'));

    expect(next.dir).toBe('/proj');
    expect(next.runtime).toBe('codex');
  });
});
