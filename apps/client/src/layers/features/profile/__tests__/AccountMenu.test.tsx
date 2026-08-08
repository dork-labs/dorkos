/**
 * @vitest-environment jsdom
 *
 * The account menu, and the one thing about it that is a product decision
 * rather than a layout: **Sign out is drawn only when there is a session to
 * end.** Login is optional and off by default (ADR-0320), so on most installs
 * a sign-out item would be a control that does nothing — it invites a click and
 * then has to explain itself. The absence test is the one that can fail against
 * a menu that just lists everything.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { AccountMenu } from '../ui/AccountMenu';

const SELF = MOCK_TEAM_ROSTER.find((member) => member.isSelf)!;

function renderMenu(overrides: Partial<React.ComponentProps<typeof AccountMenu>> = {}) {
  const props = {
    member: SELF,
    canSignOut: true,
    onViewProfile: vi.fn(),
    onOpenSettings: vi.fn(),
    onSignOut: vi.fn(),
    ...overrides,
  };
  render(<AccountMenu {...props} />);
  return props;
}

/** Open the menu the way a person does, and wait for its items to mount. */
async function openMenu() {
  await userEvent.click(screen.getByRole('button', { name: /your account/i }));
  await screen.findByText('View profile');
}

afterEach(cleanup);

describe('AccountMenu', () => {
  it('offers Sign out when this install has a local account', async () => {
    renderMenu({ canSignOut: true });
    await openMenu();
    expect(screen.getByText('Sign out')).toBeInTheDocument();
  });

  it('does NOT offer Sign out when there is no account to sign out of', async () => {
    renderMenu({ canSignOut: false });
    await openMenu();
    // The other two items are there, so this is an absence of the item and not
    // an absence of the menu.
    expect(screen.getByText('View profile')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.queryByText('Sign out')).not.toBeInTheDocument();
  });

  it('names the person on the trigger and in the header', async () => {
    renderMenu();
    expect(screen.getByRole('button', { name: `Your account: ${SELF.displayName}` })).toBeVisible();
    await openMenu();
    expect(screen.getByText(SELF.displayName)).toBeInTheDocument();
    expect(screen.getByText(`@${SELF.handle}`)).toBeInTheDocument();
  });

  it('draws no @ at all for somebody who has not claimed a handle', async () => {
    const unclaimed: TeamMember = { ...SELF, handle: null };
    renderMenu({ member: unclaimed });
    await openMenu();
    // An empty `@` would be an address that reaches nobody, rendered as if it
    // were one.
    expect(screen.queryByText(/^@/)).not.toBeInTheDocument();
  });

  it('runs each item’s action', async () => {
    const props = renderMenu();
    await openMenu();

    await userEvent.click(screen.getByText('View profile'));
    expect(props.onViewProfile).toHaveBeenCalledTimes(1);

    await openMenu();
    await userEvent.click(screen.getByText('Settings'));
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);

    await openMenu();
    await userEvent.click(screen.getByText('Sign out'));
    expect(props.onSignOut).toHaveBeenCalledTimes(1);
  });
});
