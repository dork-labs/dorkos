// @vitest-environment jsdom
/**
 * The picker's own contract for `submitDisabled` — the gate a container raises
 * when the rest of its form is not ready.
 *
 * Asserted here rather than only through the channel-create dialog, because the
 * dialog holds a second guard of its own: a test that only drove the dialog
 * stayed green with this one deleted, which is a covered-looking hole rather
 * than coverage. Enter and the button are separate rungs and each is checked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AgentChipPicker } from '../ui/AgentChipPicker';

afterEach(cleanup);

const FLEET = [{ agentPath: '/w/ana', displayName: 'Ana' }];

function renderPicker(submitDisabled: boolean) {
  const onSubmit = vi.fn();
  render(
    <AgentChipPicker
      candidates={FLEET}
      onSubmit={onSubmit}
      submitLabel={() => 'Commit'}
      emptyRosterMessage="No agents."
      allChosenMessage="All chosen."
      submitDisabled={submitDisabled}
    />
  );
  // One chip, so the only thing left standing between Enter and a commit is
  // the gate under test.
  fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: 'Ana' } });
  fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
  return onSubmit;
}

describe('AgentChipPicker submitDisabled', () => {
  it('refuses the KEYBOARD commit, not just the button', () => {
    const onSubmit = renderPicker(true);

    fireEvent.keyDown(screen.getByLabelText('Search agents'), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables the button too', () => {
    renderPicker(true);
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  });

  it('commits on Enter once the gate is lowered', () => {
    // The control: the same gesture, the same one chip, and it goes through —
    // so the two above are the gate biting and not the gesture never working.
    const onSubmit = renderPicker(false);

    fireEvent.keyDown(screen.getByLabelText('Search agents'), { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith([{ agentPath: '/w/ana', displayName: 'Ana' }]);
  });
});
