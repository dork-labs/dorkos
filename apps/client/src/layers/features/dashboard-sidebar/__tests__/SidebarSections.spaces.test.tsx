// @vitest-environment jsdom
/**
 * Whether a space's channels take the panel over (DOR-2740).
 *
 * On a space's address the panel draws that space's channels instead of this
 * machine's sections, but only while the spaces experiment is on. Spaces ship
 * off, so a `?community=` address left in a tab must leave the local panel in
 * place. Fails if `SidebarSections` stops reading the switch.
 *
 * @module features/dashboard-sidebar/__tests__/SidebarSections.spaces
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { commitCommunityRouteEpoch } from '@/layers/shared/model';

const spaces = vi.hoisted(() => ({ on: false }));
const prefsWrites = vi.hoisted(() => ({
  update: vi.fn((updater: (prev: unknown) => unknown) => updater({})),
  setSectionCollapsed: vi.fn((prefs: unknown) => prefs),
}));

// A settled panel, so these cases are about the switch rather than the boot gate.
vi.mock('../model/boot/use-boot-state', () => ({
  useBootState: () => ({ phase: 'settled', settled: true, fleetKnown: true, startedWarm: false }),
}));
vi.mock('@/layers/entities/config', () => ({
  useUpdateSidebarPrefs: () => ({ update: prefsWrites.update }),
  setSectionCollapsed: prefsWrites.setSectionCollapsed,
  setGroupCollapsed: (prefs: unknown) => prefs,
}));
// Whether the route's space may show: the experiment alone here, since no official space is
// named (spec `official-community-space` D5; `use-space-visible.test.tsx` covers that rule).
vi.mock('@/layers/entities/community', () => ({
  useSpaceVisible: (ref: string | undefined) => ({
    visible: spaces.on && ref !== undefined,
    isLoading: false,
  }),
}));
// The space's channels have their own transport-backed tests; here only whether
// they are drawn matters.
vi.mock('../ui/CommunityChannelGroups', () => ({
  CommunityChannelGroups: () => <div data-testid="space-channels" />,
}));

// The row chrome is a provider with queries of its own; here only what is open
// matters, and nothing is.
vi.mock('../ui/SidebarChrome', () => ({
  useSidebarChrome: () => ({ activeTarget: null, groupCreation: null }),
}));

// A section's own rendering has its own tests; here only which sections the
// space view draws, and what Alt-click on one of them folds, matter.
vi.mock('../ui/SidebarSection', () => ({
  SidebarSection: ({
    section,
    onToggleAll,
  }: {
    section: { id: string };
    onToggleAll: () => void;
  }) => (
    <button type="button" data-testid={`section-${section.id}`} onClick={onToggleAll}>
      {section.id}
    </button>
  ),
}));

import { buildSidebarModel } from '../model/build-sidebar-model';
import { addOn, busyFixture } from '../model/fixtures';
import { SidebarSections } from '../ui/SidebarSections';

const MODEL = buildSidebarModel(busyFixture);

/** A real model holding an Add-ons section, beside Channels and the rest. */
const WITH_ADD_ONS = buildSidebarModel({ ...busyFixture, addOns: [addOn('flow', '', 'Flow')] });

afterEach(() => {
  cleanup();
  spaces.on = false;
  commitCommunityRouteEpoch('installation');
  prefsWrites.update.mockClear();
  prefsWrites.setSectionCollapsed.mockClear();
});

describe('SidebarSections on a space’s address', () => {
  it('keeps this machine’s panel while spaces are off', () => {
    commitCommunityRouteEpoch(JSON.stringify(['community', 'acme', null, null]));
    const { container } = render(<SidebarSections model={MODEL} />);

    expect(screen.getByTestId('section-channels')).toBeInTheDocument();
    expect(container.querySelector('[data-community-context]')).toBeNull();
    expect(screen.queryByTestId('space-channels')).not.toBeInTheDocument();
  });

  it('draws the space’s channels once spaces are on (the control)', () => {
    spaces.on = true;
    commitCommunityRouteEpoch(JSON.stringify(['community', 'acme', null, null]));
    const { container } = render(<SidebarSections model={MODEL} />);

    expect(container.querySelector('[data-community-context="acme"]')).not.toBeNull();
    expect(screen.getByTestId('space-channels')).toBeInTheDocument();
    expect(screen.queryByTestId('section-channels')).not.toBeInTheDocument();
  });
});

describe('Add-ons inside a space', () => {
  it('stays under the space’s channels, alone of this machine’s sections', () => {
    // A space's channels replace this machine's conversations, not its mini
    // apps: before, the pages were one press away in You whatever the panel
    // showed, so a space hiding them would be a step backwards.
    spaces.on = true;
    commitCommunityRouteEpoch(JSON.stringify(['community', 'acme', null, null]));
    const { container } = render(<SidebarSections model={WITH_ADD_ONS} />);

    const space = container.querySelector('[data-community-context="acme"]');
    expect(space).not.toBeNull();
    const drawn = Array.from(space!.querySelectorAll('[data-testid^="section-"]')).map(
      (el) => el.textContent
    );
    expect(drawn).toEqual(['addons']);
    // Below the channels, not above them.
    expect(
      screen
        .getByTestId('space-channels')
        .compareDocumentPosition(screen.getByTestId('section-addons')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('is absent when no mini app added a page', () => {
    spaces.on = true;
    commitCommunityRouteEpoch(JSON.stringify(['community', 'acme', null, null]));
    render(<SidebarSections model={buildSidebarModel(busyFixture)} />);

    expect(screen.getByTestId('space-channels')).toBeInTheDocument();
    expect(screen.queryByTestId('section-addons')).not.toBeInTheDocument();
  });

  it('folds only itself on Alt-click, the one section of this machine a space shows', () => {
    spaces.on = true;
    commitCommunityRouteEpoch(JSON.stringify(['community', 'acme', null, null]));
    render(<SidebarSections model={WITH_ADD_ONS} />);

    fireEvent.click(screen.getByTestId('section-addons'));
    expect(prefsWrites.setSectionCollapsed).toHaveBeenCalledTimes(1);
    expect(prefsWrites.setSectionCollapsed).toHaveBeenCalledWith({}, 'addons', true);
  });
});
