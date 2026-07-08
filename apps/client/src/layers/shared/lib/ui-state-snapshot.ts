/**
 * Client UI-state snapshot for agent situational awareness (ADR-0273).
 *
 * Composes the `ClientContext.uiState` the client sends with a message so the
 * agent's `get_ui_state` tool can report which panels/canvas/sidebar are open,
 * and gates re-sends: an unchanged snapshot is omitted from the message POST so
 * it does not accumulate in the transcript (the server persists `session.uiState`
 * across turns, so re-sending an identical snapshot is pure noise).
 *
 * @module shared/lib/ui-state-snapshot
 */
import type { UiState, UiCanvasContent, UiSidebarTab } from '@dorkos/shared/types';

/** The app-store slice values the UI-state snapshot reads. */
export interface UiStateSource {
  canvasOpen: boolean;
  canvasContent: UiCanvasContent | null;
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
  return {
    canvas: { open: source.canvasOpen, contentType: source.canvasContent?.type ?? null },
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

/** Per-session cache of the last uiState serialization successfully sent. */
const lastSentUiState = new Map<string, string>();

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
      lastSentUiState.set(committedSessionId, serialized);
    },
  };
}

/** @internal Clear the last-sent cache. Test-only. */
export function resetUiStateSendCache(): void {
  lastSentUiState.clear();
}
