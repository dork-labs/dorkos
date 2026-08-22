/**
 * The one query key the whole cockpit reads `GET /api/config` under.
 *
 * **It lives in `shared/` because every layer reads config.** It used to live in
 * `entities/config`, which `shared/` may not import — so the three hooks down
 * here spelled the key by hand, and a dozen callers above them spelled a
 * DIFFERENT one (the bare `['config']`) that is a separate cache entry with a
 * separate request. That second entry is what made the sidebar's pins, groups
 * and mute state restructure a round trip after the panel had already painted.
 * One factory, reachable from every layer, is the only shape that cannot drift.
 *
 * `entities/config` re-exports `configKeys` from here, so its public API is
 * unchanged.
 *
 * @module shared/model/server-config/query-keys
 */
export const configKeys = {
  /**
   * Root key for everything derived from `/config`.
   *
   * The prefix a write invalidates: one `invalidateQueries({ queryKey:
   * configKeys.all })` reaches every subscriber.
   */
  all: ['config'] as const,
  /** Current server config (version, ports, features, user settings). */
  current: () => [...configKeys.all, 'current'] as const,
};

/**
 * How long a config read stays fresh, for every subscriber.
 *
 * **One number, because it is one query.** Observers on the same key each keep
 * their own `staleTime`, so a key with a 30 s reader and a 5 min reader
 * refetches on the 30 s one and quietly ignores the other — the longer values
 * were describing a behaviour nobody got. Worse, `shared/model/server-config`
 * held two different `CONFIG_STALE_TIME` constants, in two files, in the same
 * directory.
 *
 * Thirty seconds is the tightest of the values that were in play, so it is also
 * the one that was actually in force. Config carries the version banner and the
 * runtime toggles, where being half a minute stale is the most anyone should
 * have to tolerate.
 */
export const CONFIG_STALE_TIME_MS = 30_000;
