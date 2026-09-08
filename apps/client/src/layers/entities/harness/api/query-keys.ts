/**
 * TanStack Query key factory for the harness status read.
 *
 * `api/` rather than `model/`, which is where the spec's file listing put it:
 * every key factory in `entities/` already lives in an `api/` directory
 * (marketplace, session, room, team, config, connectors, shapes), and the
 * directory a reader looks in matters more than a line in a plan.
 *
 * @module entities/harness/api
 */

/**
 * The one key this slice owns.
 *
 * Two hooks share it on purpose — `useHarnessStatus` fills it and
 * `useHarnessStatusCached` only reads it — so the profile row's number and the
 * Skills page can never be two different answers about one folder.
 *
 * A `null` path is a key of its own that nothing ever fills: the profile row
 * reads before it knows which folder it is about, and a key is cheaper than a
 * conditional hook.
 */
export const harnessKeys = {
  all: ['harness'] as const,

  status: (projectPath: string | null) => [...harnessKeys.all, 'status', { projectPath }] as const,
};
