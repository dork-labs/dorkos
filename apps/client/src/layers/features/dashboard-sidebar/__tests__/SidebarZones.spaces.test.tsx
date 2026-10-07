// @vitest-environment jsdom
/**
 * Whether a space's channels take the panel over (DOR-2740).
 *
 * On a space's address the panel draws that space's channels instead of this
 * machine's zones, but only while the spaces experiment is on. Spaces ship off,
 * so a `?community=` address left in a tab must leave the local panel in place.
 * Fails if `SidebarZones` stops reading the switch.
 *
 * @module features/dashboard-sidebar/__tests__/SidebarZones.spaces
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { commitCommunityRouteEpoch } from '@/layers/shared/model';

const spaces = vi.hoisted(() => ({ on: false }));

// A settled panel, so these cases are about the switch rather than the boot gate.
vi.mock('../model/boot/use-boot-state', () => ({
  useBootState: () => ({ phase: 'settled', settled: true, fleetKnown: true, startedWarm: false }),
}));
vi.mock('@/layers/entities/config', () => ({
  useUpdateSidebarPrefs: () => ({ update: vi.fn() }),
  setSectionCollapsed: (prefs: unknown) => prefs,
  setGroupCollapsed: (prefs: unknown) => prefs,
  useSpacesEnabled: () => spaces.on,
}));
// The space's channels have their own transport-backed tests; here only whether
// they are drawn matters.
vi.mock('../ui/CommunityChannelGroups', () => ({
  CommunityChannelGroups: () => <div data-testid="space-channels" />,
}));

import { ZONE_LABEL, type SidebarModel } from '../model/build-sidebar-model';
import { SidebarZones } from '../ui/SidebarZones';

const MODEL: SidebarModel = {
  zones: [{ id: 'library', label: ZONE_LABEL.library, sections: [], reason: 'zone:library' }],
};

afterEach(() => {
  cleanup();
  spaces.on = false;
  commitCommunityRouteEpoch('installation');
});

describe('SidebarZones on a space’s address', () => {
  it('keeps this machine’s panel while spaces are off', () => {
    commitCommunityRouteEpoch(JSON.stringify(['community', 'acme', null, null]));
    const { container } = render(<SidebarZones model={MODEL} />);

    expect(container.querySelector('[data-sidebar-zone="library"]')).not.toBeNull();
    expect(container.querySelector('[data-community-context]')).toBeNull();
    expect(screen.queryByTestId('space-channels')).not.toBeInTheDocument();
  });

  it('draws the space’s channels once spaces are on (the control)', () => {
    spaces.on = true;
    commitCommunityRouteEpoch(JSON.stringify(['community', 'acme', null, null]));
    const { container } = render(<SidebarZones model={MODEL} />);

    expect(container.querySelector('[data-community-context="acme"]')).not.toBeNull();
    expect(screen.getByTestId('space-channels')).toBeInTheDocument();
    expect(container.querySelector('[data-sidebar-zone="library"]')).toBeNull();
  });
});
