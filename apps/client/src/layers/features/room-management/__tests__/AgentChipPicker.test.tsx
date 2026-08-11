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
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import { AgentChipPicker } from '../ui/AgentChipPicker';

afterEach(cleanup);

const FLEET: AgentPickerCandidate[] = [
  {
    agentPath: '/w/ana',
    displayName: 'Ana',
    visual: { color: '#6366f1', emoji: '🔍' },
    description: null,
  },
  { agentPath: '/w/bo', displayName: 'Bo', visual: null, description: null },
];

/**
 * Three agents where the query `a` matches TWO of them (Ana, Kai) and not Bo.
 * That is what lets a test type a query and hover a different match at the same
 * time — the state the announced/added desync lived in.
 */
const TRIO: AgentPickerCandidate[] = [
  ...FLEET,
  { agentPath: '/w/kai', displayName: 'Kai', visual: null, description: null },
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

describe('AgentChipPicker faces', () => {
  it('draws the agent’s own face, and a letter for one it could not resolve', () => {
    // The list used to be plain text — every project folder you own, in
    // alphabetical order, with no faces at all, while a picker ten directories
    // away drew the same agents WITH them. A face that could not be resolved
    // draws a letter rather than a hashed one, and that survives DOR-1122
    // letting /team hash an icon-less agent's emoji: /team hashes a real
    // manifest id, where an unresolved candidate here has no manifest at all.
    // The only handle left is the directory, and hashing that invents a face
    // matching nothing — see `AgentPickerCandidate.visual`.
    renderFresh();

    expect(within(screen.getByRole('option', { name: 'Ana' })).getByText('🔍')).toBeInTheDocument();
    expect(within(screen.getByRole('option', { name: 'Bo' })).getByText('B')).toBeInTheDocument();
  });

  it('keeps the face out of what a screen reader announces for the row', () => {
    // An emoji has a spoken name nobody asked to hear, and the row is picked by
    // agent name. The option's accessible name must stay the name alone.
    renderFresh();

    expect(screen.getByRole('option', { name: 'Ana' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '🔍 Ana' })).not.toBeInTheDocument();
  });

  it('draws the square agent silhouette every other agent surface uses, with no Bot badge', () => {
    // This list used to draw the round, tinted default — the exact silhouette
    // a person gets — with no `kind` at all. `kind="agent"` fixes the shape;
    // `badge={null}` is the deliberate, visible opt-out from the glyph `kind`
    // would otherwise add on every identical row.
    renderFresh();

    const disc = within(screen.getByRole('option', { name: 'Ana' })).getByText('🔍')
      .parentElement as HTMLElement;

    expect(disc).toHaveAttribute('data-slot', 'identity-avatar');
    expect(disc).not.toHaveClass('rounded-full');
    expect(disc.querySelector('.lucide-bot')).toBeNull();
  });

  it('tints the unresolved-agent disc rather than filling it solid with currentColor', () => {
    // `kind="agent"` defaults to `variant="fill"`, which sets BOTH the disc's
    // background AND the fallback letter's own text colour from `color`.
    // Filled with the literal string `currentColor`, the letter's colour
    // resolves to whatever `currentColor` had *already become* — its own
    // just-written value — so the letter paints itself invisible on its own
    // background (browser-verified; jsdom cannot see this). The explicit
    // `variant="tint"` override for the no-visual fallback is what keeps this
    // disc legible.
    renderFresh();

    const disc = within(screen.getByRole('option', { name: 'Bo' })).getByText('B')
      .parentElement as HTMLElement;
    const tinted = document.createElement('span');
    tinted.style.backgroundColor = 'color-mix(in oklch, currentColor 18%, transparent)';

    expect(disc.style.backgroundColor).toBe(tinted.style.backgroundColor);
    expect(disc.style.backgroundColor).not.toBe('currentcolor');
  });
});

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

    expect(onSubmit).toHaveBeenCalledWith([FLEET[0]]);
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
  /**
   * What a screen reader reads out for a row — its text with the decorative
   * parts left out.
   *
   * Raw `textContent` would pick up the agent's face, which is `aria-hidden`
   * and is not part of what is announced. This invariant is about what the
   * reader is TOLD, so it has to compare the same string.
   */
  function announcedText(el: Element): string {
    const clone = el.cloneNode(true) as HTMLElement;
    for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    return clone.textContent?.trim() ?? '';
  }

  /** The option `aria-activedescendant` names, or null when nothing is announced. */
  function announced(): string | null {
    const field = screen.getByLabelText('Search agents');
    const id = field.getAttribute('aria-activedescendant');
    if (!id) return null;
    const el = document.getElementById(id);
    if (!el) throw new Error(`aria-activedescendant points at ${id}, which is not in the document`);
    return announcedText(el);
  }

  /** Every option the list currently draws as selected. Must never exceed one. */
  function selectedOptions(): string[] {
    return screen
      .queryAllByRole('option')
      .filter((el) => el.getAttribute('aria-selected') === 'true')
      .map(announcedText);
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
    expect(onSubmit).toHaveBeenCalledWith([TRIO[0]]);
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

  describe('the second line', () => {
    /** A fleet where one agent has said what it is for and one has not. */
    const MIXED: AgentPickerCandidate[] = [
      {
        agentPath: '/w/ana',
        displayName: 'Ana',
        visual: null,
        description: 'Reviews pull requests',
      },
      { agentPath: '/w/bo', displayName: 'Bo', visual: null, description: null },
    ];

    it('draws it only for the agent that has something to say', () => {
      // The line that answers "which of these do I want?" — two agents can
      // share a name, and `server (acme)` says which directory without saying
      // what it is FOR. Red if a row grows an empty second line: a column of
      // them pushes the list apart for a value nobody wrote, which is the
      // filler this list was rebuilt to stop being.
      renderFresh(MIXED);

      const line = (name: string) =>
        screen.getByRole('option', { name }).querySelector('[data-slot="candidate-description"]');
      expect(line('Ana')).toHaveTextContent('Reviews pull requests');
      expect(line('Bo')).toBeNull();
    });

    it('keeps the name the name, and makes the line a description', () => {
      // Left to its contents an option announces as "Ana Reviews pull
      // requests" — a name and its own description read as one string, which is
      // what a reader arrows through and what a voice-control user says out
      // loud. Red if the two collapse into each other.
      renderFresh(MIXED);

      const option = screen.getByRole('option', { name: 'Ana' });
      expect(option).toHaveAccessibleName('Ana');
      expect(option).toHaveAccessibleDescription('Reviews pull requests');
      expect(screen.getByRole('option', { name: 'Bo' })).toHaveAccessibleDescription('');
    });
  });
});
