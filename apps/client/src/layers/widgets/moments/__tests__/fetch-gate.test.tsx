/**
 * The rail's launch-confirmation gate, driven end to end (DOR fetch-gate fix).
 *
 * **Nothing is mocked at the query layer, and that is the point.** The sibling
 * `MomentHost.test.tsx` stands `useConfig` up by hand, which settles the
 * ARBITRATION but can never notice the one thing this gate turns on: WHEN the
 * rail's own config observer attaches relative to the fetch that answers it.
 * `AppShell` mounts the rail late — behind a config-loaded gate — so on a cold
 * load the request has already resolved before the rail's observer exists, and
 * the per-observer `isFetchedAfterMount` the gate used to read stays false for
 * the whole launch. A cold load is not an edge case: the persister is busted by
 * build version, so every DorkOS update discards the cache and makes the next
 * launch cold — which is exactly the launch a one-time upgrade door is shipped
 * for.
 *
 * So this drives the REAL `MomentHost`, the REAL collector and the REAL
 * `PersistQueryClientProvider` against a mock transport, through the three boots
 * that matter. It pins both halves of the gate at once: it goes red on the old
 * `isFetchedAfterMount` gate (which never opens the cold load below) AND on the
 * `isFetched && !isRestoring` candidate (which opens the stale re-ask below).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, dehydrate, useIsRestoring } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';

import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';

import { TransportProvider, useAppStore, configKeys } from '@/layers/shared/model';
import { useConfig } from '@/layers/entities/config';
import { createBootCache, HttpTransport, bootCacheStorageKey } from '@/layers/shared/lib';
import { DialogTitle } from '@/layers/shared/ui';

import { MomentHost } from '@/layers/widgets/moments';

// Stub the two moment bodies so the REAL collector drives eligibility off real
// config, without dragging their router/mutation providers into this harness.
// The telemetry body is what the assertions look for; the door is stubbed out
// and kept ineligible below (`ui.fullPowerDecidedAt` set) so telemetry is the
// sole moment — the gate under test is identical for both (they share it).
vi.mock('@/layers/features/telemetry-consent', () => ({
  TelemetryConsentMoment: () => (
    <>
      <DialogTitle>telemetry moment</DialogTitle>
      <p>telemetry body</p>
    </>
  ),
}));
vi.mock('@/layers/features/full-power-door', () => ({
  FullPowerDoorMoment: () => null,
}));

const TELEMETRY_BODY = 'telemetry body';

/** A server config for an install past onboarding, with the door already answered. */
function config(telemetryDecided: boolean) {
  return {
    onboarding: { completedAt: '2026-08-01T10:00:00.000Z', dismissedAt: null },
    telemetry: { userHasDecided: telemetryDecided },
    ui: { fullPowerDecidedAt: '2026-08-01T10:00:00.000Z' },
  } as unknown as never;
}

/**
 * Mirrors `AppShell`: the rail is NOT mounted until config has finished loading
 * (or a timeout fires). This late mount is the whole reason a per-observer
 * "fetched after mount" signal misses the cold load.
 */
function AppShellSim() {
  const { isLoading } = useConfig();
  const isRestoring = useIsRestoring();
  const loading = isLoading || isRestoring;
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setTimedOut(true), 3000);
    return () => clearTimeout(t);
  }, [loading]);
  if (loading && !timedOut) return <div data-testid="blank" />;
  return <MomentHost />;
}

/**
 * Watches `document.body` — where Radix portals the dialog — for the telemetry
 * body EVER appearing across the whole boot, and returns a handle to ask later.
 *
 * A real subscription, not a render-once probe: it inspects each mutation's
 * added nodes (whose `textContent` survives even if the node is removed a beat
 * later), so a moment that opens off the stale copy and is then taken back down
 * when the server answers still trips it. That transient flash is exactly what a
 * settled-state assertion cannot see and the `isFetched && !isRestoring`
 * candidate produces here.
 */
function watchForFlash(): { everShown: () => boolean; stop: () => void } {
  let seen = false;
  const note = () => {
    if (document.body.textContent?.includes(TELEMETRY_BODY)) seen = true;
  };
  note();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if ((node.textContent ?? '').includes(TELEMETRY_BODY)) seen = true;
      }
    }
    note();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return { everShown: () => seen, stop: () => observer.disconnect() };
}

/** A `Storage` in a plain object, isolated to one test. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

function bootCacheOver(storage: Storage) {
  return createBootCache({
    transport: new HttpTransport('/api'),
    apiBaseUrl: '/api',
    buster: '1.0.0',
    storage,
  })!;
}

/**
 * Seed storage with a config restored from a PREVIOUS session — stamped an hour
 * ago, so it is unambiguously older than this launch's start.
 */
function seedStalePersist(storage: Storage, stale: unknown) {
  const writer = new QueryClient();
  writer.setQueryData(configKeys.current(), stale);
  const clientState = dehydrate(writer, bootCacheOver(storage).persistOptions.dehydrateOptions);
  for (const query of clientState.queries) {
    (query.state as { dataUpdatedAt: number }).dataUpdatedAt = Date.now() - 60 * 60 * 1000;
  }
  storage.setItem(
    bootCacheStorageKey('/api'),
    JSON.stringify({ buster: '1.0.0', timestamp: Date.now(), clientState })
  );
}

/** A transport whose `getConfig` answers `value` after a short, real delay. */
function transportAnswering(value: unknown): Transport {
  const transport = createMockTransport();
  transport.getConfig = vi
    .fn()
    .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(value), 20)));
  return transport as unknown as Transport;
}

beforeEach(() => {
  useAppStore.setState({ momentShownThisLaunch: false });
});
afterEach(cleanup);

describe('the moments rail launch-confirmation gate', () => {
  it('asks a cold-load undecided user — the boot every update lands on', async () => {
    // Cold: no persisted cache. The config request resolves BEFORE the late rail
    // mounts, so the retired `isFetchedAfterMount` gate would stay quiet all
    // launch and this user would never be asked.
    const client = new QueryClient();
    render(
      <TransportProvider transport={transportAnswering(config(false))}>
        <QueryClientProvider client={client}>
          <AppShellSim />
        </QueryClientProvider>
      </TransportProvider>
    );

    expect(await screen.findByText(TELEMETRY_BODY)).toBeInTheDocument();
  });

  it('waits for the server on a warm boot — never opens off the restored cache', async () => {
    const storage = fakeStorage();
    seedStalePersist(storage, config(false)); // restored copy: still undecided
    const client = new QueryClient();
    render(
      <TransportProvider transport={transportAnswering(config(false))}>
        <PersistQueryClientProvider
          client={client}
          persistOptions={bootCacheOver(storage).persistOptions}
        >
          <AppShellSim />
        </PersistQueryClientProvider>
      </TransportProvider>
    );

    // The rail mounts on the restored (stale) copy first. It must NOT open on it,
    // even though that copy says "undecided" — the server has not confirmed yet.
    await waitFor(() => expect(screen.queryByTestId('blank')).not.toBeInTheDocument());
    expect(screen.queryByText(TELEMETRY_BODY)).not.toBeInTheDocument();

    // Once the server confirms the question is still open, the moment appears.
    expect(await screen.findByText(TELEMETRY_BODY)).toBeInTheDocument();
  });

  it('never re-asks a user who answered elsewhere, from a stale restored cache', async () => {
    const storage = fakeStorage();
    // The restored copy is out of date: it says undecided, but the user has since
    // answered in another window / at the CLI, and the server now says decided.
    seedStalePersist(storage, config(false));
    const client = new QueryClient();
    const flash = watchForFlash();
    render(
      <TransportProvider transport={transportAnswering(config(true))}>
        <PersistQueryClientProvider
          client={client}
          persistOptions={bootCacheOver(storage).persistOptions}
        >
          <AppShellSim />
        </PersistQueryClientProvider>
      </TransportProvider>
    );

    // Let the whole boot settle: restore, hydrate, and the server refetch.
    await waitFor(() => expect(screen.queryByTestId('blank')).not.toBeInTheDocument());
    await waitFor(() => expect(client.getQueryData(configKeys.current())).toEqual(config(true)));
    // A render after the refetch has landed, so a candidate that opened off the
    // stale copy would have had its frame.
    await Promise.resolve();
    flash.stop();

    expect(screen.queryByText(TELEMETRY_BODY)).not.toBeInTheDocument();
    // And it never flickered on and off in the window before the server answered.
    // This is the stronger of the two: the settled-state assertion above passes
    // even for a candidate that opens then closes, whereas this catches the
    // transient open. (Test (b) is the other guard against that candidate — it
    // pins the "must not open off the restored copy at mount" edge directly.)
    expect(flash.everShown()).toBe(false);
  });
});
