/**
 * Interactions entity — the one memory of what THIS person opened, when, and
 * how often.
 *
 * It is an entity rather than a feature because two surfaces read it and
 * neither owns it: the sidebar orders Today by it (spec
 * `sidebar-now-today-library` BC-16) and ⌘K ranks by it. There is no second
 * store beside it — ⌘K's agent-only `dorkos:agent-frecency-v2` key was folded
 * in here and deleted from the browser (`legacy-frecency-migration`).
 *
 * @module entities/interactions
 */
export {
  useInteractionStore,
  useInteractionTimestamps,
  useInteractionCounts,
  useLastOpenedAt,
  interactionKey,
  MAX_INTERACTION_RECORDS,
} from './model/interaction-store';
// `InteractionCounts` and `InteractionUsage` are deliberately NOT re-exported:
// the first is the return type of a hook callers destructure, the second is the
// argument shape of an action only this slice's own migration calls. Both are
// exported from the module for the migration and the tests beside it, and a
// barrel entry nothing imports is surface to keep in step for no reader.
export type { InteractionKind, InteractionTimestamps } from './model/interaction-store';
export {
  useLegacyFrecencyMigration,
  translateLegacyRecords,
} from './model/legacy-frecency-migration';
export type { MigratableAgent } from './model/legacy-frecency-migration';
