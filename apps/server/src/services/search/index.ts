/**
 * Message search — a derived, read-only, rebuildable index over everything that
 * was ever said (ADR 260728-214214, spec `specs/message-search/`).
 *
 * **It is not a store.** Rooms, Claude Code and Codex each keep their own
 * canonical record and DorkOS never writes to any of them (ADR-0310). Every row
 * here is a copy that can be thrown away and rebuilt, and deleting the index is
 * a supported recovery.
 *
 * Today it indexes three sources: the room log; every Claude Code transcript
 * under EVERY Claude account on the machine — sessions run inside DorkOS and
 * sessions run from the bare `claude` CLI alike, because the index reads what
 * the SDK wrote rather than anything DorkOS recorded, and every account, because
 * reading only the active one covered 67% of the operator's own history and said
 * nothing about the rest (spec Amendment 2); and OpenCode's own SQLite store,
 * read through a throwaway snapshot that structurally cannot reach the
 * credential tables sitting beside its messages (ADR 260825-110420).
 *
 * {@link searchMessages} is the one way to read it — the room history tool's
 * `search_room_history` calls it inside a scope the rooms domain resolved
 * (room-participation spec §10.3, as amended by DOR-672), and so does
 * {@link searchForCaller}, which is what `GET /api/search` answers with. There is
 * exactly one search path over these rows, and neither caller is trusted with an
 * access rule: both are handed a scope somebody else resolved. Session rows are
 * owner-only and reachable by no agent (spec §7). The palette entry point is a
 * later task and calls the same route.
 *
 * @module server/services/search
 */
export { SearchIndexer, SEARCH_RECONCILE_INTERVAL_MS, type SweepResult } from './indexer.js';
export { searchMessages } from './query.js';
export { searchForCaller } from './search-service.js';
export {
  SEARCH_SOURCES,
  claudeCodeSource,
  createClaudeCodeSource,
  createOpenCodeSource,
  openCodeSource,
  roomsSource,
} from './registry.js';
export { sweepContainers, sweepRowSource } from './row-frontier.js';
export { sweepSnapshotSource, SNAPSHOT_FAILURE_KEY } from './snapshot-frontier.js';
export {
  openOpenCodeSnapshot,
  OPENCODE_CREDENTIAL_TABLES,
  OPENCODE_READ_ALLOWLIST,
  type OpenCodeSnapshot,
} from './opencode-store.js';
export { indexRoomEntry } from './write-through.js';
export {
  sweepFileSource,
  DISCOVERY_FAILURE_KEY,
  DUPLICATE_CONTAINERS_KEY,
} from './jsonl-frontier.js';
export { discoverClaudeCodeTranscripts } from './claude-code-discovery.js';
export { projectRoomEntries, type RoomEntrySourceRow } from './projections/rooms.js';
export {
  projectClaudeCodeLines,
  type ClaudeCodeProjectionContext,
} from './projections/claude-code.js';
export { projectOpenCodeMessages, type OpenCodeMessageRow } from './projections/opencode.js';
export type {
  ContainerReader,
  DiscoveryFailure,
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
  SnapshotSource,
  SourceFailure,
  SourceSweep,
} from './types.js';
