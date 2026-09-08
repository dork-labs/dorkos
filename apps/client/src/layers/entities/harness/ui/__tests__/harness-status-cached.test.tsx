/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { HARNESS_STATUS_READY } from '../../__fixtures__/harness-status';
import { harnessKeys } from '../../api/query-keys';
import { useHarnessStatusCached } from '../../model/use-harness-status-cached';

/**
 * The profile row, in miniature: it draws the number when the cache has one and
 * nothing at all when it does not, exactly as `countValue(null)` already does.
 */
function CountProbe({ projectPath }: { projectPath: string | null }) {
  const { data } = useHarnessStatusCached(projectPath);
  return <p data-testid="count">{data === undefined ? '' : `Skills ${data.counts.skills}`}</p>;
}

/** Let every effect, microtask and timer TanStack might use run before asking. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createHarness(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe('useHarnessStatusCached', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('draws nothing on a cold cache, and asks for nothing', async () => {
    // Purpose: Decision 28. Silence is the honest middle state — "Skills 0"
    // about an agent with thirty-one is the lie this whole change is fixing —
    // and the read costs three filesystem walks, so the row must not buy one.
    const getHarnessStatus = vi.fn();
    const { wrapper } = createHarness(createMockTransport({ getHarnessStatus }));

    render(<CountProbe projectPath="/repo" />, { wrapper });

    expect(screen.getByTestId('count')).toBeEmptyDOMElement();
    await flush();
    expect(getHarnessStatus).not.toHaveBeenCalled();
  });

  it('draws the count on a warm cache, and still asks for nothing', async () => {
    // Purpose: the same key the page fills, so the row's number and the page can
    // never be two different answers about one folder. Seeded defect: drop
    // `enabled: false` from the hook and the call count below goes to 1.
    const getHarnessStatus = vi.fn();
    const { queryClient, wrapper } = createHarness(createMockTransport({ getHarnessStatus }));
    queryClient.setQueryData(harnessKeys.status('/repo'), HARNESS_STATUS_READY);

    render(<CountProbe projectPath="/repo" />, { wrapper });

    expect(screen.getByTestId('count')).toHaveTextContent('Skills 6');
    await flush();
    expect(getHarnessStatus).not.toHaveBeenCalled();
  });

  it('draws nothing, and asks for nothing, when there is no folder to ask about', async () => {
    const getHarnessStatus = vi.fn();
    const { wrapper } = createHarness(createMockTransport({ getHarnessStatus }));

    render(<CountProbe projectPath={null} />, { wrapper });

    expect(screen.getByTestId('count')).toBeEmptyDOMElement();
    await flush();
    expect(getHarnessStatus).not.toHaveBeenCalled();
  });
});
