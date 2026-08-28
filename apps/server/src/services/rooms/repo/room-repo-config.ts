/**
 * `config.rooms.repo`, read live and degrading to the shipped defaults
 * (spec `project-rooms` §3.12).
 *
 * The same shape every other live config reader in the rooms domain takes
 * (`readRoomMinutesMs`, `readEngagedWindow`, `readCollectWindow` in
 * `services/rooms/index.ts`): read per call so a settings change binds the very
 * next request rather than the next server start, and fall back to
 * `USER_CONFIG_DEFAULTS` rather than throwing, so a config store that is not up
 * yet cannot take the feature down with it.
 *
 * @module server/services/rooms/repo/room-repo-config
 */
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { configManager } from '../../core/config-manager.js';

/** This install's room-repo settings. */
export type RoomRepoConfig = UserConfig['rooms']['repo'];

/**
 * Read `config.rooms.repo`, or the shipped defaults when it cannot be read.
 *
 * @returns The live settings.
 */
export function readRoomRepoConfig(): RoomRepoConfig {
  try {
    return configManager.get('rooms').repo ?? USER_CONFIG_DEFAULTS.rooms.repo;
  } catch {
    return USER_CONFIG_DEFAULTS.rooms.repo;
  }
}
