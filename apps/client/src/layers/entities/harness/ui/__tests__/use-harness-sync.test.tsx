/**
 * How the page learns that the second projection pass happened.
 *
 * `POST /api/harness/sync` answers without waiting for an approval card, so a
 * package's hooks land — or do not — some time after the response. The status
 * on screen is stale from that moment until something re-reads it, and the only
 * thing that knows a decision was made is the global stream's
 * `approval_resolved`. This is the whole of that mechanism, so it is asserted
 * rather than left to a comment: without it the page shows "needs your OK" over
 * hooks that were installed minutes ago, and nothing but a manual reload fixes
 * it.
 *
 * Beside `entities/attention/__tests__/use-pending-approvals.test.tsx`, which
 * drives the same hook the same way for the same event.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn() };
});

import { useEventSubscription } from '@/layers/shared/model';
import { harnessKeys } from '../../api/query-keys';
import { useHarnessSyncApprovalRefresh } from '../../model/use-harness-sync';

describe('useHarnessSyncApprovalRefresh', () => {
  /** Handlers the hook registered, keyed by event name. */
  let handlers: Map<string, (raw: unknown) => void>;

  beforeEach(() => {
    handlers = new Map();
    vi.mocked(useEventSubscription).mockImplementation((event, handler) => {
      handlers.set(event, handler as (raw: unknown) => void);
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  /** Mount the hook for one project, over a real query client. */
  function mount(projectPath = '/repo') {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useHarnessSyncApprovalRefresh(projectPath), { wrapper });
    return { invalidate };
  }

  it('subscribes to approval_resolved, and to nothing else', () => {
    // Purpose: the event name is the mechanism. Seeded defect: subscribe to
    // `approval_pending` instead — the card going UP is not news to this page,
    // and the refresh would fire before the answer exists rather than after.
    mount();

    expect(useEventSubscription).toHaveBeenCalledWith('approval_resolved', expect.any(Function));
    expect(useEventSubscription).toHaveBeenCalledTimes(1);
  });

  it('re-reads this project’s status when an approval is decided', () => {
    // Purpose: the whole point of the subscription. Seeded defect: delete the
    // handler's body and this reds — which is exactly what was possible before
    // this file existed, with every other case in the slice still green.
    const { invalidate } = mount('/repo');
    expect(invalidate).not.toHaveBeenCalled();

    handlers.get('approval_resolved')?.({ approvalId: 'a1', outcome: 'granted' });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: harnessKeys.status('/repo') });
  });

  it('re-reads the project it was mounted for, not some other one', () => {
    // Purpose: the key is per project, and a hook that invalidated the whole
    // `harness` namespace would re-read every folder a person had opened —
    // three synchronous filesystem walks each, for one decision about one.
    const { invalidate } = mount('/other-repo');

    handlers.get('approval_resolved')?.({ approvalId: 'a1', outcome: 'denied' });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: harnessKeys.status('/other-repo') });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: harnessKeys.all });
  });
});
