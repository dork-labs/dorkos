/**
 * An extension's decisions in Activity (spec `flow-multiproject` §7.4, §7.8,
 * §7.9): the answered row in the question's own words with who decided, the
 * one-time follow-up offer under it, and "While you were away" for what was
 * decided without the person.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { createMockTransport } from '@dorkos/test-utils';

const navigate = vi.fn();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn(), useSafeNavigate: () => navigate };
});

import { TransportProvider } from '@/layers/shared/model';
import { InboxList } from '../ui/InboxList';

let n = 0;
function decided(
  resolvedBy: 'person' | 'agent' | 'rule' | 'deadline' | 'extension',
  overrides: Partial<NotificationDTO> = {}
): NotificationDTO {
  n += 1;
  return {
    id: `01JZG${String(n).padStart(20, '0')}`,
    kind: 'extension.decision',
    tier: 'blocking',
    subject: { type: 'system', id: `01J00000000000000000000D${String(n).padStart(2, '0')}` },
    title: `Decision ${n}`,
    body: resolvedBy === 'person' ? 'Ship it · you' : 'Shipped · the reviewer agent',
    createdAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    outcome: 'approved',
    readAt: new Date().toISOString(),
    decision: {
      extensionId: 'flow',
      resolvedBy,
      resolvedByLabel: null,
      recorded: false,
      watch: null,
    },
    ...overrides,
  };
}

let offers: Array<{ decisionId: string; text: string; expiresAt: string }>;
let posts: Array<{ url: string; body: unknown }>;

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  if (init?.method === 'POST') {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    offers = [];
    return json({ message: null });
  }
  return json({ decisions: [], offers });
}

function renderList(notifications: NotificationDTO[]) {
  const transport = createMockTransport({
    listNotifications: vi
      .fn()
      .mockResolvedValue({ notifications, nextCursor: null, unreadCount: 0 }),
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

beforeEach(() => {
  offers = [];
  posts = [];
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('extension decisions in Activity', () => {
  it('reads as the question answered, with who decided and when', async () => {
    const row = decided('person', { title: 'Ship the new banner?' });
    renderList([row]);
    expect(await screen.findByText('Ship the new banner?')).toBeInTheDocument();
    expect(screen.getByText(/Ship it · you at /)).toBeInTheDocument();
  });

  it('shows the one-time offer under the answered row; Yes sends it', async () => {
    const row = decided('person', { title: 'Ship the new banner?' });
    offers = [
      {
        decisionId: row.subject.id,
        text: 'Shipped. Next time, ship on its own?',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    renderList([row]);
    const user = userEvent.setup();
    await screen.findByText('Shipped. Next time, ship on its own?');
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() =>
      expect(posts).toEqual([
        { url: `/api/extension-decisions/${row.subject.id}/offer`, body: { accept: true } },
      ])
    );
  });

  it('folds three decisions made without the person into "While you were away", with a dot while one is unread', async () => {
    const rows = [
      decided('rule', { readAt: undefined }),
      decided('agent'),
      decided('deadline'),
      decided('person', { title: 'Yours' }),
    ];
    renderList(rows);
    const user = userEvent.setup();
    const away = await screen.findByText('While you were away · 3');
    const button = away.closest('button') as HTMLElement;
    expect(button).toHaveAttribute('data-unread', 'true');
    expect(screen.getByText('Yours')).toBeInTheDocument();
    expect(screen.queryByText('Decision 1')).not.toBeInTheDocument();
    await user.click(button);
    expect(
      within(button.parentElement as HTMLElement).getByText(rows[0].title)
    ).toBeInTheDocument();
  });

  it('opens a watched chat from the history row', async () => {
    const row = decided('person', {
      decision: {
        extensionId: 'flow',
        resolvedBy: 'person',
        resolvedByLabel: null,
        recorded: false,
        watch: { sessionId: 'ses-9', label: 'Sorting 12 ideas…' },
      },
    });
    renderList([row]);
    const user = userEvent.setup();
    await screen.findByText(/Sorting 12 ideas…/);
    await user.click(screen.getByRole('button', { name: 'Watch' }));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ session: 'ses-9' }) })
    );
  });
});
