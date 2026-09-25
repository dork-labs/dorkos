/**
 * A template that needs reviewing is a question the dialog asks, not a
 * failure: it must never also raise the shared failure toast (DOR-2325).
 * Every other failure still does.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { createQueryClientConfig } from '@/layers/shared/lib/query-client';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: toastError }) }));

import { useCreateAgent } from '../model/use-create-agent';

/** Run one create that fails with `error`, through the app's own query client. */
async function failWith(error: Error) {
  const transport = createMockTransport();
  vi.mocked(transport.createAgent).mockRejectedValue(error);
  const client = new QueryClient(createQueryClientConfig());
  const { result } = renderHook(() => useCreateAgent(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  });
  result.current.mutate({ name: 'bot' });
  await waitFor(() => expect(result.current.isError).toBe(true));
}

describe('useCreateAgent failures', () => {
  it('raises no toast for a template the dialog is asking about', async () => {
    toastError.mockClear();
    await failWith(Object.assign(new Error('review'), { body: { code: 'template_needs_review' } }));
    expect(toastError).not.toHaveBeenCalled();
  });

  it('still toasts every other failure', async () => {
    toastError.mockClear();
    await failWith(new Error('disk full'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});
