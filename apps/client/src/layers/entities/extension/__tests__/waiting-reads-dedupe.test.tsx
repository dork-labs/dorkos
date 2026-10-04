/**
 * @vitest-environment jsdom
 */
/**
 * One fresh server read per event, however many surfaces mount the hook
 * (DOR-2578).
 *
 * The bell, Pulse and Home each mount `useExtensionDecisions` and
 * `usePendingExtensionApprovals`, and every copy hears the same event. Two
 * promises are pinned:
 *
 * - **One read per event.** Seeded defect: drop the `isRefreshLeader()` guard
 *   and every copy invalidates, so one event reaches the server three times.
 * - **The read after the last event is fresh.** Seeded defect: invalidate
 *   with `cancelRefetch: false` and a second event mid-read joins a read that
 *   started before it, so what it announced is missing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Handler = (raw: unknown) => void;
/** One stable dispatcher per mounted copy and event, as the real stream holds. */
const handlers = new Map<string, Handler[]>();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  const { useRef } = await import('react');
  return {
    ...actual,
    useEventSubscription: (event: string, handler: Handler) => {
      const latest = useRef<Handler | null>(null);
      if (latest.current === null) {
        const list = handlers.get(event) ?? [];
        list.push((raw) => latest.current?.(raw));
        handlers.set(event, list);
      }
      latest.current = handler;
    },
  };
});

import { useExtensionDecisions } from '../model/use-extension-decisions';
import { usePendingExtensionApprovals } from '../model/use-pending-extension-approvals';

/** Reads per path. */
const reads = new Map<string, number>();
/** What the fake server holds right now — each read answers with it as of its START. */
let serverDecisionIds: string[] = [];
/** How long a read takes to answer, in ms. */
let readMs = 20;

function decision(id: string) {
  return {
    id,
    extensionId: 'flow',
    extensionName: 'Flow',
    key: id,
    title: 'Ship it?',
    why: 'Review passed.',
    detail: null,
    project: null,
    projectLabel: null,
    since: null,
    actions: { kind: 'word', label: 'Open' },
    link: null,
    raisedAt: '2026-10-01T09:00:00.000Z',
    needsYou: false,
    watch: null,
    revision: 0,
  };
}

function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  const path = url.endsWith('/extension-decisions') ? 'decisions' : 'approvals';
  reads.set(path, (reads.get(path) ?? 0) + 1);
  const body =
    path === 'decisions'
      ? { decisions: serverDecisionIds.map(decision), offers: [] }
      : { approvals: [] };
  return new Promise((resolve) =>
    setTimeout(() => resolve(new Response(JSON.stringify(body))), readMs)
  );
}

/** Fire `event` at every mounted copy, in one tick — as the event stream does. */
function emit(event: string, raw: unknown) {
  for (const handler of handlers.get(event) ?? []) handler(raw);
}

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { queryClient, Wrapper };
}

function renderThreeCopies(Hook: () => unknown) {
  const { queryClient, Wrapper } = makeWrapper();
  function Copy() {
    Hook();
    return null;
  }
  render(
    <Wrapper>
      <Copy />
      <Copy />
      <Copy />
    </Wrapper>
  );
  return queryClient;
}

beforeEach(() => {
  handlers.clear();
  reads.clear();
  serverDecisionIds = [];
  readMs = 20;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('extension waiting reads — one read per event', () => {
  it('re-reads the decisions once when three copies hear one event', async () => {
    const queryClient = renderThreeCopies(useExtensionDecisions);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(reads.get('decisions')).toBe(1);

    act(() => emit('standing_pending', { kind: 'extension.decision' }));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    expect(reads.get('decisions')).toBe(2);
  });

  it('re-reads the waiting extensions once when three copies hear one event', async () => {
    const queryClient = renderThreeCopies(usePendingExtensionApprovals);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(reads.get('approvals')).toBe(1);

    act(() => emit('standing_pending', { kind: 'extension.approval' }));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    expect(reads.get('approvals')).toBe(2);
  });
});

describe('extension waiting reads — the last event wins', () => {
  it('ends with both decisions when the second arrives mid-read', async () => {
    readMs = 100;
    const { queryClient, Wrapper } = makeWrapper();
    const { result } = renderHook(() => useExtensionDecisions(), { wrapper: Wrapper });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    // Decision A is raised; its read starts and takes 100ms.
    serverDecisionIds = ['A'];
    act(() => emit('standing_pending', { kind: 'extension.decision' }));
    // 50ms in, decision B is raised while A's read is still running.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    serverDecisionIds = ['A', 'B'];
    act(() => emit('standing_pending', { kind: 'extension.decision' }));

    await waitFor(() => expect(queryClient.isFetching()).toBe(0), { timeout: 2000 });
    expect(result.current.decisions.map((d) => d.id)).toEqual(['A', 'B']);
  });
});
