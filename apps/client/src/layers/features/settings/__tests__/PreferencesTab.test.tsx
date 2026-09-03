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

/**
 * The two rows that came back from the old "Advanced" tab (DOR-1758).
 *
 * Both are about the conversation in front of you — the box you type into, and
 * whether DorkOS keeps checking for messages from sessions started elsewhere —
 * so both belong beside the other chat rows rather than in a drawer named after
 * nothing.
 */
describe('PreferencesTab — the rows that came back from Advanced', () => {
  it('renders the message-box formatting row in plain words', async () => {
    const { Wrapper } = setup(DEFAULTS);
    render(<PreferencesTab />, { wrapper: Wrapper });

    // The exact copy is the deliverable: no "Lexical", no "WYSIWYG", no "rich
    // text editor", no "experimental" in the label. A smart 9th grader who does
    // not code has to understand what turning it on does.
    expect(await screen.findByText('Format text as you type')).toBeInTheDocument();
    expect(
      screen.getByText(
        'See bold, headings, and lists take shape in the message box while you write.'
      )
    ).toBeInTheDocument();
  });

  it('the formatting row is on when nobody has turned it off', async () => {
    // The shipped default since 2026-08-12. This config carries no `ui` block at
    // all, so what the switch shows here is exactly what a person who never
    // opened this tab gets.
    const { Wrapper } = setup(DEFAULTS);
    render(<PreferencesTab />, { wrapper: Wrapper });

    expect(await screen.findByRole('switch', { name: /Format text as you type/i })).toBeChecked();
  });

  it('toggling the formatting row writes exactly the composer subtree', async () => {
    const user = userEvent.setup();
    const { transport, Wrapper } = setup(DEFAULTS);
    vi.mocked(transport.getConfig).mockResolvedValue({
      ui: { composer: { richText: false } },
    } as never);
    render(<PreferencesTab />, { wrapper: Wrapper });

    // Wait for the stored `false` to arrive before clicking. Config resolves a
    // tick late and the default is `true`, so a click on the first render would
    // toggle a switch still showing the default and write the opposite.
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /Format text as you type/i })).not.toBeChecked()
    );
    await user.click(screen.getByRole('switch', { name: /Format text as you type/i }));

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ ui: { composer: { richText: true } } })
    );
  });

  // Background refresh is an opt-in external-session polling fallback (spec
  // chat-stream-reconnection, ADR-0266): server-side discovery is primary, so
  // the copy frames it as a fallback, not a correctness switch.
  it('describes Background refresh as an opt-in external-session fallback', async () => {
    const { Wrapper } = setup(DEFAULTS);
    render(<PreferencesTab />, { wrapper: Wrapper });

    expect(await screen.findByText('Background refresh')).toBeInTheDocument();
    expect(screen.getByText(/Claude Code CLI/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Enable only if external activity isn't appearing promptly/i)
    ).toBeInTheDocument();
  });

  // A developer panel is a debugging aid, and it now sits with the other ones in
  // Settings → Server → Diagnostics rather than between "To-do celebrations" and
  // a re-run of onboarding.
  it('no longer carries the dev-tools switch', async () => {
    const { Wrapper } = setup(DEFAULTS);
    render(<PreferencesTab />, { wrapper: Wrapper });

    await screen.findByLabelText('Show timestamps');
    expect(screen.queryByText('Show dev tools')).not.toBeInTheDocument();
  });
});
