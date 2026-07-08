/**
 * Client UI-state snapshot for agent situational awareness (ADR-0273).
 *
 * Composes the `ClientContext.uiState` the client sends with a message so the
 * agent's `get_ui_state` tool can report which panels/canvas/sidebar are open,
 * and gates re-sends: an unchanged snapshot is omitted from the message POST so
 * it does not accumulate in the transcript (the server persists `session.uiState`
 * across turns, so re-sending an identical snapshot is pure noise).
 *
 * Cache lifetime is tied to the durable session stream: the server holds
 * `session.uiState` in memory only, so a restart/eviction wipes it while this
 * client-side cache would keep eliding "unchanged" snapshots. The session-stream
 * binding therefore calls {@link clearUiStateSendCache} whenever the session's
 * durable stream (re)enters `connected`, forcing the next send to re-seed the
 * server with a fresh snapshot.
 *
 * @module shared/lib/ui-state-snapshot
 */
import type { UiState, UiCanvasContent, UiSidebarTab } from '@dorkos/shared/types';

/** The app-store slice values the UI-state snapshot reads. */
export interface UiStateSource {
  canvasOpen: boolean;
  /** Open canvas documents; the active one supplies the reported content type. */
  openDocuments: { id: string; content: UiCanvasContent }[];
  /** Id of the active canvas document, or null when none are open. */
  activeDocumentId: string | null;
  settingsOpen: boolean;
  tasksOpen: boolean;
  relayOpen: boolean;
  pickerOpen: boolean;
  sidebarOpen: boolean;
  sidebarActiveTab: UiSidebarTab;
}

/**
 * Compose a UI-state snapshot from the app-store slice values.
 *
 * @param source - Panel/sidebar/canvas open-state read from the app store.
 * @param cwd - The session's working directory (null when unknown). The active
 *   agent id is not tracked client-side, so `agent.cwd` is the identifying field.
 */
export function buildUiStateSnapshot(source: UiStateSource, cwd: string | null): UiState {
  // Tolerate a partial source (test mocks pass a subset of the store) — an
  // absent document list reads as "no active content", never a throw.
  const activeContent = (source.openDocuments ?? []).find(
    (d) => d.id === source.activeDocumentId
  )?.content;
  return {
    canvas: { open: source.canvasOpen, contentType: activeContent?.type ?? null },
    panels: {
      settings: source.settingsOpen,
      tasks: source.tasksOpen,
      relay: source.relayOpen,
      picker: source.pickerOpen,
    },
    sidebar: { open: source.sidebarOpen, activeTab: source.sidebarActiveTab },
    agent: { id: null, cwd: cwd ?? null },
  };
}

/**
 * Cap on sessions tracked by the last-sent cache. A long-lived tab visits many
 * sessions; entries for sessions it never returns to must not accumulate
 * forever. Eviction is LRU-ish: commits refresh recency (Map insertion order),
 * and the oldest entry is dropped when the cap is exceeded. An evicted
 * session's next send simply re-includes the snapshot — correct, just not
 * elided.
 *
 * @internal Exported for testing only.
 */
export const MAX_TRACKED_SESSIONS = 50;

/** Per-session cache of the last uiState serialization successfully sent. */
const lastSentUiState = new Map<string, string>();

/** Record a sent snapshot, refreshing recency and bounding the cache size. */
function recordSent(sessionId: string, serialized: string): void {
  lastSentUiState.delete(sessionId);
  lastSentUiState.set(sessionId, serialized);
  if (lastSentUiState.size > MAX_TRACKED_SESSIONS) {
    const oldest = lastSentUiState.keys().next().value;
    if (oldest !== undefined) lastSentUiState.delete(oldest);
  }
}

/** The uiState decision plus a commit to record it as sent after success. */
export interface PreparedUiState {
  /** The snapshot to attach to ClientContext, or undefined when unchanged. */
  uiState: UiState | undefined;
  /**
   * Record the snapshot as successfully sent. Call only after the POST resolves.
   *
   * @param committedSessionId - The session id to record under; defaults to the
   *   send's target id. Pass the canonical id after a create-on-first-message
   *   rekey so the next turn on the canonical session compares correctly.
   */
  commit: (committedSessionId?: string) => void;
}

/**
 * Decide whether to include `uiState` in a message's ClientContext, omitting it
 * when byte-identical to the last snapshot successfully sent for this session.
 *
 * @param sessionId - The session the message targets.
 * @param snapshot - The freshly composed snapshot for this send.
 */
export function prepareUiStateForSend(sessionId: string, snapshot: UiState): PreparedUiState {
  const serialized = JSON.stringify(snapshot);
  const unchanged = lastSentUiState.get(sessionId) === serialized;
  return {
    uiState: unchanged ? undefined : snapshot,
    commit: (committedSessionId = sessionId) => {
      recordSent(committedSessionId, serialized);
    },
  };
}

/**
 * Forget the last-sent snapshot for a session so its next send re-includes
 * `uiState`. Called by the session-stream binding whenever the session's
 * durable stream (re)enters `connected` — after a server restart or session
 * eviction the server-side `session.uiState` is gone, and an elided
 * "unchanged" snapshot would leave `get_ui_state` answering with fabricated
 * defaults until the UI happened to change. Also called on `session_removed`
 * so dead sessions don't linger in the cache.
 *
 * @param sessionId - The session whose cache entry to drop.
 */
export function clearUiStateSendCache(sessionId: string): void {
  lastSentUiState.delete(sessionId);
}

/** @internal Clear the entire last-sent cache. Test-only. */
export function resetUiStateSendCache(): void {
  lastSentUiState.clear();
}
