/**
 * `config.rooms.repo`, read live and degrading to the shipped defaults.
 *
 * Two paths and both matter: the ordinary read, and the catch that keeps a
 * config store which is not up yet — or has been torn down — from taking the
 * feature offline. The fallback is the reason `enabled` defaults to `true`
 * rather than to "off until proven on": a room that lost its files because the
 * config manager threw would be a silent outage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';

// `vi.hoisted` because `vi.mock`'s factory is lifted above the imports, so a
// plain `const` above it is still in its temporal dead zone when it runs.
const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get },
}));

import { readRoomRepoConfig } from '../room-repo-config.js';

describe('readRoomRepoConfig', () => {
  beforeEach(() => {
    get.mockReset();
  });

  it('reads what the person actually set', () => {
    get.mockReturnValue({ repo: { ...USER_CONFIG_DEFAULTS.rooms.repo, enabled: false } });

    expect(readRoomRepoConfig().enabled).toBe(false);
    expect(get).toHaveBeenCalledWith('rooms');
  });

  it('falls back to the shipped defaults when the config store throws', () => {
    get.mockImplementation(() => {
      throw new Error('config store is not up yet');
    });

    expect(readRoomRepoConfig()).toEqual(USER_CONFIG_DEFAULTS.rooms.repo);
    // The direction that matters: a config failure must not switch the feature
    // off for every room on the install.
    expect(readRoomRepoConfig().enabled).toBe(true);
  });

  it('falls back when the rooms section carries no repo block at all', () => {
    // A config written before these fields existed, read before its migration
    // has run.
    get.mockReturnValue({});

    expect(readRoomRepoConfig()).toEqual(USER_CONFIG_DEFAULTS.rooms.repo);
  });
});
