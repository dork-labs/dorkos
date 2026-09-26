/**
 * @vitest-environment jsdom
 */
/**
 * The one-time "what should I call you?" card for existing installs (DOR-677).
 *
 * Mounted the way the sidebar's bottom slot mounts it — gated by
 * `useIdentityPrompt` — and driven through the REAL form over a mock
 * transport, so every case is about what a person in this state sees and what
 * gets written: the show condition, that nothing is saved by being asked, that
 * a save and a dismissal each close the question for good, and that a refusal
 * reads as the sentence Settings › Profile already uses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { DORKBOT_ONBOARDING_LINES } from '@dorkos/shared/dorkbot-templates';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { setPrefersReducedMotion } from '@/test-setup';
import { IdentityPromptCard } from '../ui/IdentityPromptCard';
import { useIdentityPrompt } from '../model/use-identity-prompt';

function PromptHost() {
  const prompt = useIdentityPrompt();
  if (!prompt.visible) return null;
  return <IdentityPromptCard prompt={prompt} />;
}

interface Overrides {
  onboarding?: Partial<{ completedAt: string | null; dismissedAt: string | null }>;
  identityPromptDismissedAt?: string | null;
  self?: Partial<TeamMember> | null;
  email?: string;
  others?: TeamMember[];
}

function selfRow(overrides: Partial<TeamMember>, email?: string): TeamMember {
  return {
    id: 'author-self',
    kind: 'human',
    displayName: 'You',
    handle: null,
    isSelf: true,
    ownerId: null,
    origin: 'local',
    person: { role: null, lastSeenAt: null, ...(email ? { email } : {}) },
    ...overrides,
  };
}

let mockTransport: ReturnType<typeof createMockTransport>;

async function renderCard(overrides: Overrides = {}) {
  mockTransport = createMockTransport();
  vi.mocked(mockTransport.getConfig).mockResolvedValue({
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
      identityPromptDismissedAt: overrides.identityPromptDismissedAt ?? null,
    },
  } as unknown as Awaited<ReturnType<typeof mockTransport.getConfig>>);
  vi.mocked(mockTransport.updateConfig).mockResolvedValue(undefined);
  const members = overrides.self === null ? [] : [selfRow(overrides.self ?? {}, overrides.email)];
  vi.mocked(mockTransport.getTeamRoster).mockResolvedValue({
    members: [...members, ...(overrides.others ?? [])],
  } as Awaited<ReturnType<typeof mockTransport.getTeamRoster>>);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <PromptHost />
      </TransportProvider>
    </QueryClientProvider>
  );
  // Settled, not merely started: the card is null while loading, so a negative
  // assertion made then would pass whatever the condition said.
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
}

/** The dismissal write, if one was made. */
function dismissalWrites() {
  return vi
    .mocked(mockTransport.updateConfig)
    .mock.calls.filter(
      ([patch]) =>
        (patch as { profile?: { identityPromptDismissedAt?: unknown } }).profile
          ?.identityPromptDismissedAt !== undefined
    );
}

describe('IdentityPromptCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPrefersReducedMotion(true);
  });
  afterEach(() => cleanup());

  it('asks an operator with no name and no handle, once onboarding is over', async () => {
    await renderCard();
    expect(await screen.findByTestId('identity-prompt-card')).toBeTruthy();
    expect(screen.getByText(DORKBOT_ONBOARDING_LINES.identityCardPrompt[0])).toBeTruthy();
    expect(screen.getByTestId('skip-identity').textContent).toBe('Don’t ask again');
  });

  it('writes nothing by being shown — not a handle, not a dismissal (DOR-604)', async () => {
    await renderCard({ email: 'kai@example.com' });
    await screen.findByTestId('identity-prompt-card');
    // The suggestion is SHOWN in the field...
    expect((screen.getByLabelText('Handle') as HTMLInputElement).value).toBe('kai');
    // ...and nothing has been saved or recorded.
    expect(mockTransport.setAuthorHandle).not.toHaveBeenCalled();
    expect(mockTransport.updateProfile).not.toHaveBeenCalled();
    expect(mockTransport.updateConfig).not.toHaveBeenCalled();
  });

  it('starts the handle empty when there is no email to suggest from', async () => {
    await renderCard();
    await screen.findByTestId('identity-prompt-card');
    expect((screen.getByLabelText('Handle') as HTMLInputElement).value).toBe('');
    // `You` is a placeholder, not a name to save.
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('');
  });

  it('asks for the handle alone when the name is already known', async () => {
    await renderCard({ self: { displayName: 'Kai' } });
    await screen.findByTestId('identity-prompt-card');
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Kai');
  });

  it('never shows to an operator who already has a name and a handle', async () => {
    await renderCard({ self: { displayName: 'Kai', handle: 'kai' } });
    expect(screen.queryByTestId('identity-prompt-card')).toBeNull();
  });

  it('never shows once the question was closed', async () => {
    await renderCard({ identityPromptDismissedAt: '2026-09-01T00:00:00.000Z' });
    expect(screen.queryByTestId('identity-prompt-card')).toBeNull();
  });

  it('never shows while onboarding is still in progress', async () => {
    await renderCard({ onboarding: { completedAt: null, dismissedAt: null } });
    expect(screen.queryByTestId('identity-prompt-card')).toBeNull();
  });

  it('never shows alongside the getting-started card', async () => {
    // completedAt set + dismissedAt null is where ProgressCard shows; its row
    // is the single place the question is put then.
    await renderCard({ onboarding: { dismissedAt: null } });
    expect(screen.queryByTestId('identity-prompt-card')).toBeNull();
  });

  it('never shows when this install has no row for the operator', async () => {
    await renderCard({ self: null });
    expect(screen.queryByTestId('identity-prompt-card')).toBeNull();
  });

  it('saves the name and the handle on confirm, thanks, and records the question closed', async () => {
    await renderCard({ email: 'kai@example.com' });
    await screen.findByTestId('identity-prompt-card');

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Kai Nakamura' } });
    fireEvent.click(screen.getByTestId('confirm-identity'));

    expect(await screen.findByText(DORKBOT_ONBOARDING_LINES.identityCardSaved)).toBeTruthy();
    expect(mockTransport.updateProfile).toHaveBeenCalledWith('Kai Nakamura');
    expect(mockTransport.setAuthorHandle).toHaveBeenCalledWith('author-self', 'kai');
    await waitFor(() => expect(dismissalWrites()).toHaveLength(1));
  });

  it('"Don’t ask again" collapses the card, records it, and saves nothing', async () => {
    await renderCard({ email: 'kai@example.com' });
    await screen.findByTestId('identity-prompt-card');

    fireEvent.click(screen.getByTestId('skip-identity'));

    await waitFor(() => expect(screen.queryByTestId('identity-prompt-card')).toBeNull());
    await waitFor(() => expect(dismissalWrites()).toHaveLength(1));
    expect(mockTransport.setAuthorHandle).not.toHaveBeenCalled();
    expect(mockTransport.updateProfile).not.toHaveBeenCalled();
  });

  it('a taken handle reads as the Settings sentence, keeps the card, and records nothing', async () => {
    await renderCard({ email: 'kai@example.com' });
    await screen.findByTestId('identity-prompt-card');
    vi.mocked(mockTransport.setAuthorHandle).mockRejectedValueOnce(
      Object.assign(new Error('taken'), { code: 'HANDLE_TAKEN' })
    );

    fireEvent.click(screen.getByTestId('confirm-identity'));

    expect(
      await screen.findByText('@kai belongs to someone else. Pick a different one.')
    ).toBeTruthy();
    expect(screen.getByTestId('confirm-identity').textContent).toBe('Try again');
    expect(screen.getByTestId('identity-prompt-card')).toBeTruthy();
    expect(dismissalWrites()).toHaveLength(0);
  });

  it('an invalid handle shows the server’s own rule', async () => {
    await renderCard();
    await screen.findByTestId('identity-prompt-card');
    vi.mocked(mockTransport.setAuthorHandle).mockRejectedValueOnce(
      Object.assign(new Error('A handle is all lowercase.'), { code: 'INVALID_HANDLE' })
    );

    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'Kai' } });
    fireEvent.click(screen.getByTestId('confirm-identity'));

    expect(await screen.findByText('A handle is all lowercase.')).toBeTruthy();
  });
});
