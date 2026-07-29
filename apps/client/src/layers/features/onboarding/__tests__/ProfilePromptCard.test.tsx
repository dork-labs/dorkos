/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { DORKBOT_ONBOARDING_LINES } from '@dorkos/shared/dorkbot-templates';
import { TransportProvider } from '@/layers/shared/model';
import { ProfilePromptCard } from '../ui/ProfilePromptCard';

vi.mock('motion/react', () => ({
  motion: { div: 'div' },
  useReducedMotion: () => true,
}));

/** Config-shape fragments the card reads. */
interface CardConfigOverrides {
  onboarding?: Partial<{
    completedSteps: string[];
    skippedSteps: string[];
    startedAt: string | null;
    dismissedAt: string | null;
    completedAt: string | null;
  }>;
  profile?: Partial<{
    roles: string[];
    tools: string[];
    displayName: string | null;
    rolePromptDismissedAt: string | null;
  }>;
}

/**
 * Base case: onboarding finished AND the getting-started helper dismissed, so
 * ProgressCard is not visible; profile empty and never asked. Every clause of
 * the show condition holds — the card renders.
 */
function makeConfig(overrides: CardConfigOverrides = {}) {
  return {
    onboarding: {
      completedSteps: ['meet-dorkbot'],
      skippedSteps: [],
      startedAt: '2026-01-01T00:00:00.000Z',
      dismissedAt: '2026-01-02T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:00.000Z',
      ...overrides.onboarding,
    },
    profile: {
      roles: [],
      tools: [],
      displayName: null,
      rolePromptDismissedAt: null,
      ...overrides.profile,
    },
  };
}

let mockTransport: ReturnType<typeof createMockTransport>;

async function renderCard(overrides: CardConfigOverrides = {}) {
  mockTransport = createMockTransport();
  vi.mocked(mockTransport.getConfig).mockResolvedValue(
    makeConfig(overrides) as Awaited<ReturnType<typeof mockTransport.getConfig>>
  );
  vi.mocked(mockTransport.updateConfig).mockResolvedValue(undefined);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <ProfilePromptCard />
      </TransportProvider>
    </QueryClientProvider>
  );
  // Let the config query settle either way before asserting presence/absence.
  await waitFor(() => expect(mockTransport.getConfig).toHaveBeenCalled());
}

describe('ProfilePromptCard', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('shows once when every clause of the show condition holds', async () => {
    await renderCard();

    expect(await screen.findByTestId('profile-prompt-card')).toBeTruthy();
    expect(screen.getByText(DORKBOT_ONBOARDING_LINES.profileCardPrompt)).toBeTruthy();
    // Non-modal, DorkBot-voiced chip group with one-tap dismissal.
    expect(screen.getByTestId('skip-profile').textContent).toBe("Don't ask again");
  });

  it('never renders while onboarding is still in progress', async () => {
    await renderCard({ onboarding: { completedAt: null, dismissedAt: null } });
    expect(screen.queryByTestId('profile-prompt-card')).toBeNull();
  });

  it('never renders once roles exist', async () => {
    await renderCard({ profile: { roles: ['hiring'] } });
    expect(screen.queryByTestId('profile-prompt-card')).toBeNull();
  });

  it('never renders when the profile step was completed in onboarding', async () => {
    await renderCard({ onboarding: { completedSteps: ['meet-dorkbot', 'profile'] } });
    expect(screen.queryByTestId('profile-prompt-card')).toBeNull();
  });

  it('never renders when the profile step was skipped in onboarding (asked once, ever)', async () => {
    await renderCard({ onboarding: { skippedSteps: ['profile'] } });
    expect(screen.queryByTestId('profile-prompt-card')).toBeNull();
  });

  it('never renders after "Don\'t ask again" was recorded', async () => {
    await renderCard({ profile: { rolePromptDismissedAt: '2026-01-03T00:00:00.000Z' } });
    expect(screen.queryByTestId('profile-prompt-card')).toBeNull();
  });

  it('never renders alongside ProgressCard (getting-started still visible)', async () => {
    // completedAt set + dismissedAt null is exactly the state where the
    // getting-started ProgressCard shows; its row is the single affordance.
    await renderCard({ onboarding: { dismissedAt: null } });
    expect(screen.queryByTestId('profile-prompt-card')).toBeNull();
  });

  it('Save writes { profile: { roles } } and thanks-and-collapses', async () => {
    await renderCard();
    await screen.findByTestId('profile-prompt-card');

    fireEvent.click(screen.getByRole('button', { name: 'Hiring people' }));
    fireEvent.click(screen.getByTestId('confirm-profile'));

    await waitFor(() =>
      expect(mockTransport.updateConfig).toHaveBeenCalledWith({
        profile: { roles: ['hiring'] },
      })
    );
    // The authored thanks line replaces the question; the picker is gone.
    expect(await screen.findByText(DORKBOT_ONBOARDING_LINES.profileSaved)).toBeTruthy();
    expect(screen.queryByTestId('confirm-profile')).toBeNull();
  });

  it('Save is disabled until at least one role is picked', async () => {
    await renderCard();
    await screen.findByTestId('profile-prompt-card');

    expect(screen.getByTestId('confirm-profile')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Writing' }));
    expect(screen.getByTestId('confirm-profile')).toHaveProperty('disabled', false);
  });

  it('a failed save shows the retry line and keeps the card up', async () => {
    await renderCard();
    await screen.findByTestId('profile-prompt-card');
    vi.mocked(mockTransport.updateConfig).mockRejectedValueOnce(new Error('nope'));

    fireEvent.click(screen.getByRole('button', { name: 'Hiring people' }));
    fireEvent.click(screen.getByTestId('confirm-profile'));

    expect(await screen.findByTestId('profile-save-error')).toBeTruthy();
    expect(screen.getByTestId('confirm-profile').textContent).toBe('Try again');
  });

  it('"Don\'t ask again" writes rolePromptDismissedAt and removes the card', async () => {
    await renderCard();
    await screen.findByTestId('profile-prompt-card');

    fireEvent.click(screen.getByTestId('skip-profile'));

    await waitFor(() =>
      expect(mockTransport.updateConfig).toHaveBeenCalledWith({
        profile: { rolePromptDismissedAt: expect.any(String) },
      })
    );
    expect(screen.queryByTestId('profile-prompt-card')).toBeNull();
    // Nothing was written to roles.
    expect(mockTransport.updateConfig).not.toHaveBeenCalledWith(
      expect.objectContaining({ profile: expect.objectContaining({ roles: expect.anything() }) })
    );
  });
});
