/**
 * @vitest-environment jsdom
 */
/**
 * One server read per event, however many surfaces mount the hook (DOR-2578).
 *
 * The bell, Pulse and Home each mount `useExtensionDecisions` and
 * `usePendingExtensionApprovals`, and every copy hears the same event and
 * invalidates. With TanStack's default `cancelRefetch: true` each invalidate
 * cancels the read in flight and starts another, so one event reached the
 * server once per mounted copy. Seeded defect: drop `{ cancelRefetch: false }`
 * from either call and its case below counts three reads, not one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Handler = (raw: unknown) => void;
/** Every subscription made, by event name — one per mounted hook copy. */
const handlers = new Map<string, Handler[]>();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      if (!list.includes(handler)) list.push(handler);
      handlers.set(event, list);
    },
  };
});

import { useExtensionDecisions } from '../model/use-extension-decisions';
import { usePendingExtensionApprovals } from '../model/use-pending-extension-approvals';

/** Reads per path, answered slowly enough that a second invalidate lands mid-read. */
const reads = new Map<string, number>();

function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  const path = url.endsWith('/extension-decisions') ? 'decisions' : 'approvals';
  reads.set(path, (reads.get(path) ?? 0) + 1);
  const body = path === 'decisions' ? { decisions: [], offers: [] } : { approvals: [] };
  return new Promise((resolve) =>
    setTimeout(() => resolve(new Response(JSON.stringify(body))), 20)
  );
}

/** Fire `event` at every mounted copy, in one tick — as the event stream does. */
function emit(event: string, raw: unknown) {
  for (const handler of handlers.get(event) ?? []) handler(raw);
}

function renderThreeCopies(Hook: () => unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Copy() {
    Hook();
    return null;
  }
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
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
