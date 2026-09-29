/**
 * An installed extension waiting to be turned on asks in the Inbox's "Needs
 * You" with one short row, and answering there works (DOR-2517, spec
 * `flow-multiproject` §5.6 item 6).
 *
 * The extension routes are plain `fetch` calls (the extensions slice's
 * established pattern), so this suite stubs `fetch` with a tiny fake server
 * and reads back exactly what the bell sent.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import { createMockTransport } from '@dorkos/test-utils';

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: vi.fn(),
    useEventStream: () => ({ subscribe: vi.fn(), connectionState: 'connected', failedAttempts: 0 }),
    useSafeNavigate: () => mockNavigate,
    useIsMobile: () => false,
  };
});

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from 'sonner';
import { TransportProvider } from '@/layers/shared/model';
import { InboxBell } from '../ui/InboxBell';

const FLOW: PendingExtensionApproval = {
  id: 'flow',
  name: 'Flow',
  version: '1.2.0',
  path: '/home/me/.dork/plugins/flow/.dork/extensions/flow',
  plugin: 'flow',
  sourceLabel: 'flow plugin · dork-labs/marketplace',
  runsInServer: true,
  adds: 'It adds a Flow tab',
  since: '2026-09-28T12:00:00.000Z',
  why: 'You installed the flow plugin. This adds a Flow tab that shows what your agents are working on. It runs as you.',
};

/** What the fake server holds and what it was asked. */
let waiting: PendingExtensionApproval[];
let approveStatus: number;
let posts: Array<{ url: string; body: unknown }>;

/** A fake of the four extension routes the bell reaches. */
async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (init?.method === 'POST') {
    posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/extensions/flow/approve')) {
      if (approveStatus !== 200) return json({ error: 'Nope' }, approveStatus);
      waiting = [];
      return json({ extension: { id: 'flow' } });
    }
    if (url.endsWith('/extensions/flow/dismiss-approval')) {
      waiting = [];
      return new Response(null, { status: 204 });
    }
  }
  if (url.endsWith('/extensions/pending-approvals')) return json({ approvals: waiting });
  if (url.endsWith('/extensions')) return json([]);
  return json({ error: 'not found' }, 404);
}

/** Render the bell over a quiet mock transport. */
function renderBell() {
  const transport = createMockTransport({
    listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
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
  return render(<InboxBell />, { wrapper: Wrapper });
}

/** Open the bell and find the extension's row. */
async function openRow() {
  const user = userEvent.setup();
  const bell = await screen.findByTestId('inbox-bell');
  await user.click(bell);
  const title = await screen.findByText('Turn on Flow?');
  const row = title.closest('[data-slot="inbox-decision-row"]') as HTMLElement;
  return { user, bell, row };
}

describe('InboxBell — an extension waiting to be turned on', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  beforeEach(() => {
    waiting = [FLOW];
    approveStatus = 200;
    posts = [];
    vi.stubGlobal('fetch', vi.fn(fakeFetch));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('counts it in the pill, in its own words', async () => {
    renderBell();

    const bell = await screen.findByTestId('inbox-bell');
    expect(bell).toHaveAccessibleName('1 extension is waiting to be turned on. Open to answer it.');
    expect(bell).toHaveTextContent('1');
  });

  it('asks with one short row: the question, why, and where it came from', async () => {
    renderBell();
    const { row } = await openRow();

    expect(within(row).getByText(FLOW.why)).toBeInTheDocument();
    expect(within(row).getByText('flow plugin · dork-labs/marketplace')).toBeInTheDocument();
    expect(
      within(row)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['More about this', 'Not now', 'Turn it on']);
    expect(
      screen.getByText('1 extension is waiting to be turned on. None of it runs until you decide.')
    ).toBeInTheDocument();
  });

  it('opens ⓘ in place with the consent sentence and the way to Settings', async () => {
    renderBell();
    const { user, row } = await openRow();

    await user.click(within(row).getByRole('button', { name: 'More about this' }));

    expect(within(row).getByRole('button', { name: 'More about this' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(within(row).getByText(/None of it has run yet/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'See it in Settings → Extensions' }));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/', search: { settings: 'extensions' } });
  });

  it('turns it on from 👍, and the row leaves', async () => {
    renderBell();
    const { user, row } = await openRow();

    await user.click(within(row).getByRole('button', { name: 'Turn it on' }));

    await waitFor(() => expect(screen.queryByText('Turn on Flow?')).not.toBeInTheDocument());
    // The exact copy the row showed, so the server can refuse any other.
    expect(posts).toEqual([
      {
        url: '/api/extensions/flow/approve',
        body: { path: FLOW.path, version: '1.2.0', plugin: 'flow' },
      },
    ]);
  });

  it('says "Not now" from 👎 for the copy it showed, and the row leaves', async () => {
    renderBell();
    const { user, row } = await openRow();

    await user.click(within(row).getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(screen.queryByText('Turn on Flow?')).not.toBeInTheDocument());
    expect(posts).toEqual([
      {
        url: '/api/extensions/flow/dismiss-approval',
        body: { path: FLOW.path, version: '1.2.0', plugin: 'flow' },
      },
    ]);
  });

  it('puts the row back and says so in plain words when turning it on fails', async () => {
    approveStatus = 500;
    renderBell();
    const { user, row } = await openRow();

    await user.click(within(row).getByRole('button', { name: 'Turn it on' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Couldn’t turn on Flow. Try again.', {
        description: 'Nope',
      })
    );
    expect(await screen.findByText('Turn on Flow?')).toBeInTheDocument();
  });
});
