/**
 * Interactions entity — the one memory of what THIS person opened, and when.
 *
 * It is an entity rather than a feature because two surfaces read it and
 * neither owns it: the sidebar orders Today by it (spec
 * `sidebar-now-today-library` BC-16) and ⌘K ranks by it (P3, which adds
 * frecency scoring over the same records).
 *
 * @module entities/interactions
 */
export {
  useInteractionStore,
  useInteractionRecords,
  useLastOpenedAt,
  interactionKey,
} from './model/interaction-store';
export type { InteractionKind, InteractionRecord } from './model/interaction-store';
