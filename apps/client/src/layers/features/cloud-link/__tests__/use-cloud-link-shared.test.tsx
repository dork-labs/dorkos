/**
 * @vitest-environment jsdom
 */
/**
 * One link flow for every surface (spec `dorkos-account-by-default` §3): two
 * readers share one code, the code that landed is recorded with the surface
 * that started it, and a relink that did not replace the link records nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { useCloudLink } from '../model/use-cloud-link';

/** Flush promise microtasks + due timers under fake timers. */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setup() {
  vi.useFakeTimers();
  const transport = createMockTransport();
  vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'idle' });
  vi.mocked(transport.startCloudLink).mockResolvedValue({
    userCode: 'WXYZ7890',
    verificationUri: 'https://dorkos.ai/activate',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  const both = renderHook(() => ({ here: useCloudLink(), there: useCloudLink() }), { wrapper });
  return { transport, both };
}

/** Let the next poll answer `linked`, optionally with how a relink ended. */
function land(transport: Transport, relinkOutcome?: 'denied') {
  vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({
    state: 'linked',
    accountLabel: 'kai@dork.dev',
    ...(relinkOutcome ? { relinkOutcome } : {}),
  });
}

describe('the shared link flow', () => {
  afterEach(() => vi.useRealTimers());

  it('shows one code to every reader, and names the surface that started it', async () => {
    const { both } = setup();
    await flush();
    await act(() => both.result.current.here.start({ origin: 'runtime-connect:claude-code' }));
    await flush();

    expect(both.result.current.there.view).toMatchObject({ kind: 'pending', userCode: 'WXYZ7890' });
    expect(both.result.current.there.origin).toBe('runtime-connect:claude-code');
  });

  it('records the code that landed and the surface that started it, once approved', async () => {
    const { transport, both } = setup();
    await flush();
    let code: string | null = null;
    await act(async () => {
      code = await both.result.current.here.start({ origin: 'a' });
    });
    expect(code).toBe('WXYZ7890');
    await flush();
    expect(both.result.current.there.landed).toBeNull();
    land(transport);
    await flush(2500);
    await flush(10);

    expect(both.result.current.there.view.kind).toBe('linked');
    expect(both.result.current.there.landed).toEqual({ userCode: 'WXYZ7890', origin: 'a' });
  });

  it('records nothing for a relink that did not replace the link', async () => {
    const { transport, both } = setup();
    await flush();
    await act(() => both.result.current.here.start({ origin: 'a' }));
    await flush();
    land(transport, 'denied');
    await flush(2500);
    await flush(10);

    expect(both.result.current.there.landed).toBeNull();
  });

  it('names the surface before the request, so a start that fails says so where it was asked', async () => {
    const { transport, both } = setup();
    vi.mocked(transport.startCloudLink).mockRejectedValue(new Error('The cloud is down.'));
    await flush();
    await act(() => both.result.current.here.start({ origin: 'a' }));
    await flush();

    expect(both.result.current.there.origin).toBe('a');
    expect(both.result.current.there.startError).toBe('The cloud is down.');
  });

  it('gets a new code for the same surface after one expires', async () => {
    const { transport, both } = setup();
    await flush();
    await act(() => both.result.current.here.start({ origin: 'a' }));
    await flush();
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'expired' });
    await flush(2500);
    await flush(10);
    expect(both.result.current.there.view.kind).toBe('expired');

    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'idle' });
    await act(() => both.result.current.there.restart());
    await flush();
    expect(both.result.current.here.origin).toBe('a');
    expect(both.result.current.here.view.kind).toBe('pending');
  });
});
