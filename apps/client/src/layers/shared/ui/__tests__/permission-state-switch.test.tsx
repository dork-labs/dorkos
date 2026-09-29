/**
 * @vitest-environment jsdom
 */
/**
 * The three-way permission switch: three states, two on a floor area, arrow
 * keys that move between them, and a change reported once.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { PermissionStateSwitch } from '../permission-state-switch';

afterEach(() => cleanup());

describe('PermissionStateSwitch', () => {
  it('offers Blocked, Ask and Allowed, strictest first, as a radiogroup', () => {
    render(<PermissionStateSwitch value="ask" onChange={() => {}} aria-label="Rooms" />);
    expect(screen.getByRole('radiogroup', { name: 'Rooms' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'Blocked',
      'Ask',
      'Allowed',
    ]);
    expect(screen.getByRole('radio', { name: 'Ask' })).toBeChecked();
  });

  it('offers only Blocked and Ask on a floor area', () => {
    render(<PermissionStateSwitch value="ask" onChange={() => {}} floor aria-label="Reach" />);
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Blocked', 'Ask']);
  });

  it('reports the state a person picks', () => {
    const onChange = vi.fn();
    render(<PermissionStateSwitch value="ask" onChange={onChange} aria-label="Rooms" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Allowed' }));
    expect(onChange).toHaveBeenCalledWith('allowed');
  });

  it('moves with the arrow keys', async () => {
    const onChange = vi.fn();
    render(<PermissionStateSwitch value="ask" onChange={onChange} aria-label="Rooms" />);
    await userEvent.tab();
    // Held, not tapped: Radix selects the newly focused segment only while the
    // arrow key is still down (see trust-dial.test.tsx for the full reason).
    await userEvent.keyboard('{ArrowRight>}');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('allowed'));
  });
});
