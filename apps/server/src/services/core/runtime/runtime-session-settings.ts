import type { SessionSettings } from '@dorkos/shared/types';
import { EffortLevelSchema } from '@dorkos/shared/schemas';
import { sessionMetadata, sql, type SQL } from '@dorkos/db';
import { logger } from '../../../lib/logger.js';

/** Columns read from `session_metadata` for the settings projection. */
type SettingsRow = {
  permissionMode: string | null;
  model: string | null;
  effort: string | null;
  fastMode: boolean | null;
};

/**
 * Map a settings DB row (NULLs) to a `SessionSettings` object (omitted keys).
 *
 * `effort` is the one column parsed rather than cast. It is a free-form TEXT
 * column, so what comes back is whatever was written — including a rung that a
 * later release removed from the ladder, or anything a person put there by hand.
 * A cast made that string travel as an `EffortLevel` all the way into an adapter,
 * where claude-code's own mapper drops it (harmless) and codex's
 * `EFFORT_TO_REASONING` lookup yields `undefined` and sends
 * `modelReasoningEffort: undefined` into the SDK. An unreadable value means "no
 * preference" — the same thing NULL means — so it is dropped here, once, rather
 * than at three adapter edges.
 */
export function rowToSettings(row: SettingsRow): SessionSettings {
  const settings: SessionSettings = {};
  if (row.permissionMode != null) settings.permissionMode = row.permissionMode;
  if (row.model != null) settings.model = row.model;
  if (row.effort != null) {
    const effort = EffortLevelSchema.safeParse(row.effort);
    if (effort.success) settings.effort = effort.data;
    else
      logger.warn('[RuntimeRegistry] ignoring an unreadable stored effort level', {
        stored: row.effort,
      });
  }
  if (row.fastMode != null) settings.fastMode = row.fastMode;
  return settings;
}

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
 * ({@link RuntimeRegistry.claimedPermissionMode}). `fastMode` is never seeded:
 * {@link resolveSessionDefaults} has no tier for it, and it is also the one
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
