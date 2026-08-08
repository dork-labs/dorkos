/**
 * @vitest-environment jsdom
 *
 * The half of the account menu that decides who you are.
 *
 * Two things are pinned here that the presentational test cannot see. **Where
 * `canSignOut` comes from**: the auth session, not a config flag and not the
 * roster — the roster has a person on it whether or not there is a login, so
 * deriving it from the row would put a sign-out on every accountless install.
 * And **that nothing is drawn without a self row**, which is what keeps a disc
 * with no menu behind it out of the Obsidian embed's sidebar.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';

const mockOpenProfile = vi.fn();
const mockOpenSettings = vi.fn();
vi.mock('@/layers/shared/model/use-dialog-deep-link', () => ({
  useProfileDeepLink: () => ({
    isOpen: false,
    memberId: null,
    open: mockOpenProfile,
    close: vi.fn(),
  }),
  useSettingsDeepLink: () => ({
    isOpen: false,
    activeTab: null,
    section: null,
    open: mockOpenSettings,
    close: vi.fn(),
    setTab: vi.fn(),
    setSection: vi.fn(),
  }),
}));

const mockToastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args) } }));

let mockUser: { id: string } | null = null;
const mockRun = vi.fn().mockResolvedValue({ ok: true });
vi.mock('@/layers/features/auth', () => ({
  useCurrentUser: () => mockUser,
  useSignOut: () => ({ run: mockRun, isPending: false, error: null, reset: vi.fn() }),
}));

import { AccountMenuContainer } from '../ui/AccountMenuContainer';

const SELF = MOCK_TEAM_ROSTER.find((member) => member.isSelf)!;

function renderContainer(members = MOCK_TEAM_ROSTER) {
  const transport: Transport = createMockTransport({
    getTeamRoster: vi.fn().mockResolvedValue({ members }),
  } as Partial<Transport>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <AccountMenuContainer />
      </TransportProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  mockUser = null;
  vi.clearAllMocks();
  mockRun.mockResolvedValue({ ok: true });
});

/** Open the menu and press Sign out. */
async function signOutFromMenu() {
  await userEvent.click(await screen.findByRole('button', { name: /your account/i }));
  await userEvent.click(await screen.findByText('Sign out'));
}

describe('AccountMenuContainer', () => {
  it('draws the operator’s own face once the roster names them', async () => {
    renderContainer();
    expect(
      await screen.findByRole('button', { name: `Your account: ${SELF.displayName}` })
    ).toBeInTheDocument();
  });

  it('draws nothing at all when the roster names nobody', async () => {
    renderContainer([]);
    // The Obsidian embed's roster is empty by construction, and a disc with no
    // identity behind it is a control that cannot do its job.
    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());
  });

  it('offers Sign out from the auth session, not from the roster row', async () => {
    // Same roster, same self row — only the session differs.
    mockUser = { id: 'user-1' };
    renderContainer();
    await userEvent.click(await screen.findByRole('button', { name: /your account/i }));
    expect(await screen.findByText('Sign out')).toBeInTheDocument();
    cleanup();

    mockUser = null;
    renderContainer();
    await userEvent.click(await screen.findByRole('button', { name: /your account/i }));
    await screen.findByText('View profile');
    expect(screen.queryByText('Sign out')).not.toBeInTheDocument();
  });

  it('says so when signing out FAILS, instead of closing as though it worked', async () => {
    mockUser = { id: 'user-1' };
    mockRun.mockResolvedValue({ ok: false, error: { message: 'Network unreachable' } });
    renderContainer();

    await signOutFromMenu();

    // The menu closes either way, so without this the person is left signed in
    // looking at a UI that behaved exactly as it does on success.
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(mockToastError.mock.calls[0][0]).toBe('Could not sign out');
    expect(mockToastError.mock.calls[0][1]).toMatchObject({ description: 'Network unreachable' });
  });

  it('stays quiet when signing out works', async () => {
    mockUser = { id: 'user-1' };
    renderContainer();

    await signOutFromMenu();

    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
