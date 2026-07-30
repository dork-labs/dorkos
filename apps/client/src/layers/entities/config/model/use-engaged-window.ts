/**
 * The two ceilings the engaged response mode decays against, as the cockpit
 * reads them.
 *
 * @module entities/config/model/use-engaged-window
 */
import type { ServerConfig } from '@dorkos/shared/types';
import { useConfig } from './use-config';

/**
 * How long an agent on `engaged` keeps answering after it was @mentioned, and
 * how many other messages end it — whichever runs out first.
 *
 * `null` until the config has been read. **A caller must not substitute the
 * shipped defaults for it.** These are settings somebody can change, and the
 * cockpit prints them inside the sentence that describes the mode, so a guess
 * here is a sentence that states something false about the reader's own
 * install. Say less, or say nothing, until the real numbers land.
 *
 * Reads the shared config query the shell already keeps warm, so this costs a
 * selector rather than a request.
 */
export function useEngagedWindow(): NonNullable<ServerConfig['rooms']> | null {
  return useConfig().data?.rooms ?? null;
}
