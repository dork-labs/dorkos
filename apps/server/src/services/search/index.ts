/**
 * Message search — a derived, read-only, rebuildable index over everything that
 * was ever said (ADR 260728-214214, spec `specs/message-search/`).
 *
 * **It is not a store.** Rooms, Claude Code and Codex each keep their own
 * canonical record and DorkOS never writes to any of them (ADR-0310). Every row
 * here is a copy that can be thrown away and rebuilt, and deleting the index is
 * a supported recovery.
 *
 * Today it indexes the room log, and {@link searchMessages} is the one way to
 * read it — the room history tool's `search_room_history` calls it inside a scope
 * the rooms domain resolved (room-participation spec §10.3, as amended by
 * DOR-672). The person-facing search route and the palette entry point are still
 * later tasks, and when they land they call the same function: there is exactly
 * one search path over these rows.
 *
 * @module server/services/search
 */
export { SearchIndexer, SEARCH_RECONCILE_INTERVAL_MS, type SweepResult } from './indexer.js';
export { searchMessages } from './query.js';
export { SEARCH_SOURCES, roomsSource } from './registry.js';
export { sweepRowSource, type RowSourceSweep } from './row-frontier.js';
export { projectRoomEntries, type RoomEntrySourceRow } from './projections/rooms.js';
export type {
  ProjectedMessage,
  Projection,
  RowContainer,
  RowSource,
  SourceFailure,
} from './types.js';
