/**
 * The standing-permission surfaces: the third button on the card, the list a
 * person ends one from, and the Settings block that owns the two settings
 * (spec `agent-approval-settings` §3.7).
 *
 * Every case here is about a promise the spec makes to a person rather than about
 * a component's internals: the button never appears where pressing it would be
 * refused, its label says how long the permission lasts, live trust is findable,
 * and switching the feature off says out loud that it ends what is already open.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { PendingApproval, StandingPermission } from '@dorkos/shared/approval-schemas';
import { createMockTransport } from '@dorkos/test-utils';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn() };
});

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

import { toast } from 'sonner';
import { TransportProvider, useEventSubscription } from '@/layers/shared/model';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { discardSettlingApprovals } from '../model/settling-approvals';
import { ApprovalList } from '../ui/ApprovalList';
import { usePendingApprovals } from '@/layers/entities/attention';
import { StandingPermissionsSettings } from '../ui/StandingPermissionsSettings';
import { useStandingGrantPolicy } from '../model/use-standing-grant-policy';

/**
 * The live approval queue, drawn the way both real surfaces draw it: the hook
 * for the cards, `ApprovalList` for the DOM. The home tab's pinned triage
 * header and the app header's panel each compose exactly this pair, so a card
 * rendered here is the card a person answers (`widgets/home`,
 * `widgets/inbox-bell`).
 */
function LiveApprovals() {
  const { approvals } = usePendingApprovals();
  return <ApprovalList approvals={approvals} />;
}

/**
 * Renders the resolved policy, so a test can wait for the config to have ARRIVED
 * before asserting that a button is absent.
 *
 * Without this, every "the button is not offered" case below passes at the first
 * paint — before the config query resolves, when the button would not be there
 * under any settings — and keeps passing no matter what the component does. That
 * is not a hypothetical: seeding the exact defect these cases exist to catch left
 * them all green, which is how the probe got written.
 */
function PolicyProbe() {
  const { canGrant, windowMinutes } = useStandingGrantPolicy();
  return <span data-testid="policy">{`${canGrant ? 'can' : 'cannot'}:${windowMinutes}`}</span>;
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

/** The config the two settings are read from, with both switched on by default. */
function configWith(
  overrides: {
    loginEnabled?: boolean;
    standingGrants?: boolean;
    trustWindowMinutes?: number;
  } = {}
) {
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
    auth: { enabled: overrides.loginEnabled ?? true },
    approvals: {
      standingGrants: overrides.standingGrants ?? true,
      trustWindowMinutes: overrides.trustWindowMinutes ?? 480,
    },
  });
}

/** Render any tree over a mock transport. */
function renderWith(ui: ReactNode, overrides: Partial<Transport> = {}) {
  const transport = createMockTransport(overrides);
  // Built from the app's real config, not re-declared, so the app-wide generic
  // error toast (MutationCache.onError in query-client.ts) is actually wired up
  // in the test. A test that hand-rolls its own QueryClient here cannot prove
  // "this surface never shows the generic toast" — there is no generic handler
  // present to have been suppressed.
  const config = createQueryClientConfig();
  const queryClient = new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { ...config.defaultOptions?.queries, retry: false, gcTime: 0 },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return { transport, ...render(<>{ui}</>, { wrapper: Wrapper }) };
}

beforeAll(() => {
  // Radix Select and AlertDialog both reach for APIs jsdom does not implement.
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
  vi.mocked(useEventSubscription).mockImplementation(() => {});
});

/**
 * Total toasts fired across every tone. Standing-decision failures must land as
 * exactly one toast: the specific one from `useGrantApproval`/`useDenyApproval`'s
 * own `onError`. A second, generic "Action failed" toast from the app-wide
 * MutationCache handler means `meta.suppressErrorToast` regressed.
 */
function toastCallCount() {
  return (
    vi.mocked(toast.error).mock.calls.length +
    vi.mocked(toast.warning).mock.calls.length +
    vi.mocked(toast.success).mock.calls.length +
    vi.mocked(toast.message).mock.calls.length
  );
}

afterEach(() => {
  cleanup();
  // Answering a card records the answer in a module-level ledger that outlives
  // `cleanup()` on purpose (a card must be able to outlive its own hold), so
  // without this the next case renders the same approval id and gets a receipt
  // where it expected buttons.
  discardSettlingApprovals();
  vi.clearAllMocks();
});

describe('the third button on an approval card', () => {
  /** The standing button, found by the part of its label that never varies. */
  const standingButton = () => screen.queryByRole('button', { name: /stop asking about this/i });

  it('names the whole scope on the button, with the window from the setting', async () => {
    renderWith(
      <>
        <PolicyProbe />
        <LiveApprovals />
      </>,
      {
        listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
        getConfig: configWith({ trustWindowMinutes: 480 }),
      }
    );

    expect(
      await screen.findByRole('button', {
        name: 'Allow, and stop asking about this for 8 hours',
      })
    ).toBeInTheDocument();
  });

  it('reads the window from the setting rather than a constant', async () => {
    // The same card with a different setting has to say something different, or
    // the number on the button is decoration.
    renderWith(
      <>
        <PolicyProbe />
        <LiveApprovals />
      </>,
      {
        listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
        getConfig: configWith({ trustWindowMinutes: 30 }),
      }
    );

    expect(
      await screen.findByRole('button', {
        name: 'Allow, and stop asking about this for 30 minutes',
      })
    ).toBeInTheDocument();
  });

  it('names the exact agent and action under the button', async () => {
    renderWith(
      <>
        <PolicyProbe />
        <LiveApprovals />
      </>,
      {
        listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
        getConfig: configWith(),
      }
    );

    expect(
      await screen.findByText(/Covers dorkbot doing .Uninstall a marketplace package., and nothing/)
    ).toBeInTheDocument();
  });

  it('is not offered when standing permissions are switched off', async () => {
    renderWith(
      <>
        <PolicyProbe />
        <LiveApprovals />
      </>,
      {
        listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
        getConfig: configWith({ standingGrants: false }),
      }
    );

    // BOTH waits are load-bearing, and each covers a different way this case can
    // pass for the wrong reason: the card has to be on screen (or there is no
    // button to look for), and the config has to have landed (or nothing has read
    // the settings yet). Seeding the defect with only one of them left the case
    // green.
    await screen.findByRole('button', { name: 'Allow' });
    await screen.findByText('cannot:480');
    expect(standingButton()).not.toBeInTheDocument();
  });

  it('is not offered when Require login is off', async () => {
    // Creating one needs a session cookie, and with login off there is no cookie
    // for anybody. A button the server would refuse is worse than no button.
    renderWith(
      <>
        <PolicyProbe />
        <LiveApprovals />
      </>,
      {
        listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
        getConfig: configWith({ loginEnabled: false }),
      }
    );

    // BOTH waits are load-bearing, and each covers a different way this case can
    // pass for the wrong reason: the card has to be on screen (or there is no
    // button to look for), and the config has to have landed (or nothing has read
    // the settings yet). Seeding the defect with only one of them left the case
    // green.
    await screen.findByRole('button', { name: 'Allow' });
    await screen.findByText('cannot:480');
    expect(standingButton()).not.toBeInTheDocument();
  });

  it('is not offered on a request DorkOS cannot attribute to an agent', async () => {
    // Permissions key on the agent path. `requestedBy` is a display label the
    // marketplace flow sets even when there is no path, so drawing the button
    // from it would put it on exactly the cards where pressing it is refused.
    renderWith(
      <>
        <PolicyProbe />
        <LiveApprovals />
      </>,
      {
        listPendingApprovals: vi.fn().mockResolvedValue({
          approvals: [buildApproval({ hasAgentPath: false, requestedBy: 'the marketplace' })],
        }),
        getConfig: configWith(),
      }
    );

    // The settings ALLOW a permission here — the probe proves the config landed —
    // so the button's absence can only be the missing agent path.
    await screen.findByRole('button', { name: 'Allow' });
    await screen.findByText('can:480');
    expect(standingButton()).not.toBeInTheDocument();
  });

  it('asks for the permission and the one-time yes together', async () => {
    const grantApproval = vi
      .fn()
      .mockResolvedValue({ ok: true, approvalId: 'x', outcome: 'granted' });
    renderWith(
      <>
        <PolicyProbe />
        <LiveApprovals />
      </>,
      {
        listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
        getConfig: configWith(),
        grantApproval,
      }
    );

    await userEvent.click(await screen.findByRole('button', { name: /stop asking about this/i }));

    expect(grantApproval).toHaveBeenCalledWith('01JZ0000000000000000000001', { standing: true });
  });

  it('says the action ran when only the permission failed to record', async () => {
    // The 500 that is not a failure. The server says so in plain words; the app-wide
    // handler would replace all of it with "Action failed. Please try again." about
    // an irreversible action that succeeded, which invites doing it twice.
    const failure = new Error(
      'DorkOS allowed this one action, but could not record the permission to stop asking. The agent will ask again next time.'
    ) as Error & { code?: string };
    failure.code = 'STANDING_PERMISSION_NOT_RECORDED';

    renderWith(
      <>
        <PolicyProbe />
        <LiveApprovals />
      </>,
      {
        listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
        getConfig: configWith(),
        grantApproval: vi.fn().mockRejectedValue(failure),
      }
    );

    await userEvent.click(await screen.findByRole('button', { name: /stop asking about this/i }));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toContain('allowed this one action');
    // Not the generic toast, and not an error tone.
    expect(toast.error).not.toHaveBeenCalled();
    // And not a second toast of any tone: the app-wide "Action failed" handler
    // must actually have been suppressed, not merely absent from this client.
    expect(toastCallCount()).toBe(1);
  });

  it("shows the server's own reason when the permission is refused", async () => {
    const failure = new Error(
      'Standing permissions are switched off. Turn them on in Settings, under Security, first.'
    ) as Error & { code?: string };
    failure.code = 'STANDING_GRANTS_DISABLED';

    renderWith(
      <>
        <PolicyProbe />
        <LiveApprovals />
      </>,
      {
        listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
        getConfig: configWith(),
        grantApproval: vi.fn().mockRejectedValue(failure),
      }
    );

    await userEvent.click(await screen.findByRole('button', { name: /stop asking about this/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(
      'Standing permissions are switched off. Turn them on in Settings, under Security, first.'
    );
    // Exactly one toast: the specific refusal, not that plus a generic "Action
    // failed" from the app-wide handler.
    expect(toastCallCount()).toBe(1);
  });

  it('keeps "Don\'t allow" first, and the standing answer last', async () => {
    // Neither answer may be dressed up as the safe one, and the permanent answer
    // must not sit where the eye lands first.
    renderWith(
      <>
        <PolicyProbe />
        <LiveApprovals />
      </>,
      {
        listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
        getConfig: configWith(),
      }
    );
    await screen.findByRole('button', { name: /stop asking about this/i });

    const card = document.querySelector('[data-slot="approval-card"]');
    const order = [...(card?.querySelectorAll('button') ?? [])].map((b) => b.textContent ?? '');
    expect(order[0]).toContain('Don');
    expect(order[1]).toBe('Allow');
    expect(order[2]).toContain('stop asking about this');
  });
});

describe('standing permissions in Settings, under Security', () => {
  it('is visible and disabled with a plain reason when Require login is off', async () => {
    // Visible, not hidden: somebody looking for the feature has to find out WHY
    // it is unavailable, and the fix is the toggle directly above it.
    renderWith(<StandingPermissionsSettings />, {
      getConfig: configWith({ loginEnabled: false, standingGrants: false }),
    });

    const toggle = await screen.findByRole('switch', { name: 'Standing permissions' });
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(screen.getByText(/Turn on Require login above to use this/i)).toBeInTheDocument();
  });

  it('does not blame Require login before it knows whether login is on', async () => {
    // The config has not answered yet. Reading `loginEnabled` as false is the right
    // default for the SWITCH (never offer what might be refused) and the wrong one
    // for the DESCRIPTION, which would state a reason and then flip.
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    renderWith(<StandingPermissionsSettings />, {
      getConfig: vi.fn().mockReturnValue(pending),
    });

    const toggle = await screen.findByRole('switch', { name: 'Standing permissions' });
    expect(toggle).toBeDisabled();
    expect(screen.queryByText(/Turn on Require login above to use this/i)).not.toBeInTheDocument();

    // …and it says it once it actually knows.
    release({ auth: { enabled: false }, approvals: { standingGrants: false } });
    expect(await screen.findByText(/Turn on Require login above to use this/i)).toBeInTheDocument();
  });

  it('is usable once Require login is on', async () => {
    renderWith(<StandingPermissionsSettings />, {
      getConfig: configWith({ loginEnabled: true, standingGrants: false }),
    });

    const toggle = await screen.findByRole('switch', { name: 'Standing permissions' });
    await waitFor(() => expect(toggle).toBeEnabled());
  });

  it('lists what is live, with the agent, the action, and the time left', async () => {
    renderWith(<StandingPermissionsSettings />, {
      getConfig: configWith(),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [buildPermission()] }),
    });

    const row = await screen.findByText('Uninstall a marketplace package');
    const permission = row.closest('[data-slot="standing-permission"]');
    expect(permission).not.toBeNull();
    expect(within(permission as HTMLElement).getByText('dorkbot')).toBeInTheDocument();
    // A countdown, not a timestamp: "how much longer" is the question a person
    // ending a permission is actually asking.
    expect(within(permission as HTMLElement).getByText(/hr.*left$/)).toBeInTheDocument();
  });

  it('ends one through the transport when Stop trusting is clicked', async () => {
    const revokeStandingPermission = vi
      .fn()
      .mockResolvedValue({ ok: true, grantId: '01JZ00000000000000000000G1' });
    renderWith(<StandingPermissionsSettings />, {
      getConfig: configWith(),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [buildPermission()] }),
      revokeStandingPermission,
    });

    await userEvent.click(await screen.findByRole('button', { name: /^Stop trusting dorkbot/ }));

    expect(revokeStandingPermission).toHaveBeenCalledWith('01JZ00000000000000000000G1');
  });

  it('tells two agents with the same folder name apart', async () => {
    // `--path` is required when an agent is created and nothing uniques its NAME,
    // so two "helper" agents are allowed. A list that cannot tell them apart is
    // not a list a person can act on.
    renderWith(<StandingPermissionsSettings />, {
      getConfig: configWith(),
      listStandingPermissions: vi.fn().mockResolvedValue({
        grants: [
          buildPermission({
            grantId: 'g1',
            agentPath: '/Users/dev/work/acme/helper',
            agentLabel: 'helper',
          }),
          buildPermission({
            grantId: 'g2',
            agentPath: '/Users/dev/work/beta/helper',
            agentLabel: 'helper',
            capabilityId: 'tasks_delete',
            capabilityTitle: 'Delete a scheduled task',
          }),
        ],
      }),
    });

    expect(await screen.findByText('~/work/acme/helper')).toBeInTheDocument();
    expect(screen.getByText('~/work/beta/helper')).toBeInTheDocument();
    expect(screen.queryByText('helper')).not.toBeInTheDocument();
  });

  it('says so when the list cannot be read, rather than saying nothing is trusted', async () => {
    // "Nothing is trusted right now" is the most reassuring sentence this panel
    // has. A failed read must not borrow it: while it is on screen the gate may
    // still be auto-approving under a permission that can no longer be ended here.
    renderWith(<StandingPermissionsSettings />, {
      getConfig: configWith(),
      listStandingPermissions: vi.fn().mockRejectedValue(new Error('offline')),
    });

    expect(
      await screen.findByText(/could not check which standing permissions are live/i)
    ).toBeInTheDocument();
    expect(screen.queryByText('Nothing is trusted right now')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('says that switching the feature off ends every live permission', async () => {
    // Leaving stale rows behind, or ending them without saying so, are both ways
    // of surprising somebody about trust they thought they had.
    const updateConfig = vi.fn().mockResolvedValue(undefined);
    renderWith(<StandingPermissionsSettings />, {
      getConfig: configWith(),
      listStandingPermissions: vi.fn().mockResolvedValue({
        grants: [buildPermission({ grantId: 'g1' }), buildPermission({ grantId: 'g2' })],
      }),
      updateConfig,
    });

    await userEvent.click(await screen.findByRole('switch', { name: 'Standing permissions' }));

    expect(
      await screen.findByText(/This ends all 2 permissions that are live right now/)
    ).toBeInTheDocument();
    // Nothing is written until the person confirms.
    expect(updateConfig).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Turn off and end them' }));
    expect(updateConfig).toHaveBeenCalledWith({ approvals: { standingGrants: false } });
  });

  it('switches off without a confirmation when nothing is live', async () => {
    const updateConfig = vi.fn().mockResolvedValue(undefined);
    renderWith(<StandingPermissionsSettings />, {
      getConfig: configWith(),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [] }),
      updateConfig,
    });

    await userEvent.click(await screen.findByRole('switch', { name: 'Standing permissions' }));

    expect(updateConfig).toHaveBeenCalledWith({ approvals: { standingGrants: false } });
  });
});
