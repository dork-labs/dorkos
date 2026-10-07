// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BanDialog, BAN_REASON_MAX, LiftBanDialog } from '../components/BanDialogs.js';

afterEach(cleanup);

describe('the ban dialogs', () => {
  it('bans with a trimmed reason, counts it, and caps it at what the server keeps', () => {
    // Purpose: fails if the reason is not trimmed, not optional, or can outgrow the server's limit.
    const onBan = vi.fn();
    render(<BanDialog name="Sam" busy={false} onBan={onBan} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Ban Sam?' })).toBeTruthy();
    const reason = screen.getByLabelText('Reason (optional)') as HTMLTextAreaElement;
    expect(reason.maxLength).toBe(BAN_REASON_MAX);
    fireEvent.change(reason, { target: { value: '  Spam  ' } });
    expect(screen.getByText(/^8\/500/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    expect(onBan).toHaveBeenCalledWith('Spam');
    fireEvent.change(reason, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    expect(onBan).toHaveBeenLastCalledWith(undefined);
  });

  it('closes without banning on Cancel or Escape', () => {
    const onBan = vi.fn();
    const onClose = vi.fn();
    render(<BanDialog name="Sam" busy={false} onBan={onBan} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onBan).not.toHaveBeenCalled();
  });

  it('lifts a ban only on its confirm button', () => {
    const onLift = vi.fn();
    render(<LiftBanDialog name="Sam" busy={false} onLift={onLift} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Lift the ban on Sam?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lift ban' }));
    expect(onLift).toHaveBeenCalledTimes(1);
  });
});
