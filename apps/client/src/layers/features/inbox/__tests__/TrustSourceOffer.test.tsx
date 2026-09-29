/**
 * The one-time "Next time, trust everything from <source>?" under an approval's
 * history row (spec `flow-multiproject` §9.3, V9): it appears only right after
 * this window turned an extension on, "Yes" trusts the exact source through
 * the person-only route, and either answer makes it go for good.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { extensionApprovalSubjectId } from '@dorkos/shared/extension-approval-schemas';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn(), useSafeNavigate: () => vi.fn() };
});

import { TransportProvider } from '@/layers/shared/model';
import {
  selectTrustOffer,
  TRUST_OFFER_TTL_MS,
  useTrustOfferStore,
} from '@/layers/entities/extension';
import { InboxList } from '../ui/InboxList';

const SOURCE = 'dork-labs/marketplace';

/** Flow's answered row, written `at` (ISO). */
function approvedRow(at = new Date().toISOString()): NotificationDTO {
  return {
    id: '01JZG0000000000000000011',
    kind: 'extension.approval',
    tier: 'notable',
    subject: {
      type: 'system',
      id: extensionApprovalSubjectId({
        id: 'flow',
        path: '/p/flow',
        plugin: 'flow',
        version: '1.0.0',
      }),
    },
    title: 'You turned on Flow',
    body: 'Flow tab added',
    createdAt: at,
    readAt: at,
    resolvedAt: at,
    outcome: 'approved',
  };
}

let writes: Array<{ method: string; body: unknown }>;

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url.endsWith('/extensions/trusted-sources') && init?.method) {
    writes.push({ method: init.method, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ sources: [{ source: SOURCE, trustedAt: 'now' }] }));
  }
  if (url.endsWith('/extensions')) return new Response('[]');
  if (url.endsWith('/extensions/pending-approvals')) return new Response('{"approvals":[]}');
  return new Response('{}', { status: 404 });
}

function renderList(row: NotificationDTO) {
  const transport = createMockTransport({
    listNotifications: vi.fn().mockResolvedValue({
      notifications: [row],
      nextCursor: null,
      unreadCount: 0,
    }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return render(<InboxList />, { wrapper: Wrapper });
}

describe('the one-time trust offer', () => {
  beforeEach(() => {
    writes = [];
    useTrustOfferStore.getState().withdrawAll();
    vi.stubGlobal('fetch', vi.fn(fakeFetch));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('does not appear on a history row this window did not just answer', async () => {
    renderList(approvedRow());
    await screen.findByText('You turned on Flow');
    expect(screen.queryByText(/Next time, trust everything from/)).not.toBeInTheDocument();
  });

  it('appears once under the row, and Yes trusts the exact source', async () => {
    useTrustOfferStore.getState().offer('flow', SOURCE);
    const user = userEvent.setup();
    renderList(approvedRow());

    expect(await screen.findByText(/Next time, trust everything from/)).toHaveTextContent(
      `Next time, trust everything from ${SOURCE}?`
    );
    await user.click(screen.getByRole('button', { name: 'Yes' }));

    await waitFor(() => expect(writes).toEqual([{ method: 'POST', body: { source: SOURCE } }]));
    await waitFor(() =>
      expect(screen.queryByText(/Next time, trust everything from/)).not.toBeInTheDocument()
    );
    expect(useTrustOfferStore.getState().offers).toEqual({});
  });

  it('goes away on a quiet no, having written nothing', async () => {
    useTrustOfferStore.getState().offer('flow', SOURCE);
    const user = userEvent.setup();
    renderList(approvedRow());

    await user.click(await screen.findByRole('button', { name: 'No thanks' }));

    expect(screen.queryByText(/Next time, trust everything from/)).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('never rides an older approval', () => {
    const now = Date.now();
    const offers = { flow: { extensionId: 'flow', source: SOURCE, offeredAt: now } };
    expect(selectTrustOffer(offers, 'flow', new Date(now).toISOString())).not.toBeNull();
    expect(selectTrustOffer(offers, 'flow', new Date(now - 10 * 60_000).toISOString())).toBeNull();
    expect(selectTrustOffer(offers, 'other', new Date(now).toISOString())).toBeNull();
  });

  it('goes by itself after 15 minutes unanswered', () => {
    vi.useFakeTimers();
    try {
      useTrustOfferStore.getState().offer('flow', SOURCE);
      vi.advanceTimersByTime(TRUST_OFFER_TTL_MS - 1);
      expect(useTrustOfferStore.getState().offers.flow).toBeDefined();
      vi.advanceTimersByTime(1);
      expect(useTrustOfferStore.getState().offers.flow).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
