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
import { ResponsiveDropdownMenu, ResponsiveDropdownMenuContent } from '@/layers/shared/ui';
import { AccountMenuRows } from '../ui/AccountMenuRows';

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

/**
 * The rows variant, in a menu root.
 *
 * `AccountMenuRows` renders menu items, which throw outside a menu — it is a
 * fragment of a menu rather than a component that owns one, and the fold that
 * consumes it supplies the root. So does this.
 *
 * @param overrides - Props to vary; the rest are stubs.
 */
function renderRows(overrides: Partial<React.ComponentProps<typeof AccountMenuRows>> = {}) {
  const props = {
    member: SELF,
    canSignOut: true,
    onViewProfile: vi.fn(),
    onOpenSettings: vi.fn(),
    onSignOut: vi.fn(),
    ...overrides,
  };
  render(
    <ResponsiveDropdownMenu open>
      <ResponsiveDropdownMenuContent>
        <AccountMenuRows {...props} />
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
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

  it('yields the two doors the sidebar header block carries, and keeps the rest', () => {
    // BC-43 gives "Workspace settings" and "Account" a home in the sidebar's
    // header block, so the footer fold that also draws these rows hides both
    // rather than offering one dialog under two names in two menus. What it
    // keeps is what the header menu does not carry: who you are signed in as,
    // and how to stop being.
    renderRows({ showSettings: false, showViewProfile: false });

    // Observable: the block rendered and still says who you are.
    expect(screen.getByText(SELF.displayName)).toBeInTheDocument();
    expect(screen.getByText('Sign out')).toBeInTheDocument();
    expect(screen.queryByText('View profile')).not.toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });

  it('draws both doors by default, so the hiding above is a choice and not the shape', () => {
    renderRows();
    expect(screen.getByText('View profile')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('answers your pointer with your own colour, never by dimming your face', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: /your account/i });
    const disc = trigger.querySelector('[data-slot="identity-avatar"]') as HTMLElement;

    // It used to fade to 80% — the universal idiom for DISABLED — so your own
    // face read as switched off the moment you pointed at it.
    expect(trigger.className).not.toContain('opacity-80');
    expect(trigger.className).toContain('focus-ring');
    expect(disc.className).toContain('group-hover/identity:ring-2');
    expect(disc.className).toContain('group-focus-visible/identity:ring-2');
    expect(disc.style.getPropertyValue('--identity-color')).not.toBe('');
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
