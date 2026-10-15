import type { Pool } from 'pg';
import type { CommunityConfig } from '../config.js';
import { LiveHub } from './hub.js';

/** Build the live-stream hub the configuration describes. */
export function createLiveHub(config: CommunityConfig): LiveHub {
  return new LiveHub({
    listenUrl: config.database.listenUrl,
    maxStreams: config.streams.max,
    maxStreamsPerCommunity: config.streams.perCommunity,
    maxStreamsPerMember: config.streams.perMember,
    fallbackMs: config.streams.fallbackMs,
  });
}

/**
 * Stop `live` whenever `pool` ends, before the pool itself does. The hub's connection sits outside
 * the pool, so ending the pool alone would leave it connected, and a test dropping its database
 * right after would find it still in use. `pg` emits no event when a pool ends, so this wraps
 * `end` once. It is only for a hub the app made itself; a caller that passes its own stops it.
 */
export function stopLiveWithPool(live: LiveHub, pool: Pool): void {
  const end = pool.end.bind(pool) as () => Promise<void>;
  const endWithLive = (callback?: (error?: Error) => void) => {
    const ended = live
      .stop()
      .catch(() => undefined)
      .then(() => end());
    if (!callback) return ended;
    ended.then(() => callback(), callback);
    return undefined;
  };
  pool.end = endWithLive as Pool['end'];
}
