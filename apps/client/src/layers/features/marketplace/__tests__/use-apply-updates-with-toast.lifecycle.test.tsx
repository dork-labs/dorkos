/**
 * @vitest-environment jsdom
 *
 * `useApplyUpdatesWithToast` against the real `useApplyUpdates` mutation and a
 * real QueryClient: the cases where TanStack's per-call `mutate(…, { onSuccess })`
 * callbacks are skipped (a later call superseded them, or the component
 * unmounted) and a loading toast used to spin forever.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type {
  InstallationUpdateCheck,
  InstallationUpdatesResult,
} from '@dorkos/shared/marketplace-schemas';
import { TransportProvider } from '@/layers/shared/model';

import { useApplyUpdatesWithToast } from '../model/use-apply-updates-with-toast';
import type { StaleInstallation } from '../lib/installed-updates';

const toastMock = vi.hoisted(() => {
  // Numbered per test (the count clears with the mocks), so each apply's
  // outcome can be matched to the loading toast it must replace.
  const loading = vi.fn((_message: string) => `toast-${loading.mock.calls.length}`);
  return { loading, success: vi.fn(), error: vi.fn(), warning: vi.fn() };
});

vi.mock('sonner', () => ({ toast: toastMock }));

function stale(installPath: string, name: string): StaleInstallation {
  const check: InstallationUpdateCheck = {
    packageName: name,
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    hasUpdate: true,
    marketplace: 'dorkos-community',
    status: 'update-available',
    installedVersionSource: 'package',
    latestVersionSource: 'package',
    installPath,
    type: 'plugin',
    scope: 'global',
  };
  return {
    installation: { name, version: '1.0.0', type: 'plugin', installPath, scope: 'global' },
    check,
  };
}

const A = stale('/p/alpha', 'alpha');
const B = stale('/p/beta', 'beta');

/** The answer for one applied installation. */
function appliedAnswer(item: StaleInstallation): InstallationUpdatesResult {
  return {
    checks: [
      {
        ...item.check,
        applied: {
          ok: true,
          packageName: item.check.packageName,
          version: '1.1.0',
          type: 'plugin',
          installPath: item.check.installPath,
          manifest: { name: item.check.packageName, version: '1.1.0', type: 'plugin' },
          warnings: [],
        },
      },
    ],
  };
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return wrapper;
}

beforeEach(() => vi.clearAllMocks());

describe('useApplyUpdatesWithToast, lifecycle', () => {
  it('settles the toast of every overlapping apply, not only the latest', async () => {
    // Purpose: row A then row B before A answers. With per-call mutate
    // callbacks only B's outcome ran and A's loading toast spun forever.
    const transport = createMockTransport();
    const first = deferred<InstallationUpdatesResult>();
    const second = deferred<InstallationUpdatesResult>();
    vi.mocked(transport.applyMarketplaceUpdates)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useApplyUpdatesWithToast(), { wrapper: setup(transport) });

    act(() => result.current.apply([A]));
    act(() => result.current.apply([B]));
    await act(async () => first.resolve(appliedAnswer(A)));
    await act(async () => second.resolve(appliedAnswer(B)));

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(2));
    expect(toastMock.success).toHaveBeenCalledWith('Updated Alpha to v1.1.0', { id: 'toast-1' });
    expect(toastMock.success).toHaveBeenCalledWith('Updated Beta to v1.1.0', { id: 'toast-2' });
  });

  it('settles the toast when the view unmounts mid-apply', async () => {
    // Purpose: leaving the Installed tab while an update runs must still
    // replace its loading toast with the outcome.
    const transport = createMockTransport();
    const answer = deferred<InstallationUpdatesResult>();
    vi.mocked(transport.applyMarketplaceUpdates).mockReturnValueOnce(answer.promise);
    const { result, unmount } = renderHook(() => useApplyUpdatesWithToast(), {
      wrapper: setup(transport),
    });

    act(() => result.current.apply([A]));
    unmount();
    await act(async () => answer.resolve(appliedAnswer(A)));

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('Updated Alpha to v1.1.0', { id: 'toast-1' })
    );
  });

  it('reports a failure after unmount, once', async () => {
    const transport = createMockTransport();
    const answer = deferred<InstallationUpdatesResult>();
    vi.mocked(transport.applyMarketplaceUpdates).mockReturnValueOnce(answer.promise);
    const { result, unmount } = renderHook(() => useApplyUpdatesWithToast(), {
      wrapper: setup(transport),
    });

    act(() => result.current.apply([A]));
    unmount();
    await act(async () => answer.reject(new Error('disk full')));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(toastMock.error).toHaveBeenCalledWith('Couldn’t update Alpha', {
      id: 'toast-1',
      description: 'disk full',
    });
  });
});
