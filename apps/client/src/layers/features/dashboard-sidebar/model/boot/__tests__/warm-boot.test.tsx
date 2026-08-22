/**
 * The whole warm boot, end to end (spec `sidebar-simplification` D6, task 3.2).
 *
 * **Nothing here is mocked at the query layer, and that is the point.**
 * `use-boot-state.test.tsx` next door stands the ten query states up by hand,
 * which settles the ARBITRATION but can never notice that the allow-list in
 * `shared/lib/query-persister.ts` spells a key the hooks do not use. That
 * allow-list has to be spelled literally — `shared/` may not import the entity
 * modules the factories live in — so a rename there would empty the cache in
 * silence and every unit test in this directory would stay green.
 *
 * So this drives the real hooks against a real `QueryClient` twice: once with a
 * transport that answers, to fill and persist; once with a transport that never
 * answers, so the ONLY thing that can make `startedWarm` true is what came back
 * out of storage. Change one key on either side and this goes red.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { dehydrate, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { createBootCache, HttpTransport } from '@/layers/shared/lib';
import { configKeys } from '@/layers/shared/model';
import { powerFixture } from '../../fixtures/power';
// Heads up's three sources are the one part of the gate that is mocked here,
// and only because they ride a live event stream this harness has no server
// for. They are also the three the allow-list deliberately EXCLUDES — what
// needs a person now must never be replayed from yesterday — so nothing this
// file is about passes through them. That exclusion is asserted directly in
// `shared/lib/__tests__/query-persister.test.ts`.
vi.mock('@/layers/entities/attention', () => ({
  usePendingApprovals: () => ({ isLoading: false }),
  usePendingInteractions: () => ({ isLoading: false }),
  usePendingScheduleApprovals: () => ({ isLoading: false }),
}));

const { useBootState } = await import('../use-boot-state');

/** A `Storage` in a plain object, so the two mounts share one and nothing else does. */
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

/** The transport of the first load: it answers, and the fleet has one agent in it. */
function answeringTransport(): Transport {
  const transport = createMockTransport();
  transport.listMeshAgentPaths = () =>
    Promise.resolve({ agents: [{ agentId: 'scout', projectPath: '/work/scout' }] } as never);
  transport.resolveAgents = () =>
    Promise.resolve({ '/work/scout': { id: 'scout', name: 'Scout' } } as never);
  return transport as unknown as Transport;
}

/**
 * The transport of the reload, before the network has come back.
 *
 * Every read hangs, so a query that is not hydrated stays `dataUpdatedAt: 0`
 * forever and `startedWarm` can only be true because the storage said so.
 */
function silentTransport(): Transport {
  const transport = createMockTransport() as unknown as Record<string, unknown>;
  const never = () => new Promise(() => {});
  for (const key of Object.keys(transport)) {
    if (typeof transport[key] === 'function') transport[key] = never;
  }
  return transport as unknown as Transport;
}

/** Mount `useBootState` against one client and one transport. */
function mount(client: QueryClient, transport: Transport) {
  return renderHook(() => useBootState(), {
    wrapper: ({ children }) => (
      <TransportProvider transport={transport}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </TransportProvider>
    ),
  });
}

/** A boot cache over one storage, as the web cockpit builds it. */
function bootCacheOver(storage: Storage, buster = '1.0.0') {
  return createBootCache({
    // `createBootCache` decides on the transport's identity, and only
    // `HttpTransport` persists — so the real class, never a stand-in.
    transport: new HttpTransport('/api'),
    apiBaseUrl: '/api',
    buster,
    storage,
  })!;
}

describe('booting the sidebar from local memory', () => {
  it('paints warm on the reload, from the answers the last load left behind', async () => {
    const storage = fakeStorage();

    // ── First load: cold, then everything answers ──
    const first = new QueryClient();
    const firstMount = mount(first, answeringTransport());
    expect(firstMount.result.current.startedWarm).toBe(false);
    await waitFor(() => expect(firstMount.result.current.settled).toBe(true));
    firstMount.unmount();

    // What the persister would have written, through the real allow-list.
    const cache = bootCacheOver(storage);
    await cache.persistOptions.persister.persistClient({
      buster: '1.0.0',
      timestamp: Date.now(),
      clientState: dehydrate(first, cache.persistOptions.dehydrateOptions),
    });
    await waitFor(() => expect(storage.length).toBe(1), { timeout: 5_000 });

    // ── The reload: a fresh client, a network that says nothing ──
    const second = new QueryClient();
    bootCacheOver(storage).restore(second);
    const secondMount = mount(second, silentTransport());

    // The very first render, with no `await` in front of it. This is the
    // assertion the whole task exists for: the panel knows its shape before the
    // server has said a word, so it is simply there rather than animating in.
    expect(secondMount.result.current.startedWarm).toBe(true);
    expect(secondMount.result.current.phase).not.toBe('cold');
    secondMount.unmount();
  });

  it('paints cold when the remembered blob is from another build', async () => {
    const storage = fakeStorage();

    const first = new QueryClient();
    const firstMount = mount(first, answeringTransport());
    await waitFor(() => expect(firstMount.result.current.settled).toBe(true));
    firstMount.unmount();

    const cache = bootCacheOver(storage, '1.0.0');
    await cache.persistOptions.persister.persistClient({
      buster: '1.0.0',
      timestamp: Date.now(),
      clientState: dehydrate(first, cache.persistOptions.dehydrateOptions),
    });
    await waitFor(() => expect(storage.length).toBe(1), { timeout: 5_000 });

    const second = new QueryClient();
    bootCacheOver(storage, '2.0.0').restore(second);
    const secondMount = mount(second, silentTransport());

    // A new build may have changed what a payload looks like, so it starts from
    // nothing rather than hydrating yesterday's shape into today's components.
    expect(secondMount.result.current.startedWarm).toBe(false);
    expect(secondMount.result.current.phase).toBe('cold');
    secondMount.unmount();
  });

  it('stays far inside a browser’s storage budget at the busiest scale we design for', () => {
    // The `power` fixture is the fleet the design has to hold its shape under —
    // 32 agents, 60 rooms, 40 sessions — and its payloads ARE the wire shapes
    // these queries return, so this measures the real blob rather than a guess
    // at one.
    const client = new QueryClient();
    client.setQueryData(configKeys.current(), { userSettings: powerFixture.prefs });
    client.setQueryData(['rooms', 'list', null], powerFixture.rooms);
    client.setQueryData(['rooms', 'threads'], powerFixture.threads);
    client.setQueryData(['mesh', 'agent-paths'], {
      agents: powerFixture.agents.map((entry) => ({
        agentId: entry.path,
        projectPath: entry.path,
      })),
    });
    client.setQueryData(
      ['agents', 'resolved', ...powerFixture.agents.map((entry) => entry.path)],
      Object.fromEntries(powerFixture.agents.map((entry) => [entry.path, entry]))
    );
    client.setQueryData(['recent-sessions', 24], powerFixture.sessions);
    client.setQueryData(['team'], powerFixture.agents);

    const cache = createBootCache({
      transport: new HttpTransport('/api'),
      apiBaseUrl: '/api',
      buster: '1.0.0',
      storage: fakeStorage(),
    })!;
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        buster: '1.0.0',
        timestamp: Date.now(),
        clientState: dehydrate(client, cache.persistOptions.dehydrateOptions),
      })
    ).length;

    // Measured at 46,653 bytes — about 46 KB for the busiest fleet the design
    // covers. A browser gives an origin roughly 5 MB of `localStorage`, shared
    // with everything else the cockpit keeps there, so a quarter of a megabyte
    // is the line: five times the real figure, and low enough that crossing it
    // means something got into the allow-list that does not belong — a
    // transcript, a room's history — rather than that a person's fleet grew.
    expect(bytes).toBeLessThan(256 * 1024);
  });
});
