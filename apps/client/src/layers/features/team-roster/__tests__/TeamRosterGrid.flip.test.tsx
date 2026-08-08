/**
 * @vitest-environment jsdom
 *
 * The roster's layout animation, as far as jsdom can honestly see it.
 *
 * **It cannot see the animation.** `test-setup.ts` strips `layout`, `layoutId`,
 * `initial`, `animate`, `exit` and `transition` from every `motion.*` component
 * before they reach the DOM, so a test that appeared to assert one would be
 * asserting nothing (design spec §4.3). The travel itself is browser work.
 *
 * What *is* assertable is the gate: the grid reports `data-layout-animated`
 * from the same boolean it passes to every card, so this file checks that the
 * root's claim and the cards' behaviour cannot drift apart, and that the count
 * threshold flips it. The rule itself — including the reduced-motion half — is
 * tested at full strength on the pure function in `roster-layout.test.ts`, and
 * the wiring of that half is the last test here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { ROSTER_LAYOUT_LIMIT } from '../lib/roster-layout';
import { TeamRosterGrid } from '../ui/TeamRosterGrid';

const TEMPLATE = MOCK_TEAM_ROSTER.find((member) => member.kind === 'agent')!;

/** A roster of `count` distinct agents — distinct ids, because `layoutId` is one. */
function rosterOf(count: number): TeamMember[] {
  return Array.from({ length: count }, (_, index) => ({
    ...TEMPLATE,
    id: `agent-${index}`,
    displayName: `Agent ${index}`,
    handle: `agent${index}`,
  }));
}

const gridRoot = () =>
  document.querySelector('[data-slot="team-roster-grid"],[data-slot="team-roster-groups"]');

const cards = () => Array.from(document.querySelectorAll('[data-slot="team-member-card"]'));

afterEach(cleanup);

describe('the roster FLIP gate', () => {
  it('arms layout animation for a roster small enough to stay calm', () => {
    const members = rosterOf(3);
    render(<TeamRosterGrid members={members} roster={members} grouped={false} />);
    expect(gridRoot()).toHaveAttribute('data-layout-animated', 'true');
  });

  it('disarms it past the card limit', () => {
    const members = rosterOf(ROSTER_LAYOUT_LIMIT + 1);
    render(<TeamRosterGrid members={members} roster={members} grouped={false} />);
    expect(gridRoot()).toHaveAttribute('data-layout-animated', 'false');
  });

  it('arms it at exactly the limit — the boundary, from both sides', () => {
    const members = rosterOf(ROSTER_LAYOUT_LIMIT);
    render(<TeamRosterGrid members={members} roster={members} grouped={false} />);
    expect(gridRoot()).toHaveAttribute('data-layout-animated', 'true');
  });

  it('tells every card what the root claims, so the attribute cannot lie', () => {
    // The drift this closes: a grid that reported `true` while forgetting to
    // pass the prop would animate nothing and say nothing was wrong. Both
    // values come from one boolean, and this is the only place jsdom can see
    // that they still do.
    const members = rosterOf(4);
    render(<TeamRosterGrid members={members} roster={members} grouped={false} />);

    expect(cards()).toHaveLength(4);
    for (const card of cards()) {
      expect(card).toHaveAttribute('data-layout-animated', 'true');
    }
  });

  it('disarms the cards too when the roster is too big', () => {
    const members = rosterOf(ROSTER_LAYOUT_LIMIT + 1);
    render(<TeamRosterGrid members={members} roster={members} grouped={false} />);
    expect(cards()[0]).toHaveAttribute('data-layout-animated', 'false');
  });

  it('keeps every card a direct child of the one grid, grouped or not', () => {
    // **The structural decision the travel depends on**, and the only part of
    // it jsdom can hold onto.
    //
    // A card animates to a new position only if it survives the change as the
    // same component instance. Wrapping each cluster in its own `<section>` and
    // nested grid — which this drew before — unmounts every card from one
    // parent and mounts it under another, and the group toggle goes back to
    // teleporting. Measured in a browser both ways.
    //
    // The spec's alternative, `layoutId`, does survive a change of parent, and
    // was tried: it stops surviving cards animating at all, and leaves exiting
    // ones in the DOM forever. See `TeamMemberCard`'s `LAYOUT_MOTION`.
    const owner = MOCK_TEAM_ROSTER.find((member) => member.id === 'person-dorian')!;
    const owned = MOCK_TEAM_ROSTER.filter((member) => member.ownerId === owner.id);

    const { rerender } = render(
      <TeamRosterGrid members={owned} roster={MOCK_TEAM_ROSTER} grouped={false} />
    );
    const flatParents = new Set([...cards()].map((card) => card.parentElement));
    expect(flatParents.size).toBe(1);

    rerender(<TeamRosterGrid members={owned} roster={MOCK_TEAM_ROSTER} grouped />);
    const groupedRoot = document.querySelector('[data-slot="team-roster-groups"]');
    expect(cards().length).toBeGreaterThan(0);
    for (const card of cards()) {
      expect(
        card.parentElement,
        'a card nested inside a per-cluster wrapper cannot travel — it is a new instance'
      ).toBe(groupedRoot);
    }
    // The cluster headings are siblings of the cards, spanning the grid row.
    for (const heading of groupedRoot!.querySelectorAll('h2')) {
      expect(heading.parentElement).toBe(groupedRoot);
      expect(heading.className).toContain('col-span-full');
    }
  });

  it('arms the grouped branch on the same boolean', () => {
    // The group toggle is the hero case for the travel, so the clustered tree
    // must not be the one that quietly opted out.
    const owner = MOCK_TEAM_ROSTER.find((member) => member.id === 'person-dorian')!;
    const owned = MOCK_TEAM_ROSTER.filter((member) => member.ownerId === owner.id);
    render(<TeamRosterGrid members={owned} roster={[owner, ...owned]} grouped />);

    expect(document.querySelector('[data-slot="team-roster-groups"]')).toHaveAttribute(
      'data-layout-animated',
      'true'
    );
  });
});
