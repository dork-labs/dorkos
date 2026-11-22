/**
 * What remembers an Allow that ended on "Confirm it's you" closed without
 * confirming (DOR-4909): kept per version, and forgotten by any yes that lands.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { STEP_UP_REQUIRED_CODE } from '@dorkos/shared/step-up';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

import {
  useAllowNotConfirmed,
  useAllowNotConfirmedStore,
} from '../model/allow-not-confirmed-store';
import { useExtensionApprovalActions } from '../model/use-extension-approval-actions';

const COPY = {
  id: 'desk',
  name: 'Desk',
  path: '/home/sample/desk',
  version: '1.0.0',
  plugin: null,
};

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

afterEach(() => {
  useAllowNotConfirmedStore.setState({ versions: {} });
  vi.unstubAllGlobals();
});

describe('an Allow left unconfirmed', () => {
  it('is kept for the version it was for, and a newer version asks afresh', () => {
    act(() => useAllowNotConfirmedStore.getState().remember('desk', '1.0.0'));
    expect(renderHook(() => useAllowNotConfirmed('desk', '1.0.0')).result.current).toBe(true);
    expect(renderHook(() => useAllowNotConfirmed('desk', '1.1.0')).result.current).toBe(false);
  });

  it('is remembered on a cancel and forgotten by the next yes that lands', async () => {
    let status = 428;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/approve')) {
          return status === 428
            ? json({ error: 'Not confirmed. Nothing changed.', code: STEP_UP_REQUIRED_CODE }, 428)
            : json({ extension: { id: 'desk' } }, 200);
        }
        // The fresh list still has it waiting: nothing went through elsewhere.
        return json({ approvals: [{ id: 'desk' }] }, 200);
      })
    );
    const { result } = renderHook(() => useExtensionApprovalActions(), { wrapper });
    const failed = vi.fn();
    act(() => result.current.approve(COPY, undefined, failed));
    await waitFor(() => expect(failed).toHaveBeenCalled());
    expect(useAllowNotConfirmedStore.getState().versions).toEqual({ desk: '1.0.0' });

    status = 200;
    const done = vi.fn();
    act(() => result.current.approve(COPY, done));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(useAllowNotConfirmedStore.getState().versions).toEqual({});
  });
});
