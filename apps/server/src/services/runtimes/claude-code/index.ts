/**
 * Claude Code Runtime — encapsulates all Claude Agent SDK interactions.
 *
 * @module services/runtimes/claude-code
 */
export { ClaudeCodeRuntime } from './claude-code-runtime.js';
export { TranscriptReader } from './sessions/transcript-reader.js';
export { CommandRegistryService } from './tooling/command-registry.js';
// Normalizer seam (task #6 feeds triggered turns through the projector with these).
export { toRawSessionEvent, feedProjector } from './sessions/session-event-normalizer.js';
// Global session-list watcher (task #7 fans this into the global SSE stream).
export { watchSessionList, SESSION_LIST_DEBOUNCE_MS } from './sessions/session-list-watcher.js';
