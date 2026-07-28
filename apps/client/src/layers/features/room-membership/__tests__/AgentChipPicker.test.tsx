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

const FLEET = [
  { agentPath: '/w/ana', displayName: 'Ana' },
  { agentPath: '/w/bo', displayName: 'Bo' },
];

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

/** The picker with nothing chosen and nothing typed, ready for a key. */
function renderFresh(candidates = FLEET) {
  const onSubmit = vi.fn();
  render(
    <AgentChipPicker
      candidates={candidates}
      onSubmit={onSubmit}
      submitLabel={() => 'Commit'}
      emptyRosterMessage="No agents."
      allChosenMessage="All chosen."
    />
  );
  return { onSubmit, field: () => screen.getByLabelText('Search agents') };
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

/**
 * Enter belongs to the keyboard, and a hovered row is not the keyboard.
 *
 * The trap this closes: assembling a selection by clicking leaves the cursor
 * resting on whichever agent slid up into the vacated row, so the next Enter —
 * the one a reader presses to finish — used to ADD that agent instead of
 * committing. jsdom is where this is testable at all; a screenshot cannot show
 * where a cursor is.
 */
describe('AgentChipPicker Enter and the pointer', () => {
  it('commits when Enter follows a HOVER, rather than adding the hovered agent', () => {
    const { onSubmit, field } = renderFresh();

    // Assemble by pointer, the way the trap is reached.
    fireEvent.change(field(), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    // The cursor is now resting on whoever took the vacated row.
    fireEvent.mouseEnter(screen.getByRole('option', { name: 'Bo' }));
    fireEvent.keyDown(field(), { key: 'Enter' });

    // Ana alone, and Bo is NOT along for the ride.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith([{ agentPath: '/w/ana', displayName: 'Ana' }]);
  });

  it('still adds when Enter follows an ARROW key', () => {
    const { onSubmit, field } = renderFresh();

    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'Enter' });

    // Added, not committed: one chip and nothing submitted yet.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove Ana' })).toBeInTheDocument();
  });

  it('lets an arrow key take the highlight back off the pointer', () => {
    const { onSubmit, field } = renderFresh();

    // Hover Bo, then steer with the keyboard: the aim is the reader's again.
    fireEvent.mouseEnter(screen.getByRole('option', { name: 'Bo' }));
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Remove / })).toBeInTheDocument();
  });

  it('still adds the first match when Enter follows TYPING', () => {
    const { onSubmit, field } = renderFresh();

    fireEvent.change(field(), { target: { value: 'Bo' } });
    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove Bo' })).toBeInTheDocument();
  });

  it('stays inert when a query matches nobody', () => {
    const { onSubmit, field } = renderFresh();

    fireEvent.change(field(), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    // Reaching for Bo and mistyping. Enter here must not throw Ana away.
    fireEvent.change(field(), { target: { value: 'Boo' } });
    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove Ana' })).toBeInTheDocument();
  });
});
