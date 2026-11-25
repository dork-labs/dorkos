/**
 * Granular selectors over a chat's runs and restored drafts (spec
 * `turns-survive-restarts` §4.6), read from the session stream store.
 *
 * @module entities/session/model/stream/use-chat-runs
 */
import { useCallback } from 'react';
import type { ChatRun, RunNotice } from '@dorkos/shared/run-schemas';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import { useSessionStreamStore } from './session-stream-store';
import { runNoticeOf } from './chat-runs';

/** Stable empty lists, so an unknown session returns the same value every render. */
const NO_RUNS: ChatRun[] = [];
const NO_DRAFTS: QueuedMessage[] = [];

/**
 * A chat's runs as the record holds them: its live run, its waiting runs and,
 * while nothing is live, the run that ended last.
 *
 * @param sessionId - The chat.
 */
export function useSessionRuns(sessionId: string): ChatRun[] {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.runs ?? NO_RUNS, [sessionId])
  );
}

/**
 * The line a person sees about the chat's last run (§7.4), or `null`.
 *
 * @param sessionId - The chat.
 */
export function useSessionRunNotice(sessionId: string): RunNotice | null {
  return useSessionStreamStore(
    useCallback((s) => runNoticeOf(s.sessions[sessionId]?.runs ?? NO_RUNS), [sessionId])
  );
}

/**
 * The chat's restored drafts (§7.3): words a turn started with that came back
 * after a restart. Every window shows them until one is sent or discarded.
 *
 * @param sessionId - The chat.
 */
export function useSessionRestoredDrafts(sessionId: string): QueuedMessage[] {
  return useSessionStreamStore(
    useCallback((s) => s.sessions[sessionId]?.restoredDrafts ?? NO_DRAFTS, [sessionId])
  );
}
