/**
 * What an answered extension approval leaves in the Activity list (DOR-2517,
 * spec `flow-multiproject` §5.5 "After an answer"): the same row, answered,
 * and a "Turn it on" that still works after a "Not now".
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { extensionApprovalSubjectId } from '@dorkos/shared/extension-approval-schemas';

/** Where the answered copy lived. */
const FLOW_PATH = '/home/me/.dork/plugins/flow/.dork/extensions/flow';

const navigate = vi.fn();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn(), useSafeNavigate: () => navigate };
});

import { TransportProvider } from '@/layers/shared/model';
import { InboxList } from '../ui/InboxList';

/** An answered `extension.approval` row, as the server stores it. */
function answered(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: '01JZG0000000000000000009',
    kind: 'extension.approval',
    tier: 'notable',
    subject: {
      type: 'system',
      id: extensionApprovalSubjectId({
        id: 'flow',
        path: FLOW_PATH,
        plugin: 'flow',
        version: '1.2.0',
      }),
    },
    title: 'You turned on Flow',
    body: 'Flow tab added',
    createdAt: new Date().toISOString(),
    readAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    outcome: 'approved',
    ...overrides,
  };
}

/** The same row after a "Not now". */
function dismissed(): NotificationDTO {
  return answered({ title: 'Flow is off for now', body: undefined, outcome: 'dismissed' });
}

/** Flow as the extensions list reports it, still waiting to be turned on. */
function flowRecord(overrides: Partial<ExtensionRecordPublic> = {}): ExtensionRecordPublic {
  return {
    id: 'flow',
    manifest: { id: 'flow', name: 'Flow', version: '1.2.0' },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    sourcePlugin: 'flow',
    bundleReady: true,
    hasServerEntry: true,
    hasDataProxy: false,
    approvedToRun: false,
    shadowedBy: null,
    ...overrides,
  };
}

let extensions: ExtensionRecordPublic[];
let posts: Array<{ url: string; body: unknown }>;

/** A fake of the two extension routes the row reaches. */
async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (init?.method === 'POST') {
    posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ extension: { id: 'flow' } }), { status: 200 });
  }
  if (url.endsWith('/extensions')) return new Response(JSON.stringify(extensions));
  if (url.endsWith('/extensions/pending-approvals')) {
    return new Response(JSON.stringify({ approvals: [] }));
  }
  return new Response('{}', { status: 404 });
}

/** Render the list over one stored row. */
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

describe('an answered extension approval in the Activity list', () => {
  beforeEach(() => {
    extensions = [flowRecord()];
    posts = [];
    vi.stubGlobal('fetch', vi.fn(fakeFetch));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('reads "You turned on Flow · <time> · Flow tab added"', async () => {
    renderList(answered());

    const title = await screen.findByText('You turned on Flow');
    const row = title.closest('[data-slot="inbox-decision-row"]');
    expect(row).toHaveAttribute('data-history', 'true');
    expect(row?.textContent).toMatch(/^You turned on Flow · \S.* · Flow tab added$/);
  });

  it('reads "Flow is off for now · <time> · Turn it on"', async () => {
    renderList(dismissed());

    const title = await screen.findByText('Flow is off for now');
    const row = title.closest('[data-slot="inbox-decision-row"]');
    expect(row?.textContent).toMatch(/^Flow is off for now · \S.* · Turn it on$/);
  });

  it('turns Flow on in place while it is still off at the version the person was asked about', async () => {
    const user = userEvent.setup();
    renderList(dismissed());
    await screen.findByText('Flow is off for now');
    // Wait for the extensions list to land before deciding what the link does.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Turn it on' })).toHaveAttribute(
        'data-in-place',
        'true'
      )
    );

    await user.click(screen.getByRole('button', { name: 'Turn it on' }));

    // It names the exact copy the row was about, so a copy that took its
    // place (another plugin, a project folder reusing the id) is refused.
    await waitFor(() =>
      expect(posts).toEqual([
        {
          url: '/api/extensions/flow/approve',
          body: { path: FLOW_PATH, version: '1.2.0', plugin: 'flow' },
        },
      ])
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens Settings → Extensions instead once that version is gone', async () => {
    extensions = [flowRecord({ manifest: { id: 'flow', name: 'Flow', version: '1.3.0' } })];
    const user = userEvent.setup();
    renderList(dismissed());
    await screen.findByText('Flow is off for now');
    // The list has landed (it asked for it and got a newer version back).
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/extensions'))).toBe(
        true
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole('button', { name: 'Turn it on' })).toHaveAttribute(
      'data-in-place',
      'false'
    );

    await user.click(screen.getByRole('button', { name: 'Turn it on' }));

    expect(posts).toEqual([]);
    expect(navigate).toHaveBeenCalledWith({ to: '/', search: { settings: 'extensions' } });
  });
});
