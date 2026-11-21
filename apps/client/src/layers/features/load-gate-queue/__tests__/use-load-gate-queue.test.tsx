/** @vitest-environment jsdom */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import type { Transport } from '@dorkos/shared/transport';
import { useLoadGateWaitingLine } from '../model/use-load-gate-queue';

/** The transport call the hook polls. */
type ReadLine = Transport['getLoadGateWaitingLine'];

/** An error the way `fetchJSON` throws one: the HTTP status rides on it. */
const failed = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

/** Read the line with `read` as the transport's answer. */
function readLine(read: ReadLine) {
  const transport = createMockTransport({ getLoadGateWaitingLine: read });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  const view = renderHook(() => useLoadGateWaitingLine(), { wrapper });
  return () => {
    view.unmount();
    client.clear();
  };
}

let done: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  done?.();
  done = undefined;
  vi.useRealTimers();
});

describe('useLoadGateWaitingLine', () => {
  it('reads the line again every 5 seconds', async () => {
    const read = vi.fn<ReadLine>().mockResolvedValue({ jobs: [] });
    done = readLine(read);
    await vi.advanceTimersByTimeAsync(10_000);
    // Once on mount, then at 5s and 10s.
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403])('stops reading after a %i: asking again changes nothing', async (status) => {
    const read = vi.fn<ReadLine>().mockRejectedValue(failed(status));
    done = readLine(read);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps reading after any other failure', async () => {
    const read = vi.fn<ReadLine>().mockRejectedValue(failed(500));
    done = readLine(read);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
