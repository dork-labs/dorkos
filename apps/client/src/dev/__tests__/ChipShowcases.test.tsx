/**
 * Smoke test for the touch-chip showcases.
 *
 * The playground is where a reviewer answers "does the delete chip still get
 * swallowed?", and a showcase that throws answers nothing — it just leaves an
 * empty card nobody reads. This renders the whole set and checks the states the
 * showcases exist to put side by side. Whether the motion *looks* right is a
 * browser question; that every state is on screen to be looked at is this one.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ChipShowcases } from '../showcases/ChipShowcases';
import { SETTLED_PARTS, WORKING_PARTS } from '../showcases/chip-showcase-data';
import { CONVERSATION_SECTIONS } from '../sections/conversation-sections';

describe('ChipShowcases', () => {
  afterEach(() => cleanup());

  it('renders every section the registry advertises under Chips', () => {
    render(<ChipShowcases />);

    const registered = CONVERSATION_SECTIONS.filter((section) => section.category === 'Chips');
    // Six: the verbs live, the verbs settled, failures and tombstones, the
    // pile, the tray, and the whole strip.
    expect(registered).toHaveLength(6);
    for (const section of registered) {
      expect(screen.getByRole('heading', { name: new RegExp(section.title) })).toBeInTheDocument();
    }
  });

  it('shows all seven verbs live, so the signatures can be compared side by side', () => {
    render(<ChipShowcases />);

    const live = screen
      .getAllByTestId('touch-chip')
      .filter((chip) => chip.getAttribute('data-live') === 'true');
    const verbs = new Set(live.map((chip) => chip.getAttribute('data-verb')));

    expect(verbs).toEqual(new Set(['read', 'search', 'edit', 'create', 'delete', 'fetch', 'run']));
  });

  it('shows the same seven settled, with nothing running', () => {
    render(<ChipShowcases />);

    const settled = screen
      .getAllByTestId('touch-chip')
      .filter((chip) => chip.getAttribute('data-live') === 'false');
    const verbs = new Set(settled.map((chip) => chip.getAttribute('data-verb')));

    expect(verbs).toEqual(new Set(['read', 'search', 'edit', 'create', 'delete', 'fetch', 'run']));
  });

  it('lands another chip on the pile on demand, so the wobble can be watched twice', async () => {
    const user = userEvent.setup();
    render(<ChipShowcases />);

    const pile = screen.getAllByTestId('chip-pile')[0];
    expect(within(pile).getByTestId('chip-pile-count')).toHaveTextContent('3');

    await user.click(screen.getByRole('button', { name: 'Land a chip on the pile' }));

    expect(
      within(screen.getAllByTestId('chip-pile')[0]).getByTestId('chip-pile-count')
    ).toHaveTextContent('4');
  });

  it('fills the tray with a roster big enough to need its filters', () => {
    render(<ChipShowcases />);

    const tray = screen.getByTestId('chip-tray');
    // The whole roster, unfiltered: eight files, two searches, a create, a
    // delete, two links, two commands.
    expect(within(tray).getAllByTestId('touch-chip')).toHaveLength(16);
    expect(within(tray).getByTestId('chip-filter-edit')).toBeInTheDocument();
    expect(within(tray).getByTestId('chip-filter-delete')).toBeInTheDocument();
  });

  it('shows the strip both working and finished', () => {
    render(<ChipShowcases />);

    expect(screen.getByTestId('chip-live-row')).toBeInTheDocument();
    expect(screen.getByTestId('chip-summary-read')).toBeInTheDocument();
  });

  it('gives the two side-by-side strips trays of their own', () => {
    // They are the same turn at two moments, so the settled fixture derives
    // from the working one — but a strip files its tray under the turn's first
    // tool id (DOR-827), so shared ids would mean opening one tray opened the
    // other, on one page, in front of the reviewer.
    const working = WORKING_PARTS.filter((part) => part.type === 'tool_call').map(
      (part) => part.toolCallId
    );
    const settled = SETTLED_PARTS.filter((part) => part.type === 'tool_call').map(
      (part) => part.toolCallId
    );

    expect(working).not.toHaveLength(0);
    expect(settled.filter((id) => working.includes(id))).toEqual([]);
  });
});
