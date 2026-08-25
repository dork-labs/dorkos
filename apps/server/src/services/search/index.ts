/**
 * Message search — a derived, read-only, rebuildable index over everything that
 * was ever said (ADR 260728-214214, spec `specs/message-search/`).
 *
 * **It is not a store.** Rooms, Claude Code and Codex each keep their own
 * canonical record and DorkOS never writes to any of them (ADR-0310). Every row
 * here is a copy that can be thrown away and rebuilt, and deleting the index is
 * a supported recovery.
 *
 * Today it indexes two sources: the room log, and every Claude Code transcript
 * under the active account's root — sessions run inside DorkOS and sessions run
 * from the bare `claude` CLI alike, because the index reads what the SDK wrote
 * rather than anything DorkOS recorded.
 *
 * {@link searchMessages} is the one way to read it — the room history tool's
 * `search_room_history` calls it inside a scope the rooms domain resolved
 * (room-participation spec §10.3, as amended by DOR-672). The person-facing
 * search route and the palette entry point are still later tasks, and when they
 * land they call the same function: there is exactly one search path over these
 * rows. Session rows are owner-only and reachable by no agent (spec §7), which
 * is why nothing here takes a caller.
 *
 * @module server/services/search
 */
export { SearchIndexer, SEARCH_RECONCILE_INTERVAL_MS, type SweepResult } from './indexer.js';
export { searchMessages } from './query.js';
export {
  SEARCH_SOURCES,
  claudeCodeSource,
  createClaudeCodeSource,
  roomsSource,
} from './registry.js';
export { sweepRowSource } from './row-frontier.js';
export { sweepFileSource, DISCOVERY_FAILURE_KEY } from './jsonl-frontier.js';
export { discoverClaudeCodeTranscripts } from './claude-code-discovery.js';
export { projectRoomEntries, type RoomEntrySourceRow } from './projections/rooms.js';
export {
  projectClaudeCodeLines,
  type ClaudeCodeProjectionContext,
} from './projections/claude-code.js';
export type {
  FileContainer,
  FileDiscovery,
  FileSource,
  KnownContainer,
  ProjectedMessage,
  Projection,
  RowContainer,
  RowSource,
  SearchSource,
  SkipReason,
  SkippedFile,
  SourceFailure,
  SourceSweep,
} from './types.js';
