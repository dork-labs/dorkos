// @vitest-environment jsdom
/**
 * The help menu's three rows (feedback-form-redesign §1, DOR-2232): the form,
 * the person's own reports, and the docs. "Report a bug" merged into the form's
 * kind picker, and the GitHub sub-menu moved into the form's footer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/layers/shared/ui';
import { useFeedbackDialogStore } from '@/layers/shared/model';
import { HelpMenuItems } from '../ui/HelpMenuItems';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

const openLink = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/lib/link-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib/link-navigation')>()),
  openLink,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useFeedbackDialogStore.setState({ open: false, prefill: {} });
});

async function openMenu() {
  const user = userEvent.setup();
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Help</DropdownMenuTrigger>
      <DropdownMenuContent>
        <HelpMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
  await user.click(screen.getByRole('button', { name: 'Help' }));
  return user;
}

describe('HelpMenuItems', () => {
  it('offers exactly three rows, in order', async () => {
    await openMenu();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Send feedback…',
      'Your reports',
      'Documentation',
    ]);
  });

  it('has no separate bug row and no GitHub sub-menu any more', async () => {
    await openMenu();
    expect(screen.queryByText('Report a bug')).not.toBeInTheDocument();
    expect(screen.queryByText(/GitHub/)).not.toBeInTheDocument();
  });

  it('opens the feedback form without forcing a kind over a draft', async () => {
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Send feedback…' }));
    const state = useFeedbackDialogStore.getState();
    expect(state.open).toBe(true);
    expect(state.prefill).toEqual({});
  });

  it('takes "Your reports" to the person’s own history', async () => {
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Your reports' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/feedback-requests' });
  });

  it('opens the docs', async () => {
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Documentation' }));
    expect(openLink).toHaveBeenCalledWith('https://dorkos.ai/docs');
  });
});
