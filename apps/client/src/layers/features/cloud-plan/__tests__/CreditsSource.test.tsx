/**
 * @vitest-environment jsdom
 *
 * "Use credits for" and the notices about credits choices (ADR
 * 261001-000811): a switch per runtime that declares credits, a calm line about
 * who chose them, and one notice per choice DorkOS made for the person.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { CreditsSource } from '../ui/CreditsSource';

const { openSettings } = vi.hoisted(() => ({ openSettings: vi.fn() }));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSettingsDeepLink: () => ({ open: openSettings }),
}));

const BASE: CloudCreditsStatus = {
  enabled: true,
  killed: false,
  linked: true,
  ready: true,
  runtimes: { 'claude-code': 'wired', codex: 'follow-up', opencode: 'follow-up' },
  defaults: {},
  notices: [],
};

function renderSource(status: Partial<CloudCreditsStatus>) {
  const transport = createMockTransport({
    getCloudCredits: vi.fn().mockResolvedValue({ ...BASE, ...status }),
    setCloudCreditsDefault: vi.fn().mockResolvedValue(BASE),
    undoFilledCloudCredits: vi.fn().mockResolvedValue(BASE),
    dismissCloudCreditsNotice: vi.fn().mockResolvedValue(BASE),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <CreditsSource />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('CreditsSource', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('gives each runtime that declares credits a switch, and names the rest in words', async () => {
    const user = userEvent.setup();
    const transport = renderSource({});
    const toggle = await screen.findByRole('switch', {
      name: 'Use DorkOS credits for Claude Code',
    });
    expect(toggle).not.toBeChecked();
    // Display names, never raw runtime ids.
    expect(screen.getByText('Codex and OpenCode run on their own sign-in for now.')).toBeVisible();
    await user.click(toggle);
    await waitFor(() =>
      expect(transport.setCloudCreditsDefault).toHaveBeenCalledWith('claude-code', true)
    );
  });

  it('says calmly when DorkOS turned credits on, and turning off goes back to the own sign-in', async () => {
    const user = userEvent.setup();
    const transport = renderSource({ defaults: { 'claude-code': { chosenBy: 'default' } } });
    const toggle = await screen.findByRole('switch', {
      name: 'Use DorkOS credits for Claude Code',
    });
    expect(toggle).toBeChecked();
    expect(screen.getByText(/DorkOS turned this on when you linked/)).toBeVisible();
    await user.click(toggle);
    await waitFor(() =>
      expect(transport.setCloudCreditsDefault).toHaveBeenCalledWith('claude-code', false)
    );
  });

  it('renders nothing on a computer that is not linked', async () => {
    const transport = renderSource({ linked: false, enabled: false });
    await waitFor(() => expect(transport.getCloudCredits).toHaveBeenCalled());
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('announces the gaps a new link filled, with Change and Undo all', async () => {
    const user = userEvent.setup();
    const transport = renderSource({
      defaults: { 'claude-code': { chosenBy: 'default' } },
      notices: [{ kind: 'filled', runtimes: ['claude-code'] }],
    });
    const notice = await screen.findByTestId('credits-notice-filled');
    expect(notice).toHaveTextContent(
      'Claude Code now runs on your DorkOS credits, because it had no working sign-in when you linked your account.'
    );
    await user.click(screen.getByRole('button', { name: 'Undo all' }));
    await waitFor(() => expect(transport.undoFilledCloudCredits).toHaveBeenCalledOnce());
  });

  it('opens Runs on from the announcement, and settles it', async () => {
    const user = userEvent.setup();
    const transport = renderSource({
      defaults: { 'claude-code': { chosenBy: 'default' } },
      notices: [{ kind: 'filled', runtimes: ['claude-code'] }],
    });
    await screen.findByTestId('credits-notice-filled');
    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(openSettings).toHaveBeenCalledWith('runtimes');
    await waitFor(() =>
      expect(transport.dismissCloudCreditsNotice).toHaveBeenCalledWith({ kind: 'filled' })
    );
  });

  it('offers credits once to a computer linked before they were a choice', async () => {
    const user = userEvent.setup();
    const transport = renderSource({ notices: [{ kind: 'offer' }] });
    await screen.findByTestId('credits-notice-offer');
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() =>
      expect(transport.dismissCloudCreditsNotice).toHaveBeenCalledWith({ kind: 'offer' })
    );
  });

  it('re-offers the own sign-in once it works under a choice DorkOS made', async () => {
    const user = userEvent.setup();
    const transport = renderSource({
      defaults: { 'claude-code': { chosenBy: 'default' } },
      notices: [{ kind: 'signed-in', runtime: 'claude-code' }],
    });
    await screen.findByTestId('credits-notice-signed-in');
    await user.click(screen.getByRole('button', { name: 'Use my Claude Code sign-in' }));
    await waitFor(() =>
      expect(transport.setCloudCreditsDefault).toHaveBeenCalledWith('claude-code', false)
    );
  });
});
