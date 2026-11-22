/**
 * What a yes on an approval says when "Confirm it's you" closed without
 * confirming (DOR-4909): nothing was allowed, said calmly rather than as a
 * failure, so the card never reads as if the yes landed.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { STEP_UP_REQUIRED_CODE } from '@dorkos/shared/step-up';
import type { Transport } from '@dorkos/shared/transport';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

import { toast } from 'sonner';
import { TransportProvider } from '@/layers/shared/model';
import { useGrantApproval } from '../model/use-approval-decision';

function mount(grantApproval: Transport['grantApproval']) {
  const transport = createMockTransport({ grantApproval });
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return renderHook(() => useGrantApproval(), { wrapper: Wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useGrantApproval after a cancelled "Confirm it’s you"', () => {
  it('says nothing was allowed, calmly, with no failure toast', async () => {
    const { result } = mount(
      vi.fn<Transport['grantApproval']>().mockRejectedValue(
        Object.assign(new Error('Not confirmed. Nothing changed.'), {
          code: STEP_UP_REQUIRED_CODE,
        })
      )
    );
    act(() => result.current.mutate({ approvalId: 'approval-1' }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast).toHaveBeenCalledExactlyOnceWith('Not confirmed. Nothing was allowed.');
    expect(toast.error).not.toHaveBeenCalled();
  });
});
