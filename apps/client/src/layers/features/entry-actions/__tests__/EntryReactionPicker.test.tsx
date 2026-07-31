// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { EntryReactionGrid } from '../ui/EntryReactionPicker';

/** The shipped quick row, which repeats emoji the catalog below also holds. */
const FREQUENTS = ['👍', '❤️', '🎉'];

afterEach(cleanup);

function renderGrid(onPick: (emoji: string) => void = () => {}, disabled?: boolean) {
  return render(
    <EntryReactionGrid mine={[]} frequents={FREQUENTS} onPick={onPick} disabled={disabled} />
  );
}

describe('EntryReactionGrid — the picker body', () => {
  it('names every group it draws', () => {
    // The wiring the uniqueness below rests on. `role="group"` is explicit, so
    // the groups exist either way; what `aria-labelledby` buys is the NAME, and
    // without it every one of them is anonymous.
    renderGrid();
    const groups = screen.getAllByRole('group');

    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group).toHaveAccessibleName();
    }
    // The first is the reader's own row, and the rest are the catalog's.
    expect(groups[0]).toHaveAccessibleName('Your most used');
  });

  it('draws duplicate buttons, and makes each one uniquely addressable anyway', () => {
    // Non-vacuous by construction: the quick row exists to repeat the emoji a
    // person reaches for most, so the open picker HAS duplicate button names.
    // That is not a defect to remove — it is the reason the groups need names.
    renderGrid();
    const groups = screen.getAllByRole('group');

    const pairs = groups.flatMap((group) => {
      // Resolved THROUGH `aria-labelledby` rather than by reading the heading
      // that happens to sit inside, so this assertion fails on its own when the
      // wiring goes — rather than leaning on the test above to catch it.
      const labelId = group.getAttribute('aria-labelledby');
      const name = labelId === null ? null : document.getElementById(labelId)?.textContent;
      return within(group)
        .getAllByRole('button')
        .map((button) => `${name} → ${button.getAttribute('aria-label')}`);
    });

    // The duplicates are real: three buttons share a name with three others.
    const bare = groups.flatMap((group) =>
      within(group)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    );
    expect(bare.length - new Set(bare).size).toBe(FREQUENTS.length);

    // And every one of them is still reachable on its own, because the group it
    // sits in is part of how it is named.
    expect(pairs).toHaveLength(new Set(pairs).size);
  });

  it('drops the groups while searching, where nothing repeats', () => {
    // Search runs over the flat catalog, which holds each emoji once — so the
    // results need no grouping to stay unambiguous, and eleven headings over
    // four matches would be noise.
    renderGrid();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search emoji' }), {
      target: { value: 'rocket' },
    });

    expect(screen.queryAllByRole('group')).toHaveLength(0);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'rocket' })).toBeInTheDocument();
  });

  it('says so when a search matches nothing', () => {
    renderGrid();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search emoji' }), {
      target: { value: 'zzzz' },
    });

    expect(screen.getByText('Nothing here matches that.')).toBeInTheDocument();
  });

  it('refuses every option when the room has stopped listening, and says why', () => {
    // The §4 stall doctrine reaches the OPEN picker too. Every other reaction
    // control — the pills, the ghost +, the capsule's quick row — refuses the
    // press once the stream has given up, and a grid that still took one would
    // be the single surface in the feature that accepts a write whose answer is
    // never coming back.
    const onPick = vi.fn();
    renderGrid(onPick, true);

    const options = screen
      .getAllByRole('group')
      .flatMap((group) => within(group).getAllByRole('button'));
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option).toBeDisabled();
    }

    fireEvent.click(options[0]!);
    expect(onPick).not.toHaveBeenCalled();

    // Refusing silently would read as a broken grid. It says what is wrong in
    // the same voice the room's own notice uses.
    expect(screen.getByText(/reconnects/i)).toBeInTheDocument();
  });

  it('still lets you look around while it cannot be acted on', () => {
    // Search stays live on purpose: browsing costs the server nothing, and a
    // field that also went dead would make the surface read as broken rather
    // than as paused.
    renderGrid(() => {}, true);

    const search = screen.getByRole('textbox', { name: 'Search emoji' });
    expect(search).toBeEnabled();
    fireEvent.change(search, { target: { value: 'rocket' } });

    expect(screen.getByRole('button', { name: 'rocket' })).toBeDisabled();
  });

  it('hands the picked emoji back, not its name', () => {
    const onPick = vi.fn();
    renderGrid(onPick);

    fireEvent.click(within(screen.getAllByRole('group')[0]!).getAllByRole('button')[0]!);

    expect(onPick).toHaveBeenCalledWith('👍');
  });
});
