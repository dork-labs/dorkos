/**
 * @vitest-environment jsdom
 *
 * The welcome-back switch in Settings → Preferences (spec team-room-home D5.2,
 * task 4.3).
 *
 * Everything else on this tab is a local display preference kept in Zustand.
 * This one is a server setting that follows the person between devices, so it
 * gets its own card, its own sentence about what it does, and one rule the local
 * toggles do not need: a server that does not report the setting must not be
 * offered a switch for it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useSettingsDeepLink: () => ({
      isOpen: false,
      activeTab: null,
      section: null,
      open: vi.fn(),
      close: vi.fn(),
    }),
  };
});

import { PreferencesTab } from '../ui/tabs/PreferencesTab';

interface WelcomeBack {
  enabled: boolean;
  absenceThresholdMinutes: number;
  maxPosts: number;
  offersEnabled: boolean;
}

function setup(welcomeBack: WelcomeBack | undefined) {
  const transport = createMockTransport();
  vi.mocked(transport.getConfig).mockResolvedValue({
    version: '1.0.0',
    port: 4242,
    uptime: 0,
    workingDirectory: '/test',
    nodeVersion: 'v22.0.0',
    platform: 'darwin-arm64',
    runtimes: ['claude-code'],
    claudeCliPath: null,
    boundary: '/test',
    dorkHome: '/test/.dork',
    tunnel: {
      enabled: false,
      connected: false,
      url: null,
      authEnabled: false,
      tokenConfigured: false,
    },
    ...(welcomeBack && { welcomeBack }),
  } as never);
  vi.mocked(transport.updateConfig).mockResolvedValue(undefined);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <TransportProvider transport={transport}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </TransportProvider>
    );
  }

  return { transport, Wrapper };
}

const DEFAULTS: WelcomeBack = {
  enabled: true,
  absenceThresholdMinutes: 240,
  maxPosts: 3,
  // Offers ship ON (DOR-1121): the offer is the part of a greeting worth
  // reading. It is still the one preference on this tab that spends a model
  // turn, which is why the row states that cost and why turning it off sticks.
  offersEnabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('PreferencesTab — welcome-back switch', () => {
  it('shows the switch on, reflecting the stored value', async () => {
    const { Wrapper } = setup(DEFAULTS);
    render(<PreferencesTab />, { wrapper: Wrapper });

    const toggle = await screen.findByLabelText('Welcome-back notes');
    expect(toggle).toHaveAttribute('data-state', 'checked');
  });

  it('shows the switch off when a person turned it off', async () => {
    const { Wrapper } = setup({ ...DEFAULTS, enabled: false });
    render(<PreferencesTab />, { wrapper: Wrapper });

    const toggle = await screen.findByLabelText('Welcome-back notes');
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
  });

  it('writes welcomeBack.enabled and nothing else when switched off', async () => {
    const user = userEvent.setup();
    const { transport, Wrapper } = setup(DEFAULTS);
    render(<PreferencesTab />, { wrapper: Wrapper });

    await user.click(await screen.findByLabelText('Welcome-back notes'));

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({ welcomeBack: { enabled: false } });
    });
  });

  it('states the threshold actually in force, not the shipped default', async () => {
    const { Wrapper } = setup({ ...DEFAULTS, absenceThresholdMinutes: 720 });
    render(<PreferencesTab />, { wrapper: Wrapper });

    await screen.findByLabelText('Welcome-back notes');
    expect(screen.getByText(/12 hours/)).toBeInTheDocument();
    expect(screen.queryByText(/4 hours/)).not.toBeInTheDocument();
  });

  it('shows the offers switch on, and still says what it costs', async () => {
    const { Wrapper } = setup(DEFAULTS);
    render(<PreferencesTab />, { wrapper: Wrapper });

    const toggle = await screen.findByLabelText('Next-step offers');
    expect(toggle).toHaveAttribute('data-state', 'checked');
    // The cost is stated on the switch itself, not buried in docs — and now that
    // the switch ships ON, that sentence is the only place a person meets the
    // spend before it happens (DOR-1121).
    expect(screen.getByText(/runs that agent for a turn/)).toBeInTheDocument();
  });

  it('shows the offers switch off when a person turned it off', async () => {
    const { Wrapper } = setup({ ...DEFAULTS, offersEnabled: false });
    render(<PreferencesTab />, { wrapper: Wrapper });

    const toggle = await screen.findByLabelText('Next-step offers');
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
  });

  it('writes welcomeBack.offersEnabled and nothing else when switched off', async () => {
    const user = userEvent.setup();
    const { transport, Wrapper } = setup(DEFAULTS);
    render(<PreferencesTab />, { wrapper: Wrapper });

    await user.click(await screen.findByLabelText('Next-step offers'));

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({
        welcomeBack: { offersEnabled: false },
      });
    });
  });

  it('does not offer the offers switch when the notes themselves are off', async () => {
    // Nothing greets you, so there is nothing for an offer to ride on. A switch
    // that cannot do anything is a switch that should not be there.
    const { Wrapper } = setup({ ...DEFAULTS, enabled: false });
    render(<PreferencesTab />, { wrapper: Wrapper });

    await screen.findByLabelText('Welcome-back notes');
    expect(screen.queryByLabelText('Next-step offers')).not.toBeInTheDocument();
  });

  it('offers no switch on a server that does not report the setting', async () => {
    const { Wrapper } = setup(undefined);
    render(<PreferencesTab />, { wrapper: Wrapper });

    // The tab itself renders, so an absent switch is a decision and not a crash.
    await screen.findByLabelText('Show timestamps');
    expect(screen.queryByLabelText('Welcome-back notes')).not.toBeInTheDocument();
  });
});
