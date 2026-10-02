/**
 * @vitest-environment jsdom
 *
 * The notices about credits choices (ADR 261001-000811): one per choice DorkOS
 * made for the person, each worded calmly, each settled by the person.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { CreditsNotices } from '../ui/CreditsNotices';

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
        <CreditsNotices />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('CreditsNotices', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('announces the gaps a new link filled, with Change and Undo all', async () => {
    const user = userEvent.setup();
    const transport = renderSource({
      defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'default' } },
      notices: [{ kind: 'filled', runtimes: ['claude-code'] }],
    });
    const notice = await screen.findByTestId('credits-notice-filled');
    expect(notice).toHaveTextContent(
      'Claude Code now runs on your DorkOS credits, because it had no working sign-in when you linked your account.'
    );
    await user.click(screen.getByRole('button', { name: 'Undo all' }));
    await waitFor(() => expect(transport.undoFilledCloudCredits).toHaveBeenCalledOnce());
  });

  it('says why an answer was refused, in the server’s own words', async () => {
    const user = userEvent.setup();
    const transport = renderSource({
      defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'default' } },
      notices: [{ kind: 'filled', runtimes: ['claude-code'] }],
    });
    // What the transport throws for the owner bar's 403 (DOR-2652).
    const sentence = 'Only the owner of this DorkOS can choose what runs on DorkOS credits.';
    vi.mocked(transport.undoFilledCloudCredits).mockRejectedValue(
      Object.assign(new Error(sentence), {
        status: 403,
        code: 'owner_only',
        body: { error: sentence, code: 'owner_only' },
      })
    );
    await screen.findByTestId('credits-notice-filled');
    await user.click(screen.getByRole('button', { name: 'Undo all' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`Couldn’t change that. ${sentence}`);
  });

  it('opens Runs on from the announcement, and settles it', async () => {
    const user = userEvent.setup();
    const transport = renderSource({
      defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'default' } },
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
      defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'default' } },
      notices: [{ kind: 'signed-in', runtime: 'claude-code' }],
    });
    await screen.findByTestId('credits-notice-signed-in');
    await user.click(screen.getByRole('button', { name: 'Use my Claude Code sign-in' }));
    await waitFor(() =>
      expect(transport.setCloudCreditsDefault).toHaveBeenCalledWith('claude-code', false)
    );
  });
});
