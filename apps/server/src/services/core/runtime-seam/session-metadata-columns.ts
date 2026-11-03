/**
 * How a session's binding row is written: its settings as an UPSERT patch, the
 * NULL-filling claim of a seed, and what started it. Lifted out of
 * `runtime-registry.ts`, which writes the row, so that file stays small.
 *
 * @module services/core/runtime-seam/session-metadata-columns
 */
import type { SessionSettings } from '@dorkos/shared/types';
import { sessionMetadata, sql, type SQL } from '@dorkos/db';
import { EffortLevelSchema } from '@dorkos/shared/schemas';
import { logger } from '../../../lib/logger.js';
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

/**
 * The claim's `agentPath` write: only when the caller names an agent, and only
 * into an empty column. A recorded agent never changes once recorded, not even
 * by the claim (DOR-3706, R3 in Security's DOR-3640 write-up).
 *
 * @param agentPath - The agent the binding write names, if any.
 */
export function keepRecordedAgent(agentPath: string | undefined): { agentPath?: SQL } {
  return agentPath === undefined
    ? {}
    : { agentPath: sql`coalesce(${sessionMetadata.agentPath}, ${agentPath})` };
}

/**
 * Whether a re-key must be refused because it would merge two rows that each
 * record a different agent. The same rule as {@link keepRecordedAgent}: a
 * recorded agent never changes, so the move leaves both rows as they are and
 * says so in the log. A row with no agent recorded merges as before.
 *
 * @param fromId - The id the row is stored under today.
 * @param toId - The id the move would put it under.
 * @param fromAgent - The agent the source row records, if any.
 * @param toAgent - The agent the destination row records, if any.
 */
export function refuseAgentChange(
  fromId: string,
  toId: string,
  fromAgent: string | null | undefined,
  toAgent: string | null | undefined
): boolean {
  if (!fromAgent || !toAgent || fromAgent === toAgent) return false;
  logger.warn('[RuntimeRegistry] refused a re-key between two agents', { fromId, toId });
  return true;
}

/** Columns read from `session_metadata` for the settings projection. */
export type SettingsRow = {
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
 *
 * @param row - The settings columns of one `session_metadata` row.
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
