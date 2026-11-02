/**
 * How a session's binding row is written: its settings as an UPSERT patch, the
 * NULL-filling claim of a seed, and what started it. Lifted out of
 * `runtime-registry.ts`, which writes the row, so that file stays small.
 *
 * @module services/core/runtime-seam/session-metadata-columns
 */
import type { SessionSettings } from '@dorkos/shared/types';
import { sessionMetadata, sql, type SQL } from '@dorkos/db';
import type { TurnOrigin } from '../../session/origin/turn-origin.js';

/** Reduce `SessionSettings` to only the explicitly-provided keys for an UPSERT patch. */
export function pickSettings(
  settings: SessionSettings
): Partial<typeof sessionMetadata.$inferInsert> {
  const patch: Partial<typeof sessionMetadata.$inferInsert> = {};
  if (settings.permissionMode !== undefined) patch.permissionMode = settings.permissionMode;
  if (settings.model !== undefined) patch.model = settings.model;
  if (settings.effort !== undefined) patch.effort = settings.effort;
  if (settings.fastMode !== undefined) patch.fastMode = settings.fastMode;
  return patch;
}

/** The settings columns, as UPDATE expressions rather than plain values. */
export type SettingsUpdate = { [K in keyof SessionSettings & string]?: SQL };

/**
 * Turn a seed into an UPDATE that fills only the columns still holding NULL.
 *
 * The UPSERT's INSERT branch gets "an explicit value wins" for free by ordering
 * (`...seed, ...patch`). Its UPDATE branch cannot: the value it must not
 * overwrite is already in the row, not in this statement. `coalesce(<column>,
 * <seed>)` is that same rule expressed against the stored row — which is what
 * lets a binding write seed a session whose settings were chosen before it
 * started, without touching one of those choices.
 *
 * **The model and the effort, and deliberately no other column.**
 * `permissionMode` needs more than filling — a stored mode has to be checked
 * against what the runtime being bound declares, so it has its own expression
 * (`RuntimeRegistry.claimedPermissionMode`). `fastMode` is never seeded:
 * `resolveSessionDefaults` has no tier for it, and it is also the one
 * BOOLEAN here — better-sqlite3 refuses to bind a JS boolean as a raw parameter
 * ("can only bind numbers, strings, bigints, buffers, and null"), so a seed that
 * ever grew a `fastMode` would throw here rather than quietly do nothing. Add it
 * with a driver-encoded value, not by extending this list.
 *
 * @param seed - The columns a newly-created row would have carried.
 */
export function fillNullsWith(seed: Partial<typeof sessionMetadata.$inferInsert>): SettingsUpdate {
  const update: SettingsUpdate = {};
  for (const key of ['model', 'effort'] as const) {
    const value = seed[key];
    if (value !== undefined) update[key] = sql`coalesce(${sessionMetadata[key]}, ${value})`;
  }
  return update;
}

/**
 * What started the session and, for an agent's launch, who chose its place
 * (DOR-3644), as the binding write's columns. Server-held and never
 * overwritten: `claim` fills only what the row does not hold yet, the way the
 * UPDATE branch of a first-write-wins binding must.
 *
 * @param origin - What is starting the session.
 * @param claim - Write them as the claim of a row that already exists.
 */
export function launchColumns(
  origin: TurnOrigin,
  claim?: 'claim'
): { launchOrigin: string | SQL; launchedBy?: string | SQL } {
  const launchedBy = origin.kind === 'agent-launch' ? origin.launchedBy : undefined;
  if (!claim) return { launchOrigin: origin.kind, ...(launchedBy ? { launchedBy } : {}) };
  return {
    launchOrigin: sql`coalesce(${sessionMetadata.launchOrigin}, ${origin.kind})`,
    ...(launchedBy
      ? { launchedBy: sql`coalesce(${sessionMetadata.launchedBy}, ${launchedBy})` }
      : {}),
  };
}
