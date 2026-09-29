/**
 * What extensions ask, in the Inbox's "Needs You" (spec `flow-multiproject`
 * §6.3, §7.5, §7.8): one short row with its reason and the extension's name,
 * answered in place; items under a project heading only when two or more
 * projects have something waiting; and a one-time follow-up offer that closing
 * the Inbox says no to.
 *
 * The decision routes are plain `fetch` calls, so this suite stubs `fetch`
 * with a small fake server and reads back what the bell sent.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import type {
  ExtensionDecisionDTO,
  PendingDecisionOffer,
} from '@dorkos/shared/extension-decision-schemas';
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

vi.mock('sonner', () => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() });
  return { toast };
});

import { toast } from 'sonner';
import { TransportProvider } from '@/layers/shared/model';
import { InboxBell } from '../ui/InboxBell';

const DORKOS = { root: '/repos/dorkos', name: 'dorkos' };
const BLINTZ = { root: '/repos/blintz', name: 'blintz' };

/** A yes-or-no decision in dorkos. */
function shipDecision(overrides: Partial<ExtensionDecisionDTO> = {}): ExtensionDecisionDTO {
  return {
    id: '01J0000000000000000000000D',
    extensionId: 'flow',
    extensionName: 'Flow',
    key: 'ship:DOR-2387',
    title: 'Ship the new out-of-usage banner?',
    why: "It's built, tests pass, and the reviewer agent found nothing.",
    detail: 'PR #2303, 4 files.',
    project: DORKOS,
    projectLabel: 'Linear DOR',
    since: null,
    actions: { kind: 'yes-no', approveLabel: 'Ship it', rejectLabel: 'Send it back' },
    link: '/x/flow/p/dorkos',
    raisedAt: '2026-09-29T09:00:00.000Z',
    needsYou: false,
    watch: null,
    revision: 0,
    ...overrides,
  };
}

/** A capability approval asked from inside a project. */
function approvalIn(project: typeof DORKOS | null): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000001',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    tier: 'destructive',
    summary: 'Uninstall "sentry-monitor"',
    requestedBy: '/Users/dev/agents/dorkbot',
    hasAgentPath: true,
    area: null,
    alwaysOffered: false,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    project,
  };
}

let decisions: ExtensionDecisionDTO[];
let offers: PendingDecisionOffer[];
let actionResponse: Record<string, unknown>;
let posts: Array<{ url: string; body: unknown }>;
let historyRows: NotificationDTO[];
let staleNext: boolean;

/** An answered decision's history row, as the Activity list holds it. */
function historyRow(decisionId: string, title: string): NotificationDTO {
  return {
    id: `N${decisionId}`,
    kind: 'extension.decision',
    tier: 'quiet',
    subject: { type: 'system', id: decisionId },
    title,
    body: 'Ship it · you',
    createdAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    outcome: 'approved',
    readAt: new Date().toISOString(),
    decision: {
      extensionId: 'flow',
      resolvedBy: 'person',
      resolvedByLabel: null,
      recorded: false,
      watch: null,
    },
  };
}

/** A fake of the routes the bell reaches. */
async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (init?.method === 'POST') {
    posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/extension-decisions/') && url.endsWith('/action')) {
      if (staleNext) {
        staleNext = false;
        return json(
          { error: 'This question changed. Take another look.', code: 'stale_decision' },
          409
        );
      }
      if (actionResponse.resolved) decisions = [];
      return json(actionResponse);
    }
    if (url.includes('/extension-decisions/') && url.endsWith('/offer')) {
      offers = [];
      return json({ message: null });
    }
  }
  if (url.endsWith('/extension-decisions')) return json({ decisions, offers });
  if (url.endsWith('/extensions/pending-approvals')) return json({ approvals: [] });
  return json({ error: 'not found' }, 404);
}

function renderBell(approvals: PendingApproval[] = []) {
  const transport = createMockTransport({
    listPendingApprovals: vi.fn().mockResolvedValue({ approvals }),
    listNotifications: vi.fn().mockImplementation(async () => ({
      notifications: historyRows,
      nextCursor: null,
      unreadCount: 0,
    })),
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

async function openBell() {
  const user = userEvent.setup();
  const bell = await screen.findByTestId('inbox-bell');
  await user.click(bell);
  return { user, bell };
}

function rowOf(title: string): HTMLElement {
  return screen.getByText(title).closest('[data-slot="inbox-decision-row"]') as HTMLElement;
}

beforeAll(() => {
  // Radix popovers measure; jsdom has no layout.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  decisions = [shipDecision()];
  offers = [];
  actionResponse = { resolved: true, message: null, navigate: null, offer: null, watch: null };
  posts = [];
  historyRows = [];
  staleNext = false;
  mockNavigate.mockReset();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('what extensions ask, in the bell', () => {
  it('counts a decision and draws its row with the reason and the extension’s name', async () => {
    renderBell();
    const bell = await screen.findByTestId('inbox-bell');
    expect(bell).toHaveAccessibleName('1 decision needs you. Open to answer it.');
    await openBell();
    const row = rowOf('Ship the new out-of-usage banner?');
    expect(within(row).getByText(/tests pass/)).toBeInTheDocument();
    expect(within(row).getByText('Flow')).toBeInTheDocument();
    const names = within(row)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'))
      .filter(Boolean);
    expect(names).toEqual(['More about this', 'Send it back', 'Ship it']);
  });

  it('hides the project heading when only one project has something waiting', async () => {
    renderBell([approvalIn(DORKOS)]);
    await openBell();
    await screen.findByText('Ship the new out-of-usage banner?');
    expect(document.querySelector('[data-slot="inbox-project-heading"]')).toBeNull();
  });

  it('groups under project headings, with the extension’s tracker label, when two projects have items', async () => {
    decisions = [shipDecision({ project: BLINTZ, projectLabel: 'Linear BLZ' })];
    renderBell([approvalIn(DORKOS)]);
    await openBell();
    await screen.findByText('Ship the new out-of-usage banner?');
    const headings = [...document.querySelectorAll('[data-slot="inbox-project-heading"]')].map(
      (h) => h.textContent
    );
    expect(headings).toEqual(['dorkos', 'blintzLinear BLZ']);
    const blintzRow = screen
      .getByText('Ship the new out-of-usage banner?')
      .closest('[data-slot="inbox-waiting-decision"]') as HTMLElement;
    expect(blintzRow).toHaveAttribute('data-project', 'blintz');
    // The heading comes before its project's row.
    const heading = screen.getByText('Linear BLZ').closest('h3') as HTMLElement;
    expect(
      heading.compareDocumentPosition(blintzRow) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('answers 👍 as the person and the row leaves', async () => {
    renderBell();
    const { user } = await openBell();
    await user.click(within(rowOf('Ship the new out-of-usage banner?')).getByLabelText('Ship it'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/api/extension-decisions/01J0000000000000000000000D/action',
      body: { action: 'approve', revision: 0 },
    });
    await waitFor(() =>
      expect(screen.queryByText('Ship the new out-of-usage banner?')).not.toBeInTheDocument()
    );
  });

  it('asks for a note on "Needs changes" and sends it, closing nothing by itself', async () => {
    decisions = [
      shipDecision({
        actions: {
          kind: 'yes-no',
          approveLabel: 'Looks good',
          rejectLabel: 'Needs changes',
          rejectAsksForNote: true,
        },
      }),
    ];
    actionResponse = {
      resolved: false,
      message: 'Sent back.',
      navigate: null,
      offer: null,
      watch: null,
    };
    renderBell();
    const { user } = await openBell();
    const row = rowOf('Ship the new out-of-usage banner?');
    await user.click(within(row).getByLabelText('Needs changes'));
    expect(posts).toEqual([]);
    await user.type(within(row).getByLabelText('What needs to change?'), 'Use the calmer red.');
    await user.click(within(row).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({ action: 'reject', note: 'Use the calmer red.', revision: 0 });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Sent back.'));
  });

  it('draws a question’s chips, the agent’s pick, and the deadline line, and sends a chip', async () => {
    decisions = [
      shipDecision({
        title: 'Should the old API keep working?',
        actions: {
          kind: 'choice',
          choices: [
            { id: 'keep', label: 'Keep it' },
            { id: 'remove', label: 'Remove it' },
          ],
          defaultChoice: 'keep',
          decideBy: new Date(Date.now() + 60 * 60_000).toISOString(),
          allowReply: true,
        },
      }),
    ];
    renderBell();
    const { user } = await openBell();
    const row = rowOf('Should the old API keep working?');
    expect(within(row).getByText(/agent’s pick/)).toBeInTheDocument();
    expect(
      within(row).getByText(/If you don’t answer by .*, the agent picks “Keep it”\./)
    ).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Reply…' })).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Remove it' }));
    await waitFor(() =>
      expect(posts[0]?.body).toEqual({ action: 'choice', choiceId: 'remove', revision: 0 })
    );
  });

  it('draws no deadline line for a question without one', async () => {
    decisions = [
      shipDecision({
        title: 'Which name?',
        actions: {
          kind: 'choice',
          choices: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          defaultChoice: 'a',
        },
      }),
    ];
    renderBell();
    await openBell();
    const row = rowOf('Which name?');
    expect(within(row).queryByText(/If you don’t answer/)).not.toBeInTheDocument();
  });

  it('says so when the agent could not go ahead at the deadline', async () => {
    decisions = [shipDecision({ needsYou: true })];
    renderBell();
    await openBell();
    expect(
      within(rowOf('Ship the new out-of-usage banner?')).getByText(
        'The agent couldn’t go ahead. It needs you.'
      )
    ).toBeInTheDocument();
  });

  it('follows a navigate the answer returned, closing the Inbox', async () => {
    actionResponse = {
      resolved: true,
      message: null,
      navigate: '/tasks',
      offer: null,
      watch: null,
    };
    renderBell();
    const { user } = await openBell();
    await user.click(within(rowOf('Ship the new out-of-usage banner?')).getByLabelText('Ship it'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ href: '/tasks' }));
  });

  it('shows an offer only on the client that answered, and closing the Inbox dismisses only what it drew', async () => {
    // The answer comes back with an offer; the listed offers stay empty.
    actionResponse = {
      resolved: true,
      message: null,
      navigate: null,
      offer: { text: 'Shipped. Next time, ship on its own?' },
      watch: null,
    };
    historyRows = [
      historyRow('01J0000000000000000000000D', 'Ship the new out-of-usage banner?'),
      historyRow('01J0000000000000000000000E', 'Another decision'),
    ];
    // Listed for a later credit, but its row is not in this Inbox's view.
    offers = [
      {
        decisionId: '01J00000000000000000000ZZZ',
        text: 'Listed elsewhere',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    ];
    renderBell();
    const { user } = await openBell();
    const waiting = await waitFor(
      () => document.querySelector('[data-slot="inbox-waiting"]') as HTMLElement
    );
    await user.click(await within(waiting).findByLabelText('Ship it'));
    expect(await screen.findByText('Shipped. Next time, ship on its own?')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(posts.filter((post) => post.url.endsWith('/offer'))).toEqual([
        {
          url: '/api/extension-decisions/01J0000000000000000000000D/offer',
          body: { accept: false },
        },
      ])
    );
  });

  it('says quietly that a question changed, and reads the list again', async () => {
    staleNext = true;
    renderBell();
    const { user } = await openBell();
    await user.click(within(rowOf('Ship the new out-of-usage banner?')).getByLabelText('Ship it'));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('This question changed. Take another look.')
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('sends back the revision the person saw', async () => {
    decisions = [shipDecision({ revision: 3 })];
    renderBell();
    const { user } = await openBell();
    await user.click(within(rowOf('Ship the new out-of-usage banner?')).getByLabelText('Ship it'));
    await waitFor(() => expect(posts[0]?.body).toEqual({ action: 'approve', revision: 3 }));
  });

  it('follows an extension page link the answer returned', async () => {
    actionResponse = {
      resolved: true,
      message: null,
      navigate: '/x/flow/p/dorkos',
      offer: null,
      watch: null,
    };
    renderBell();
    const { user } = await openBell();
    await user.click(within(rowOf('Ship the new out-of-usage banner?')).getByLabelText('Ship it'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ href: '/x/flow/p/dorkos' }));
  });
});
