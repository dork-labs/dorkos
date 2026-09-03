/**
 * The offer disclosure must never report "nothing scheduled" for a package it
 * has not managed to ask the server about (DOR-644).
 *
 * **`isLoading` is the trap, and it is the same one
 * `use-onboarding-restoring.test.tsx` pins.** It is `isPending && isFetching`,
 * so a query that is pending but NOT fetching — paused while the persisted cache
 * restores, or paused by a `networkMode` that pauses — reports `isLoading:
 * false` with `data === undefined`. Read naively that says "the answer is in,
 * and it is nothing": the create gate opens and the arrival card renders no
 * schedule row for a package whose cron nobody has looked at yet.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import type { Persister } from '@tanstack/react-query-persist-client';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import type { CreationSeed } from '@/layers/shared/model';
import { useOfferSchedules } from '../model/use-offer-schedules';

/** A marketplace-agent offer, the only kind that has a package to ask about. */
const PACKAGE_SEED: CreationSeed = {
  origin: 'marketplace-agent',
  packageName: '@dorkos/night-sweeper',
  template: { displayName: 'Night Sweeper' },
};

/** One preview reply carrying a single scheduled job. */
const PREVIEW_WITH_SCHEDULE = {
  manifest: { name: '@dorkos/night-sweeper', type: 'agent' },
  packagePath: '/tmp/staged',
  preview: {
    fileChanges: [],
    extensions: [],
    hooks: [],
    unreadableHooks: [],
    schedules: [
      {
        name: 'overnight-sweep',
        cron: '0 3 * * *',
        permissionMode: 'acceptEdits',
        startsEnabled: true,
      },
    ],
    secrets: [],
    npmDependencies: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
  },
};

/**
 * A persister whose restore never settles until released — the window in which
 * every query is paused. Short in production and impossible to poll for, so it
 * is held open here rather than raced.
 */
function heldPersister(): { persister: Persister; release: () => void } {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    persister: {
      persistClient: () => Promise.resolve(),
      removeClient: () => Promise.resolve(),
      restoreClient: async () => {
        await held;
        return undefined;
      },
    },
  };
}

function renderOfferSchedules(transport: Partial<Transport>, persister: Persister) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useOfferSchedules(PACKAGE_SEED), {
    wrapper: ({ children }) => (
      <TransportProvider transport={transport as unknown as Transport}>
        <PersistQueryClientProvider client={queryClient} persistOptions={{ persister }}>
          {children}
        </PersistQueryClientProvider>
      </TransportProvider>
    ),
  });
}

/** The same hook with nothing holding the query back, so replies actually land. */
function renderPlain(transport: Partial<Transport>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useOfferSchedules(PACKAGE_SEED), {
    wrapper: ({ children }) => (
      <TransportProvider transport={transport as unknown as Transport}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </TransportProvider>
    ),
  });
}

describe('useOfferSchedules while the query cannot run yet', () => {
  it('keeps the gate shut rather than reporting "nothing scheduled"', async () => {
    const { persister, release } = heldPersister();
    const transport = createMockTransport();
    vi.mocked(transport.previewMarketplacePackage).mockResolvedValue(
      PREVIEW_WITH_SCHEDULE as never
    );

    const { result } = renderOfferSchedules(transport, persister);

    // Mid-restore: paused, so `isLoading` is false and `data` is undefined.
    // Nothing has been read, so nothing may be concluded — and above all the
    // create button must not be offered on the strength of an empty list.
    expect(result.current.isChecking).toBe(true);
    expect(result.current.failed).toBe(false);
    expect(result.current.schedules).toEqual([]);

    release();

    // And once the answer really arrives, it is the server's.
    await waitFor(() => expect(result.current.isChecking).toBe(false));
    expect(result.current.schedules).toHaveLength(1);
    expect(result.current.schedules[0]?.name).toBe('overnight-sweep');
  });

  it('reports a real failure as failed, not as still-checking', async () => {
    const { persister, release } = heldPersister();
    const transport = createMockTransport();
    vi.mocked(transport.previewMarketplacePackage).mockRejectedValue(new Error('unreachable'));

    const { result } = renderOfferSchedules(transport, persister);
    release();

    // A failure is a settled answer: the gate opens and the card says so,
    // rather than holding Create forever on a question that will never resolve.
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.isChecking).toBe(false);
    expect(result.current.schedules).toEqual([]);
  });

  it('survives a 200 whose body carries no preview', async () => {
    const transport = createMockTransport();
    // An older or degraded server answering without the key. Reading
    // `data.preview.schedules` through a single optional chain threw here,
    // taking the whole dialog down instead of degrading to "nothing to show".
    vi.mocked(transport.previewMarketplacePackage).mockResolvedValue({
      manifest: { name: '@dorkos/night-sweeper', type: 'agent' },
      packagePath: '/tmp/staged',
    } as never);

    // Deliberately NO held persister here, unlike the two tests above. A paused
    // query never reaches the malformed body at all, so pausing would make this
    // test pass whether the guard exists or not — waiting on a flag that is
    // already false while `data` is still undefined proves nothing. Landing the
    // reply is the whole point, so this one lets it land.
    const { result } = renderPlain(transport);

    await waitFor(() => expect(transport.previewMarketplacePackage).toHaveBeenCalled());
    // The answer really arrived — this is what the paused variant could not say.
    await waitFor(() => expect(result.current.isChecking).toBe(false));
    expect(result.current.schedules).toEqual([]);
    expect(result.current.failed).toBe(false);
  });
});
