/**
 * The header approvals marker: it appears the moment an agent asks, from any
 * route; it retires when the request is decided or its window closes; it reads a
 * count for a queue; and it can be reached and opened from the keyboard alone.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectionState } from '@dorkos/shared/types';
import type { PendingApproval, StandingPermission } from '@dorkos/shared/approval-schemas';
import { createMockTransport } from '@dorkos/test-utils';

/** Global stream state the widget reads; mutable so a test can drop the link. */
let mockConnectionState: ConnectionState = 'connected';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: vi.fn(),
    useEventStream: () => ({
      subscribe: vi.fn(),
      connectionState: mockConnectionState,
      failedAttempts: 0,
    }),
  };
});

import { TransportProvider, useEventSubscription } from '@/layers/shared/model';
import { usePendingApprovals } from '@/layers/entities/attention';
import { useStandingPermissions } from '@/layers/features/approvals';
import { useConfig } from '@/layers/entities/config';
import { ApprovalsIndicator } from '../ui/ApprovalsIndicator';

/**
 * Renders the state the marker is derived from, so a test can wait for the reads
 * to have LANDED before asserting the marker is absent.
 *
 * `waitFor` resolves on its first synchronous check, so an absence assertion
 * inside one fires before any query settles — when the marker would be missing
 * whatever the component does. Two such cases were green here against a
 * deliberately broken build. This is the same probe pattern the card tests use,
 * and the reason is the same: proving a negative needs a positive first.
 */
function SettledProbe() {
  const { data: config } = useConfig();
  const { isLoading } = usePendingApprovals();
  const { permissions } = useStandingPermissions();
  return (
    <span data-testid="settled">
      {`${config ? 'cfg' : 'nocfg'}:${isLoading ? 'loading' : 'loaded'}:${permissions.length}`}
    </span>
  );
}

/** Build a pending approval, overriding only what a test cares about. */
function buildApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000001',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    tier: 'destructive',
    summary: 'Uninstall "sentry-monitor"',
    requestedBy: '/Users/dev/agents/dorkbot',
    hasAgentPath: true,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    ...overrides,
  };
}

/** Build a live standing permission. */
function buildPermission(overrides: Partial<StandingPermission> = {}): StandingPermission {
  return {
    grantId: '01JZ00000000000000000000G1',
    agentPath: '/Users/dev/agents/dorkbot',
    agentLabel: 'dorkbot',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    expiresAt: new Date(Date.now() + 120 * 60_000).toISOString(),
    ...overrides,
  };
}

/**
 * A config with both standing-permission settings on.
 *
 * The list is only read when they are, so a test about live permissions that
 * forgot this would assert against an empty list and pass for the wrong reason.
 */
function configWithStandingGrants() {
  return vi.fn().mockResolvedValue({
    version: '1.0.0',
    port: 4242,
    uptime: 0,
    workingDirectory: '/test',
    nodeVersion: 'v20.0.0',
    platform: 'linux-x64',
    runtimes: ['claude-code'],
    claudeCliPath: null,
    tunnel: {
      enabled: false,
      connected: false,
      url: null,
      authEnabled: false,
      tokenConfigured: false,
    },
    tasks: { enabled: true },
    auth: { enabled: true },
    approvals: { standingGrants: true, trustWindowMinutes: 480 },
  });
}

/** Render the marker over a mock transport. */
function renderIndicator(overrides: Partial<Transport> = {}) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return {
    transport,
    ...render(
      <>
        <SettledProbe />
        <ApprovalsIndicator />
      </>,
      { wrapper: Wrapper }
    ),
  };
}

describe('ApprovalsIndicator', () => {
  /** Handlers the hook registered, keyed by event name. */
  let handlers: Map<string, (raw: unknown) => void>;

  beforeAll(() => {
    // ResponsivePopover asks matchMedia which shape to take; jsdom has none.
    // `matches: false` puts it on the desktop (popover) branch.
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
    handlers = new Map();
    mockConnectionState = 'connected';
    vi.mocked(useEventSubscription).mockImplementation((event, handler) => {
      handlers.set(event, handler as (raw: unknown) => void);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows no visible marker while nothing is waiting', async () => {
    renderIndicator({ listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }) });

    // Wait for both reads to land FIRST. `waitFor` around the absence alone
    // resolves on its first synchronous check, before either query settles, so it
    // would pass against a component that always renders the marker.
    await screen.findByText('cfg:loaded:0');
    expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument();
  });

  it('appears the moment approval_pending arrives', async () => {
    renderIndicator({ listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }) });
    await waitFor(() =>
      expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument()
    );

    act(() => handlers.get('approval_pending')?.(buildApproval()));

    const marker = await screen.findByTestId('approvals-indicator');
    expect(marker).toHaveAccessibleName('1 request needs your approval. Open to answer it.');
  });

  it('keeps its live region mounted while quiet, so the arrival is announced', async () => {
    // A live region inserted at the same moment as its text is not reliably read
    // out. The region has to already exist when the count lands.
    renderIndicator({ listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }) });

    const announcer = await waitFor(() => screen.getByRole('status'));
    expect(announcer).toBeEmptyDOMElement();

    act(() => handlers.get('approval_pending')?.(buildApproval()));

    await waitFor(() =>
      expect(announcer).toHaveTextContent('1 request needs your approval. Open to answer it.')
    );
  });

  it('reads a count when several agents are waiting at once', async () => {
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({
        approvals: [
          buildApproval(),
          buildApproval({ approvalId: '01JZ0000000000000000000002' }),
          buildApproval({ approvalId: '01JZ0000000000000000000003' }),
        ],
      }),
    });

    const marker = await screen.findByTestId('approvals-indicator');
    expect(marker).toHaveAccessibleName('3 requests need your approval. Open to answer them.');
    expect(marker).toHaveTextContent('3');
  });

  it('retires when the request is decided elsewhere', async () => {
    const listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [buildApproval()] });
    renderIndicator({ listPendingApprovals });
    await screen.findByTestId('approvals-indicator');

    // Somebody answered — in this window, another tab, or from the CLI.
    listPendingApprovals.mockResolvedValue({ approvals: [] });
    act(() => handlers.get('approval_resolved')?.({ approvalId: '01JZ0000000000000000000001' }));

    await waitFor(() =>
      expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument()
    );
  });

  it('never shows a request whose window has already closed', async () => {
    // The server excludes these from `listPending`, but a card already on screen
    // when the window closes has to go too — nothing announces an expiry.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({
        approvals: [buildApproval({ expiresAt: new Date(Date.now() - 1000).toISOString() })],
      }),
    });

    await waitFor(() =>
      expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument()
    );
  });

  it('retires the marker when the window closes while you are looking at it', async () => {
    vi.useFakeTimers();
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({
        approvals: [buildApproval({ expiresAt: new Date(Date.now() + 60_000).toISOString() })],
      }),
    });

    // Let the first read land, then confirm the marker is up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('approvals-indicator')).toBeInTheDocument();

    // Sit past the deadline with nobody deciding and no agent retrying: the
    // server emits no event here, so the marker has to time itself out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument();
  });

  it('is reachable from the keyboard and opens the cards in place', async () => {
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
    });
    const marker = await screen.findByTestId('approvals-indicator');

    await userEvent.tab();
    expect(marker).toHaveFocus();

    await userEvent.keyboard('{Enter}');

    // The decision itself is here, not a route away.
    expect(await screen.findByText('Uninstall a marketplace package')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Don't allow" })).toBeInTheDocument();
  });

  it('says so when the list cannot be read, rather than looking like silence', async () => {
    renderIndicator({ listPendingApprovals: vi.fn().mockRejectedValue(new Error('offline')) });

    const marker = await screen.findByTestId('approvals-indicator');
    expect(marker).toHaveAccessibleName('DorkOS could not check for approvals. Open for details.');

    await userEvent.click(marker);
    expect(
      await screen.findByText(/could not check whether anything is waiting/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('stays quiet about a failed read while the link is already known to be down', async () => {
    // A server restart fails the read too. Painting an amber alarm next to the
    // connection item's existing signal would double-report one outage and dilute
    // what this marker means, which is only ever "an agent is blocked".
    mockConnectionState = 'reconnecting';
    renderIndicator({ listPendingApprovals: vi.fn().mockRejectedValue(new Error('offline')) });

    await waitFor(() =>
      expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument()
    );
  });

  it('shows a quiet marker, not the amber one, when only standing permissions are live', async () => {
    // Nobody is blocked and nothing needs answering. The amber pill means exactly
    // one thing — an agent is waiting on you — and spending it on news that is not
    // urgent is how a marker stops being read.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      getConfig: configWithStandingGrants(),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [buildPermission()] }),
    });

    const marker = await screen.findByTestId('approvals-indicator');
    expect(marker).toHaveAccessibleName('1 standing permission is live. Open to see it or end it.');
    expect(marker.className).not.toContain('bg-status-warning-bg');
    // The check-mark shield belongs to this state and only this one: live trust
    // that was actually verified, not a read that failed.
    expect(marker.querySelector('.lucide-shield-check')).toBeInTheDocument();
    expect(marker.querySelector('.lucide-shield-alert')).not.toBeInTheDocument();
  });

  it('opens onto the permissions, with the button that ends one', async () => {
    // A permission a person cannot find is a dark pattern, and this is the surface
    // they are most likely looking at when they wonder why nothing asked them.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      getConfig: configWithStandingGrants(),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [buildPermission()] }),
    });

    await userEvent.click(await screen.findByTestId('approvals-indicator'));

    expect(await screen.findByText('Uninstall a marketplace package')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Stop trusting dorkbot/ })).toBeInTheDocument();
  });

  it('reports the pending queue when both are true, and puts the permissions under the cards', async () => {
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      getConfig: configWithStandingGrants(),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [buildPermission()] }),
    });

    const marker = await screen.findByTestId('approvals-indicator');
    expect(marker).toHaveAccessibleName('1 request needs your approval. Open to answer it.');

    await userEvent.click(marker);
    await screen.findByRole('button', { name: 'Allow' });
    const card = document.querySelector('[data-slot="approval-card"]');
    const permission = document.querySelector('[data-slot="standing-permission"]');
    expect(card).not.toBeNull();
    expect(permission).not.toBeNull();
    // Something waiting on a person outranks something already decided.
    expect(
      (card as Node).compareDocumentPosition(permission as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('stays silent about permissions the settings do not allow to exist', async () => {
    // Standing permissions off means there is nothing to find, and the server
    // would refuse the read anyway. A marker here would be pure noise.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [buildPermission()] }),
    });

    // The probe proves the config landed and the permission list resolved to
    // nothing, which is what makes the marker's absence mean something.
    await screen.findByText('cfg:loaded:0');
    expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument();
  });

  it('says so when the permission list cannot be read, rather than looking untrusted', async () => {
    // An empty list here reads as "nothing is trusted", which is the most
    // reassuring thing this surface can say. A failed read must not borrow it: the
    // gate may still be auto-approving under a permission nobody can now see.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      getConfig: configWithStandingGrants(),
      listStandingPermissions: vi.fn().mockRejectedValue(new Error('offline')),
    });

    const marker = await screen.findByTestId('approvals-indicator');
    expect(marker).toHaveAccessibleName(
      'DorkOS could not check which standing permissions are live. Open for details.'
    );
    // Not the check-mark shield: that icon says "verified", the opposite of what
    // a failed read means. A person reads this pill by silhouette far more often
    // than by the accessible name a screen reader gets.
    expect(marker.querySelector('.lucide-shield-alert')).toBeInTheDocument();
    expect(marker.querySelector('.lucide-shield-check')).not.toBeInTheDocument();

    await userEvent.click(marker);
    // Scoped to the panel: the live region announcing the same fact is not the
    // thing being asserted here.
    const panel = await screen.findByTestId('standing-permissions-error');
    expect(panel).toHaveTextContent(/could not check which standing permissions are live/i);
    expect(within(panel).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('still shows requests it already knows about when the link drops', async () => {
    // Suppression covers the unknown-state pill only. Cards already read are real
    // and still have to be answerable.
    mockConnectionState = 'disconnected';
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
    });

    expect(await screen.findByTestId('approvals-indicator')).toBeInTheDocument();
  });

  it('names an agent’s prompt as a question, never as an approval request', async () => {
    // Two different objects are counted by one pill, and a question is not a
    // permission request. Seeded defect: restore the old single sentence and
    // this reads "1 request needs your approval" over a question.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      listPendingInteractions: vi.fn().mockResolvedValue({
        interactions: [
          {
            sessionId: 'session-1',
            cwd: '/projects/meeting-notes',
            interaction: {
              type: 'question',
              id: 'q-1',
              startedAt: Date.now(),
              remainingMs: 600_000,
              timeoutMs: 600_000,
              questions: [],
            },
          },
        ],
      }),
    });

    const marker = await screen.findByTestId('approvals-indicator');
    expect(marker).toHaveAccessibleName(/1 agent is waiting on your answer/i);
    expect(marker).not.toHaveAccessibleName(/approval/i);
  });

  it('counts a waiting prompt beside the approvals, and calls the agent by name', async () => {
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      listPendingInteractions: vi.fn().mockResolvedValue({
        interactions: [
          {
            sessionId: 'session-1',
            cwd: '/projects/meeting-notes',
            interaction: {
              type: 'approval',
              id: 'tc-1',
              startedAt: Date.now(),
              remainingMs: 600_000,
              timeoutMs: 600_000,
              toolName: 'Write',
              displayName: 'Write',
              description: '/projects/meeting-notes/standup.md',
              input: JSON.stringify({ file_path: '/projects/meeting-notes/standup.md' }),
              hasSuggestions: false,
            },
          },
        ],
      }),
    });

    const marker = await screen.findByTestId('approvals-indicator');
    expect(marker).toHaveTextContent('1');
    await userEvent.click(marker);

    // The file is named, which is the whole point of the card — and the agent is
    // named from its directory when the roster holds nothing better.
    expect(await screen.findByText(/wants to write standup\.md/i)).toBeInTheDocument();
    expect(screen.getByText('/projects/meeting-notes/standup.md')).toBeInTheDocument();
    // The tray is never the session, so it owes a way into it.
    expect(screen.getByRole('button', { name: 'Open session' })).toBeInTheDocument();
  });
});
