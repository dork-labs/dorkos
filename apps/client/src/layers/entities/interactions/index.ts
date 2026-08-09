/**
 * Interactions entity — the one memory of what THIS person opened, and when.
 *
 * It is an entity rather than a feature because two surfaces read it and
 * neither owns it: the sidebar orders Today by it (spec
 * `sidebar-now-today-library` BC-16) and ⌘K ranks by it (P3, which adds
 * frecency scoring beside the same records).
 *
 * @module entities/interactions
 */
export {
  useInteractionStore,
  useInteractionTimestamps,
  useLastOpenedAt,
  interactionKey,
  MAX_INTERACTION_RECORDS,
} from './model/interaction-store';
export type { InteractionKind, InteractionTimestamps } from './model/interaction-store';
