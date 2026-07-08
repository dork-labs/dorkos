import { describe, it, expect, beforeEach } from 'vitest';
import type { UiState } from '@dorkos/shared/types';
import {
  buildUiStateSnapshot,
  prepareUiStateForSend,
  clearUiStateSendCache,
  resetUiStateSendCache,
  MAX_TRACKED_SESSIONS,
  type UiStateSource,
} from '../ui-state-snapshot';

const baseSource: UiStateSource = {
  canvasOpen: false,
  canvasContent: null,
  settingsOpen: false,
  tasksOpen: false,
  relayOpen: false,
  pickerOpen: false,
  sidebarOpen: true,
  sidebarActiveTab: 'overview',
};

describe('buildUiStateSnapshot', () => {
  it('maps app-store fields into a UiState, including picker', () => {
    const snapshot = buildUiStateSnapshot(
      {
        ...baseSource,
        pickerOpen: true,
        tasksOpen: true,
        canvasOpen: true,
        canvasContent: { type: 'markdown', content: '# hi' },
        sidebarActiveTab: 'connections',
      },
      '/projects/app'
    );

    expect(snapshot).toEqual<UiState>({
      canvas: { open: true, contentType: 'markdown' },
      panels: { settings: false, tasks: true, relay: false, picker: true },
      sidebar: { open: true, activeTab: 'connections' },
      agent: { id: null, cwd: '/projects/app' },
    });
  });

  it('reports null contentType when the canvas has no content, and null cwd when unknown', () => {
    const snapshot = buildUiStateSnapshot(baseSource, null);
    expect(snapshot.canvas.contentType).toBeNull();
    expect(snapshot.agent.cwd).toBeNull();
  });
});

describe('prepareUiStateForSend (omit-when-unchanged)', () => {
  beforeEach(() => resetUiStateSendCache());

  it('sends the snapshot on the first send for a session', () => {
    const snapshot = buildUiStateSnapshot(baseSource, '/a');
    const { uiState } = prepareUiStateForSend('s1', snapshot);
    expect(uiState).toEqual(snapshot);
  });

  it('omits an unchanged snapshot after a committed send', () => {
    const snapshot = buildUiStateSnapshot(baseSource, '/a');

    const first = prepareUiStateForSend('s1', snapshot);
    expect(first.uiState).toBeDefined();
    first.commit();

    const second = prepareUiStateForSend('s1', buildUiStateSnapshot(baseSource, '/a'));
    expect(second.uiState).toBeUndefined();
  });

  it('re-sends once the snapshot changes', () => {
    const first = prepareUiStateForSend('s1', buildUiStateSnapshot(baseSource, '/a'));
    first.commit();

    const changed = buildUiStateSnapshot({ ...baseSource, tasksOpen: true }, '/a');
    const second = prepareUiStateForSend('s1', changed);
    expect(second.uiState).toEqual(changed);
  });

  it('does not commit until the send succeeds', () => {
    const snapshot = buildUiStateSnapshot(baseSource, '/a');
    // Prepare but never commit (simulating a failed POST).
    prepareUiStateForSend('s1', snapshot);

    const retry = prepareUiStateForSend('s1', buildUiStateSnapshot(baseSource, '/a'));
    expect(retry.uiState).toBeDefined();
  });

  it('commits under a rekeyed canonical id so the canonical session compares correctly', () => {
    const snapshot = buildUiStateSnapshot(baseSource, '/a');
    const { commit } = prepareUiStateForSend('temp-id', snapshot);
    commit('canonical-id');

    const next = prepareUiStateForSend('canonical-id', buildUiStateSnapshot(baseSource, '/a'));
    expect(next.uiState).toBeUndefined();
  });

  it('keeps per-session caches independent', () => {
    const snapshot = buildUiStateSnapshot(baseSource, '/a');
    prepareUiStateForSend('s1', snapshot).commit();

    const other = prepareUiStateForSend('s2', buildUiStateSnapshot(baseSource, '/a'));
    expect(other.uiState).toBeDefined();
  });

  it('clearUiStateSendCache forces the next send to re-include an unchanged snapshot', () => {
    // Stream (re)connect scenario: the server may have restarted and lost its
    // in-memory session.uiState — an elided "unchanged" snapshot would leave
    // get_ui_state answering with fabricated defaults.
    const snapshot = buildUiStateSnapshot(baseSource, '/a');
    prepareUiStateForSend('s1', snapshot).commit();
    expect(prepareUiStateForSend('s1', snapshot).uiState).toBeUndefined();

    clearUiStateSendCache('s1');

    expect(prepareUiStateForSend('s1', snapshot).uiState).toEqual(snapshot);
  });

  it('clearUiStateSendCache only drops the targeted session', () => {
    const snapshot = buildUiStateSnapshot(baseSource, '/a');
    prepareUiStateForSend('s1', snapshot).commit();
    prepareUiStateForSend('s2', snapshot).commit();

    clearUiStateSendCache('s1');

    expect(prepareUiStateForSend('s2', snapshot).uiState).toBeUndefined();
  });

  it('bounds the cache: the oldest session is evicted past MAX_TRACKED_SESSIONS', () => {
    const snapshot = buildUiStateSnapshot(baseSource, '/a');
    for (let i = 0; i <= MAX_TRACKED_SESSIONS; i++) {
      prepareUiStateForSend(`sess-${i}`, snapshot).commit();
    }

    // sess-0 was evicted (oldest) — its next send re-includes the snapshot.
    expect(prepareUiStateForSend('sess-0', snapshot).uiState).toBeDefined();
    // The newest entry is still cached.
    expect(prepareUiStateForSend(`sess-${MAX_TRACKED_SESSIONS}`, snapshot).uiState).toBeUndefined();
  });

  it('a commit refreshes recency so active sessions survive eviction', () => {
    const snapshot = buildUiStateSnapshot(baseSource, '/a');
    prepareUiStateForSend('active', snapshot).commit();
    for (let i = 0; i < MAX_TRACKED_SESSIONS - 1; i++) {
      prepareUiStateForSend(`filler-${i}`, snapshot).commit();
    }
    // Re-commit 'active' (oldest by insertion) to refresh its recency, then
    // push one more session over the cap — 'filler-0' should evict, not 'active'.
    prepareUiStateForSend('active', snapshot).commit();
    prepareUiStateForSend('one-more', snapshot).commit();

    expect(prepareUiStateForSend('active', snapshot).uiState).toBeUndefined();
    expect(prepareUiStateForSend('filler-0', snapshot).uiState).toBeDefined();
  });
});
