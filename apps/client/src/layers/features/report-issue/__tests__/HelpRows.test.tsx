// @vitest-environment jsdom
/**
 * Help and feedback as rows (DOR-2232): the phone's one visible way to send
 * feedback, the same three actions as the desktop menu.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFeedbackDialogStore } from '@/layers/shared/model';
import { HelpRows } from '../ui/HelpRows';

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

describe('HelpRows', () => {
  it('draws the three actions as buttons in the caller’s row shape', () => {
    render(<HelpRows rowClassName="row-shape" />);
    const group = screen.getByRole('group', { name: 'Help and feedback' });
    const rows = within(group).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Send feedback…',
      'Your reports',
      'Documentation',
    ]);
    for (const row of rows) expect(row).toHaveClass('row-shape');
  });

  it('does what the menu rows do', async () => {
    const user = userEvent.setup();
    render(<HelpRows />);
    await user.click(screen.getByRole('button', { name: 'Send feedback…' }));
    expect(useFeedbackDialogStore.getState().open).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Your reports' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/feedback-requests' });
    await user.click(screen.getByRole('button', { name: 'Documentation' }));
    expect(openLink).toHaveBeenCalledWith('https://dorkos.ai/docs');
  });
});
