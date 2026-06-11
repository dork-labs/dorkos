// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useSessionListStore } from '@/layers/entities/session';
import { useSessionRekeyRedirect } from '../model/use-session-stream';

const STATUS = {
  contextUsage: null,
  cost: null,
  cacheStats: null,
  model: null,
  permissionMode: 'default',
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'streaming',
} as const;

/** Apply a retire announce (canonical id supersedes a request UUID) to the list store. */
function announceRekey(retired: string, canonical: string): void {
  useSessionListStore.getState().applyListEvent({
    type: 'session_status',
    sessionId: canonical,
    retiredSessionId: retired,
    status: STATUS,
  });
}

describe('useSessionRekeyRedirect', () => {
  beforeEach(() => {
    useSessionListStore.setState({
      sessions: {},
      statuses: {},
      statusCwds: {},
      unseen: {},
      rekeys: {},
    });
  });

  it('replaces a retired active id with its canonical id when the announce arrives live', () => {
    // The common Claude path: the 202 returned the request UUID; the canonical
    // id resolves mid-turn and the retire announce is the only rekey signal.
    const replace = vi.fn();
    renderHook(() => useSessionRekeyRedirect('request-uuid', replace));
    expect(replace).not.toHaveBeenCalled();

    act(() => announceRekey('request-uuid', 'canonical-id'));

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('canonical-id');
  });

  it('fires immediately when the active id was already retired at mount', () => {
    // Switch-to-retired-row case: the operator lands on a retired URL after the
    // announce already arrived (e.g. via browser Back).
    announceRekey('request-uuid', 'canonical-id');
    const replace = vi.fn();
    renderHook(() => useSessionRekeyRedirect('request-uuid', replace));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('canonical-id');
  });

  it('does nothing for a current id, a null session, or an unrelated retirement', () => {
    announceRekey('other-retired', 'other-canonical');
    const replace = vi.fn();
    const { rerender } = renderHook(({ id }) => useSessionRekeyRedirect(id, replace), {
      initialProps: { id: null as string | null },
    });
    rerender({ id: 'canonical-id' });
    expect(replace).not.toHaveBeenCalled();
  });

  it('settles after the redirect — the canonical id resolves no further target', () => {
    const replace = vi.fn();
    const { rerender } = renderHook(({ id }) => useSessionRekeyRedirect(id, replace), {
      initialProps: { id: 'request-uuid' },
    });
    act(() => announceRekey('request-uuid', 'canonical-id'));
    // The URL rewrite lands and the hook re-renders under the canonical id.
    rerender({ id: 'canonical-id' });
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
