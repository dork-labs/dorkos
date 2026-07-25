/**
 * The one place a {@link SessionDiagnostics} snapshot is assembled.
 *
 * Two surfaces report on a session and they must never contradict each other: the
 * Session panel behind the status line's `⋯` (a two-second peek — check a value,
 * pin a row, close) and the right panel's Session tab (a readout you leave open
 * while you work). Both call this hook; neither assembles anything itself.
 *
 * **Why one hook is enough to guarantee agreement.** Everything read here is
 * either a session-scoped Zustand selector, a TanStack Query cache entry, or a
 * pure function of those — there is no component-local state anywhere in the
 * dependency graph, so N callers always resolve N identical snapshots. That
 * property was not free:
 *
 * - `useSessionStatus`'s optimistic model / permission / effort / fast-mode used
 *   to be `useState`, so a second reader lagged the first for a whole PATCH
 *   round-trip. They now live in a per-session store (`session-settings-overrides`).
 * - The runtime resolution is read through {@link useResolvedSessionRuntime},
 *   never `useRuntimeChip`: the chip owns an effect that discards a stale pending
 *   pre-launch runtime selection on session change, and a readout that ran it
 *   would wipe the operator's choice merely by being opened.
 * - "Is a turn in flight?" comes from `useSessionRenderedStatus`, the same
 *   primitive the composer uses, rather than a local re-derivation.
 *
 * @module features/status/model/use-session-diagnostics
 */
import { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/shallow';
import type { SubagentInfo } from '@dorkos/shared/types';
import {
  deriveStatusBarValues,
  resolveDisplayContextPercent,
  useSessionChatStore,
  useSessionInProgressTurn,
  useSessionLastEventAt,
  useSessionLastEventSeq,
  useSessionQueue,
  useSessionRenderedStatus,
  useSessionSnapshotCursor,
  useSessionStatus,
  useSessionStreamConnection,
  useSessionStreamLifecycle,
  useSessionStreamStatus,
  useSessionTriggerPending,
  useSubagents,
} from '@/layers/entities/session';
import { useConfig } from '@/layers/entities/config';
import { foldActiveSubagents } from '../lib/fold-active-subagents';
import { isGitStatusOk, useGitStatus } from './use-git-status';
import { useResolvedSessionRuntime } from './use-runtime-chip';
import type { SessionDiagnostics } from './session-diagnostics';

/** Stable empty list so a session with no subagents keeps a stable snapshot. */
const NO_SUBAGENTS: SubagentInfo[] = [];

/**
 * Assemble the live {@link SessionDiagnostics} snapshot for a session.
 *
 * @param sessionId - Active session id; `''` when no session is open, which
 *   degrades every field to its honest empty value rather than throwing.
 */
export function useSessionDiagnostics(sessionId: string): SessionDiagnostics {
  // Server-derived values, snapshot-backed so they populate on a cold mount
  // instead of waiting for the first live event. Memoized on the held status
  // object (stable between changes) so the returned snapshot below can be
  // memoized at all — a fresh derivation each render would defeat it.
  const streamStatus = useSessionStreamStatus(sessionId);
  const streamValues = useMemo(() => deriveStatusBarValues(streamStatus), [streamStatus]);

  // The same predicate the composer uses — never a second derivation.
  const streaming = useSessionRenderedStatus(sessionId) === 'streaming';

  // The legacy send-path status the settings hook reads live values from. Same
  // store field ChatPanel threads down as its `sessionStatus` prop, read here
  // directly so this hook needs no caller context.
  const legacySessionStatus = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.sessionStatus ?? null, [sessionId])
  );

  // Read-only runtime resolution (see the module doc for why not `useRuntimeChip`).
  const runtime = useResolvedSessionRuntime(sessionId);
  const status = useSessionStatus(
    sessionId || null,
    legacySessionStatus,
    streaming,
    runtime.runtime
  );

  // Rich per-category context breakdown is not carried by the snapshot — it fills
  // in on the first live event, while the percent renders immediately.
  const contextUsage = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.contextUsage ?? null, [sessionId])
  );
  const legacyCacheStatus = useSessionChatStore(
    useShallow((s) => {
      const ss = s.sessions[sessionId]?.sessionStatus;
      if (!ss?.cacheReadTokens && !ss?.cacheCreationTokens) return null;
      return {
        cacheReadTokens: ss.cacheReadTokens ?? 0,
        cacheCreationTokens: ss.cacheCreationTokens ?? 0,
        contextTokens: ss.contextTokens,
      };
    })
  );
  const cacheStatus = streamValues.cacheStatus ?? legacyCacheStatus;

  const { data: gitStatus } = useGitStatus(status.cwd);
  const { data: subagents } = useSubagents(sessionId);
  const { data: serverConfig } = useConfig();

  const connectionState = useSessionStreamConnection(sessionId);
  const lifecycle = useSessionStreamLifecycle(sessionId);
  const lastEventSeq = useSessionLastEventSeq(sessionId);
  const lastEventAt = useSessionLastEventAt(sessionId);
  const snapshotCursor = useSessionSnapshotCursor(sessionId);
  const triggerPending = useSessionTriggerPending(sessionId);
  const queueDepth = useSessionQueue(sessionId).length;
  const inProgressTurn = useSessionInProgressTurn(sessionId);
  const activeSubagents = useMemo(() => foldActiveSubagents(inProgressTurn), [inProgressTurn]);

  const contextPercent = resolveDisplayContextPercent(
    streamValues.contextPercent ?? status.contextPercent,
    contextUsage
  );
  // NOTE: the resolved model prefers the started session's server-reported id,
  // then the snapshot's, and only falls back to the selected option value. The
  // option value is reported separately as `selectedModel` — the picker and the
  // auto-mode gate key off it, so collapsing the two would hide the mismatch
  // someone opens this readout to find.
  // `|| null` rather than `?? null`: with no model catalog loaded `status.model`
  // is the empty string, and an empty row must read "—", not blank.
  const model = (runtime.model ?? streamValues.model ?? status.model) || null;

  return useMemo(
    () => ({
      sessionId,
      cwd: status.cwd,
      gitBranch: isGitStatusOk(gitStatus) ? gitStatus.branch : null,
      gitDirty: isGitStatusOk(gitStatus) ? !gitStatus.clean : null,
      runtime: runtime.runtime,
      model,
      selectedModel: status.model || null,
      effort: status.effort ?? null,
      fastMode: status.fastMode,
      permissionMode: status.permissionMode,
      contextPercent,
      contextUsage,
      cache: cacheStatus
        ? {
            readTokens: cacheStatus.cacheReadTokens,
            creationTokens: cacheStatus.cacheCreationTokens,
            contextTokens: cacheStatus.contextTokens,
          }
        : null,
      usage: streamValues.usage,
      connectionState,
      streaming,
      lifecycle: lifecycle ?? null,
      triggerPending,
      lastEventSeq,
      snapshotCursor,
      lastEventAt,
      queueDepth,
      subagents: subagents ?? NO_SUBAGENTS,
      activeSubagents,
      clientVersion: serverConfig?.version ?? null,
    }),
    [
      sessionId,
      status.cwd,
      status.model,
      status.effort,
      status.fastMode,
      status.permissionMode,
      gitStatus,
      runtime.runtime,
      model,
      contextPercent,
      contextUsage,
      cacheStatus,
      streamValues,
      connectionState,
      lifecycle,
      streaming,
      triggerPending,
      lastEventSeq,
      snapshotCursor,
      lastEventAt,
      queueDepth,
      subagents,
      activeSubagents,
      serverConfig?.version,
    ]
  );
}
