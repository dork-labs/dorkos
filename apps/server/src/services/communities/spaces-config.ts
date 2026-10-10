/**
 * The two config reads every space surface turns on: the spaces experiment (DOR-2740) and the
 * official space's link (spec `official-community-space` D4). Read on every call rather than
 * once at boot, so a change in Settings takes effect without a restart; a config read is an
 * in-memory lookup.
 *
 * @module services/communities/spaces-config
 */
import { env } from '../../env.js';
import { configManager } from '../core/config-manager.js';

/**
 * Whether the spaces experiment is on (`spaces.enabled`, DOR-2740).
 *
 * @returns True only when a person has turned spaces on.
 */
export function spacesEnabled(): boolean {
  return configManager.get('spaces')?.enabled === true;
}

/**
 * The official space's configured link: `DORKOS_OFFICIAL_SPACE_URL` when it is set, even to
 * `''`, otherwise `spaces.official.url`. `''` means there is no official space.
 *
 * @returns The link as configured, unparsed.
 */
export function officialSpaceUrl(): string {
  return env.DORKOS_OFFICIAL_SPACE_URL ?? configManager.get('spaces')?.official?.url ?? '';
}
