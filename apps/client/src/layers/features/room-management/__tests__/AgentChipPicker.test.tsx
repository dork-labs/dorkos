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

/**
 * Three agents where the query `a` matches TWO of them (Ana, Kai) and not Bo.
 * That is what lets a test type a query and hover a different match at the same
 * time — the state the announced/added desync lived in.
 */
const TRIO = [...FLEET, { agentPath: '/w/kai', displayName: 'Kai' }];

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
 * What is announced is what Enter does.
 *
 * This is the actual property, asserted as an invariant rather than as a list
 * of cases — the defect it exists against was found by combining a query with a
 * hover, which is a state nobody thought to write a case for. The invariant
 * catches that combination and every other one without anybody having to
 * imagine it.
 *
 * The trap underneath: assembling a selection by clicking leaves the cursor
 * resting on whichever agent slid up into the vacated row, so the Enter a
 * reader presses to finish used to add that agent instead of committing.
 */
describe('AgentChipPicker: the announced row IS the Enter target', () => {
  /** The option `aria-activedescendant` names, or null when nothing is announced. */
  function announced(): string | null {
    const field = screen.getByLabelText('Search agents');
    const id = field.getAttribute('aria-activedescendant');
    if (!id) return null;
    const el = document.getElementById(id);
    if (!el) throw new Error(`aria-activedescendant points at ${id}, which is not in the document`);
    return el.textContent;
  }

  /** Every option the list currently draws as selected. Must never exceed one. */
  function selectedOptions(): string[] {
    return screen
      .queryAllByRole('option')
      .filter((el) => el.getAttribute('aria-selected') === 'true')
      .map((el) => el.textContent ?? '');
  }

  /**
   * The gestures worth reaching this state through. Each leaves the picker in a
   * different combination of query and highlight — including the one the fix
   * was found by, a live query with the cursor over a DIFFERENT match.
   */
  const GESTURES: Array<{ name: string; drive: (field: HTMLElement) => void }> = [
    { name: 'nothing touched', drive: () => {} },
    {
      name: 'a query typed',
      drive: (field) => fireEvent.change(field, { target: { value: 'a' } }),
    },
    {
      name: 'arrowed down once',
      drive: (field) => fireEvent.keyDown(field, { key: 'ArrowDown' }),
    },
    {
      name: 'arrowed down twice',
      drive: (field) => {
        fireEvent.keyDown(field, { key: 'ArrowDown' });
        fireEvent.keyDown(field, { key: 'ArrowDown' });
      },
    },
    {
      name: 'hovered a row',
      drive: () => fireEvent.mouseEnter(screen.getByRole('option', { name: 'Bo' })),
    },
    {
      name: 'a query typed AND a different match hovered',
      drive: (field) => {
        // The state the desynchronised version got wrong: it announced Bo and
        // added Ana. Reached only by hovering WITHOUT clicking, which is why
        // every earlier test walked past it.
        fireEvent.change(field, { target: { value: 'a' } });
        fireEvent.mouseEnter(screen.getByRole('option', { name: 'Kai' }));
      },
    },
    {
      name: 'arrowed, then a different row hovered',
      drive: (field) => {
        fireEvent.keyDown(field, { key: 'ArrowDown' });
        fireEvent.mouseEnter(screen.getByRole('option', { name: 'Kai' }));
      },
    },
  ];

  it.each(GESTURES)('after $name, Enter acts on exactly what was announced', ({ drive }) => {
    const { onSubmit, field } = renderFresh(TRIO);
    drive(field());

    // The list may draw at most one selected row, and it must be the announced
    // one — two "highlights" would make the invariant meaningless.
    const announcedRow = announced();
    expect(selectedOptions()).toEqual(announcedRow === null ? [] : [announcedRow]);

    fireEvent.keyDown(field(), { key: 'Enter' });

    if (announcedRow === null) {
      // Nothing announced means nothing to add. Enter either commits (empty
      // field) or is inert (a query nobody matches) — never adds.
      expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    } else {
      // And when something IS announced, Enter adds that one and no other.
      expect(onSubmit).not.toHaveBeenCalled();
      const chips = screen
        .getAllByRole('button', { name: /^Remove / })
        .map((el) => el.getAttribute('aria-label')?.replace('Remove ', ''));
      expect(chips).toEqual([announcedRow]);
    }
  });

  it('commits after a hover, rather than adding the hovered agent', () => {
    // The trap, end to end: assemble by pointer, then finish with the key.
    const { onSubmit, field } = renderFresh(TRIO);

    fireEvent.change(field(), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    // The cursor is now resting on whoever took the vacated row.
    fireEvent.mouseEnter(screen.getByRole('option', { name: 'Bo' }));
    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith([{ agentPath: '/w/ana', displayName: 'Ana' }]);
  });

  it('still adds when Enter follows an ARROW key', () => {
    const { onSubmit, field } = renderFresh(TRIO);

    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove Ana' })).toBeInTheDocument();
  });

  it('still adds the first match when Enter follows TYPING', () => {
    const { onSubmit, field } = renderFresh(TRIO);

    fireEvent.change(field(), { target: { value: 'Bo' } });
    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove Bo' })).toBeInTheDocument();
  });

  it('stays inert when a query matches nobody', () => {
    const { onSubmit, field } = renderFresh(TRIO);

    fireEvent.change(field(), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    // Reaching for Bo and mistyping. Enter here must not throw Ana away.
    fireEvent.change(field(), { target: { value: 'Boo' } });
    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove Ana' })).toBeInTheDocument();
  });
});
