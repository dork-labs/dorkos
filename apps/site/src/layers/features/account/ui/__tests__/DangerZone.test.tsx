/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-client', () => ({ requestAccountDeletion: vi.fn() }));

import { DangerZone } from '../DangerZone';

const EMAIL = 'kai' + '@' + 'dork.test';

describe('DangerZone', () => {
  it('says a confirmed deletion is waiting, and to request it again from here', () => {
    render(<DangerZone email={EMAIL} deletionPostponed />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain("Your account hasn't been deleted yet.");
    expect(status.textContent).toContain('request deletion again from this page');
    expect(status.textContent).not.toMatch(/try again/i);
    // The way to request it again is right there.
    expect(screen.getByText('Delete my account')).toBeTruthy();
  });

  it('shows no deletion notice otherwise', () => {
    render(<DangerZone email={EMAIL} />);

    expect(screen.queryByRole('status')).toBeNull();
  });
});
