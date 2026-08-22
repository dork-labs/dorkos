// @vitest-environment jsdom
/**
 * What a section hands its rows to animate against, and what leaves it alone
 * (spec `sidebar-simplification` D5 (c)).
 *
 * **The property is that the 60 s clock tick moves nothing.** `useSidebarState`
 * rebuilds the whole model every minute so relative times stay honest — every
 * row object is new, every label may be new — and a `layout` FLIP that
 * re-measured on that would have thirty rows re-animating once a minute for a
 * change nobody can see as movement. `sectionLayoutKey` is what makes it not,
 * and this file pins the WIRING: that the key actually reaches the rows, and
 * that it is the section's own list rather than the panel's.
 *
 * It reads the props the section hands down, which is the honest instrument
 * here: jsdom runs no animation and reports no geometry, so nothing about the
 * FLIP itself is observable in this environment. The other half — that a row
 * handed unchanged props does not re-render — is measured against the REAL
 * memoized row in `RoomRow.render-count.test.tsx`.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SidebarRowMotion } from '@/layers/shared/ui';
import { buildSidebarModel, type SidebarSectionModel } from '../model/build-sidebar-model';
import { powerFixture } from '../model/fixtures';
import { sectionLayoutKey } from '../ui/motion/sidebar-motion';

/** What every row this section drew was handed, in order. */
const { handed } = vi.hoisted(() => ({
  handed: { current: [] as { title: string; motion: SidebarRowMotion }[] },
}));

/**
 * The row, stood in for.
 *
 * `RoomRow` is the component `SidebarModelRow` reaches for a channel, and it
 * passes `rowMotion` straight through to `SidebarRow`. Recording it here reads
 * the object at the last point it is still one thing rather than nine props on
 * an `<li>`.
 */
vi.mock('../ui/rooms/RoomRow', () => ({
  RoomRow: ({ room, rowMotion }: { room: { id: string }; rowMotion: SidebarRowMotion }) => {
    handed.current.push({ title: room.id, motion: rowMotion });
    return <li data-testid={room.id} />;
  },
}));

/** The panel-wide chrome, reduced to what a section and its rows read. */
const CHROME = {
  roomsById: new Map<string, { id: string }>(),
  roomVisualOf: () => ({ kind: 'sigil' }),
  mutedRoomIds: new Set<string>(),
  roomSectionIds: new Map<string, string>(),
  moveTargetGroups: [],
  viewProfileFor: () => () => {},
  requestNewGroup: () => {},
  openTarget: () => {},
  activeTarget: null,
  homeRoomId: null,
  manifests: {},
  bootSettled: true,
};
vi.mock('../ui/SidebarChrome', () => ({ useSidebarChrome: () => CHROME }));

/** The section's own chrome, which this file is not about. */
vi.mock('../ui/useSectionChrome', () => ({
  useSectionChrome: () => ({
    menuNodes: [],
    hasSectionAction: false,
    toggleCollapsed: () => {},
  }),
}));

const { SidebarSection } = await import('../ui/SidebarSection');

afterEach(() => {
  handed.current = [];
  cleanup();
});

/**
 * The Direct messages section of a real build, with every one of its rooms in
 * the chrome index so the rows draw.
 *
 * A real `buildSidebarModel` rather than a hand-made section: the claim is about
 * what a REBUILD does, and a fixture section written by hand would be two
 * objects this file decided were "the same" rather than two the builder decided.
 *
 * Direct messages and not Channels, for one reason worth knowing: the power
 * fixture folds Channels, and a folded section unmounts its rows — the test
 * would have measured an empty list and passed. `rows > 1` below is what says so
 * out loud.
 */
function directMessagesAt(now: number): SidebarSectionModel {
  const model = buildSidebarModel({ ...powerFixture, now });
  const section = model.zones.flatMap((zone) => zone.sections).find((entry) => entry.id === 'dms');
  if (section === undefined) throw new Error('the power fixture has no Direct messages section');
  for (const modelRow of section.rows) {
    if (modelRow.target.kind === 'room') {
      CHROME.roomsById.set(modelRow.target.roomId, { id: modelRow.target.roomId });
    }
  }
  return section;
}

describe('a section’s layout key', () => {
  it('reaches every row, and is the section’s own list', () => {
    const section = directMessagesAt(powerFixture.now);
    render(<SidebarSection section={section} onToggleAll={() => {}} />);

    expect(handed.current.length).toBeGreaterThan(1);
    const expected = sectionLayoutKey(section.rows);
    for (const entry of handed.current) {
      expect(entry.motion.layout).toBe(true);
      // Scoped per section (D5): the whole panel's rows would be a longer
      // string, and a row arriving in Today would re-measure every channel.
      expect(entry.motion.layoutDependency).toBe(expected);
    }
  });

  it('does not move when only the clock does', () => {
    const before = directMessagesAt(powerFixture.now);
    const { rerender } = render(<SidebarSection section={before} onToggleAll={() => {}} />);
    const first = handed.current.map((entry) => entry.motion);
    handed.current = [];

    // The 60 s tick: a whole new model, every row object fresh.
    const after = directMessagesAt(powerFixture.now + 60_000);
    expect(after).not.toBe(before);
    rerender(<SidebarSection section={after} onToggleAll={() => {}} />);

    const second = handed.current.map((entry) => entry.motion);
    expect(second).toHaveLength(first.length);
    second.forEach((motion, at) => {
      expect(motion.layoutDependency).toBe(first[at]?.layoutDependency);
      // The whole object, not just the key: it is one prop of a memoized row, so
      // a fresh copy carrying the same values still re-renders every room in the
      // panel. `RoomRow.render-count.test.tsx` measures that end; this measures
      // the identity it depends on.
      expect(motion).toBe(first[at]);
    });
  });
});
