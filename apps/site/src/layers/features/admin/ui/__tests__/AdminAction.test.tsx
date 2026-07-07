/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

import { AdminAction } from '../AdminAction';

/** Open the dialog by clicking the named trigger and wait for its confirm button. */
async function openDialog(triggerLabel: string, confirmLabel: string): Promise<HTMLButtonElement> {
  fireEvent.click(screen.getByRole('button', { name: triggerLabel }));
  return (await screen.findByRole('button', { name: confirmLabel })) as HTMLButtonElement;
}

describe('AdminAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps confirm disabled until the typed value matches, then runs and refreshes', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ error: null });
    render(
      <AdminAction
        label="Delete"
        title="Delete kai@dork.test?"
        description="Irreversible."
        confirmLabel="Delete account"
        variant="destructive"
        typedConfirm="kai@dork.test"
        onConfirm={onConfirm}
      />
    );

    const confirm = await openDialog('Delete', 'Delete account');
    // Gated: nothing typed yet.
    expect(confirm.disabled).toBe(true);

    const input = screen.getByPlaceholderText('kai@dork.test');
    // A wrong value keeps it disabled.
    fireEvent.change(input, { target: { value: 'nope' } });
    expect(confirm.disabled).toBe(true);

    // The matching value (case-insensitive) enables confirm.
    fireEvent.change(input, { target: { value: 'KAI@DORK.TEST' } });
    await waitFor(() => expect(confirm.disabled).toBe(false));

    fireEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    // No free-text field on this action, so onConfirm gets an empty string.
    expect(onConfirm).toHaveBeenCalledWith('');
    // Success refreshes the route so the table reflects the change.
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    // And the dialog closes.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Delete account' })).toBeNull()
    );
  });

  it('surfaces the error, keeps the dialog open, and stays retryable on failure', async () => {
    const onConfirm = vi
      .fn()
      .mockResolvedValueOnce({ error: { message: 'That action failed spectacularly' } })
      .mockResolvedValueOnce({ error: null });
    render(
      <AdminAction
        label="Ban user"
        title="Ban kai@dork.test?"
        description="Blocks sign-in."
        confirmLabel="Ban"
        onConfirm={onConfirm}
      />
    );

    // No typedConfirm, so confirm is enabled immediately after opening. The
    // trigger label differs from the confirm label so each is addressable.
    const confirm = await openDialog('Ban user', 'Ban');
    fireEvent.click(confirm);

    // The error message renders and the dialog is still open (title present).
    expect(await screen.findByText('That action failed spectacularly')).toBeTruthy();
    expect(screen.getByText('Ban kai@dork.test?')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();

    // The dialog is still usable — a second attempt succeeds and refreshes.
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('passes the collected free-text field value to onConfirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ error: null });
    render(
      <AdminAction
        label="Ban user"
        title="Ban kai@dork.test?"
        description="Blocks sign-in."
        confirmLabel="Ban"
        field={{ label: 'Reason (optional)', placeholder: 'e.g. terms violation' }}
        onConfirm={onConfirm}
      />
    );

    await openDialog('Ban user', 'Ban');
    fireEvent.change(screen.getByPlaceholderText('e.g. terms violation'), {
      target: { value: '  abuse  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));

    // The field value is trimmed before it reaches the action.
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('abuse'));
  });
});
