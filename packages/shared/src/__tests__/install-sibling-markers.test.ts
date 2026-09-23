import { describe, it, expect } from 'vitest';
import {
  isInstallSiblingName,
  MARKETPLACE_INSTALL_SIBLING_MARKERS,
  MARKETPLACE_STAGE_DIR_MARKER,
  MARKETPLACE_UNINSTALL_DIR_MARKER,
} from '../marketplace-schemas.js';

describe('install sibling markers (DOR-2245)', () => {
  // Purpose: the staging and uninstall siblings DOR-2245's installer writes must
  // be hidden from every reader of an install root, exactly like a backup, or a
  // sync that lands mid-install projects `flow.dorkos-stage-…` as a second flow.
  it('lists the stage and uninstall markers beside the backup marker', () => {
    expect(MARKETPLACE_INSTALL_SIBLING_MARKERS).toContain(MARKETPLACE_STAGE_DIR_MARKER);
    expect(MARKETPLACE_INSTALL_SIBLING_MARKERS).toContain(MARKETPLACE_UNINSTALL_DIR_MARKER);
  });

  it.each([
    'flow.dorkos-stage-1727000000000-123-1727000000-deadbeef-7c9e6679-7425-40de-944b-e07fc1f90ae7',
    'flow.dorkos-uninstall-1727000000000-123-1727000000-deadbeef-7c9e6679-7425-40de-944b-e07fc1f90ae7',
    'flow.dorkos-bak-1727000000000-7c9e6679-7425-40de-944b-e07fc1f90ae7',
  ])('hides %s', (name) => {
    expect(isInstallSiblingName(name)).toBe(true);
  });

  // Purpose: a package whose name merely resembles a marker stays visible.
  it.each(['flow', 'dorkos-stage', 'my-stage-plugin', 'uninstall-helper'])('shows %s', (name) => {
    expect(isInstallSiblingName(name)).toBe(false);
  });
});
