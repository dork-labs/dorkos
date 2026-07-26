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

import { TransportProvider, useEventSubscription } from '@/layers/shared/model';
import { PendingApprovalsSection } from '../ui/PendingApprovalsSection';
import { StandingPermissionsSettings } from '../ui/StandingPermissionsSettings';
import { useStandingGrantPolicy } from '../model/use-standing-grant-policy';

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the third button on an approval card', () => {
  /** The standing button, found by the part of its label that never varies. */
  const standingButton = () => screen.queryByRole('button', { name: /stop asking about this/i });

  it('names the whole scope on the button, with the window from the setting', async () => {
    renderWith(
      <>
        <PolicyProbe />
        <PendingApprovalsSection />
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
        <PendingApprovalsSection />
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
        <PendingApprovalsSection />
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
        <PendingApprovalsSection />
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
        <PendingApprovalsSection />
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
        <PendingApprovalsSection />
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
        <PendingApprovalsSection />
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

  it('keeps "Don\'t allow" first, and the standing answer last', async () => {
    // Neither answer may be dressed up as the safe one, and the permanent answer
    // must not sit where the eye lands first.
    renderWith(
      <>
        <PolicyProbe />
        <PendingApprovalsSection />
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
