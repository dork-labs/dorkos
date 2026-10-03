/**
 * @vitest-environment jsdom
 *
 * The `credits-runs-on` section on Codex's and OpenCode's cards (ADR
 * 261002-221210): absent until the server reports the runtime as wired for
 * credits, a view onto the one recorded choice, and copy that says what a
 * change reaches.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  CreditsRunsOnSection,
  creditsRunsOnNote,
  creditsRunsOnShown,
} from '../sections/CreditsRunsOnSection';

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

const LINKED: CloudCreditsStatus = {
  enabled: true,
  killed: false,
  linked: true,
  ready: true,
  runtimes: { 'claude-code': 'wired', opencode: 'wired', codex: 'follow-up' },
  defaults: {},
  notices: [],
};

function renderSection(types: string | string[], status: CloudCreditsStatus) {
  const setCloudCreditsDefault = vi.fn().mockResolvedValue(status);
  const transport = createMockTransport({
    getCloudCredits: vi.fn().mockResolvedValue(status),
    setCloudCreditsDefault,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        {[types].flat().map((type) => (
          <CreditsRunsOnSection key={type} type={type} />
        ))}
      </TransportProvider>
    </QueryClientProvider>
  );
  return { setCloudCreditsDefault };
}

describe('whether the section shows', () => {
  it('only for a runtime the server reports as wired, and only while credits can be had', () => {
    expect(creditsRunsOnShown(LINKED, 'opencode')).toBe(true);
    // Codex declares credits, but the endpoint does not serve its format yet.
    expect(creditsRunsOnShown(LINKED, 'codex')).toBe(false);
    expect(creditsRunsOnShown({ ...LINKED, enabled: false }, 'opencode')).toBe(false);
    expect(creditsRunsOnShown(undefined, 'opencode')).toBe(false);
  });

  it('draws nothing for a runtime credits cannot reach', async () => {
    // OpenCode's section appearing proves the report has loaded, so Codex's
    // absence is the answer and not a race.
    renderSection(['codex', 'opencode'], LINKED);
    await screen.findByRole('radio', { name: 'Your OpenCode sign-in' });
    expect(screen.getAllByTestId('credits-runs-on-section')).toHaveLength(1);
    expect(screen.queryByRole('radio', { name: 'Your Codex sign-in' })).not.toBeInTheDocument();
  });
});

describe('what a change reaches', () => {
  it('says a conversation stays on what it started on, or that the whole runtime moves', () => {
    expect(creditsRunsOnNote('Codex', 'conversation', false)).toBe(
      'A change applies to new Codex conversations. One already going stays on what it started on.'
    );
    expect(creditsRunsOnNote('OpenCode', 'runtime', false)).toBe(
      "A change moves every OpenCode conversation, so it can't be made while OpenCode is in the middle of a reply."
    );
    expect(creditsRunsOnNote('OpenCode', 'runtime', true)).toMatch(
      /^DorkOS chose credits when you linked, because OpenCode had no sign-in\./
    );
  });
});

describe('the choice', () => {
  it('reads the recorded choice and records the person’s pick', async () => {
    const { setCloudCreditsDefault } = renderSection('opencode', LINKED);
    const own = await screen.findByRole('radio', { name: 'Your OpenCode sign-in' });
    expect(own).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'DorkOS credits' }));
    await waitFor(() => expect(setCloudCreditsDefault).toHaveBeenCalledWith('opencode', true));
  });

  it('says the server’s reason when a switch is refused', async () => {
    const reason =
      'OpenCode is in the middle of a reply. Switch once it finishes, so nothing it is doing is cut off.';
    const { setCloudCreditsDefault } = renderSection('opencode', LINKED);
    setCloudCreditsDefault.mockRejectedValueOnce(
      Object.assign(new Error(reason), { status: 409, body: { error: reason } })
    );
    await userEvent.click(await screen.findByRole('radio', { name: 'DorkOS credits' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`Couldn’t change that. ${reason}`);
  });

  it('shows credits as the current choice when that is what is recorded', async () => {
    renderSection('opencode', {
      ...LINKED,
      defaults: { opencode: { runsOn: 'credits', chosenBy: 'user' } },
    });
    expect(await screen.findByRole('radio', { name: 'DorkOS credits' })).toBeChecked();
  });
});
