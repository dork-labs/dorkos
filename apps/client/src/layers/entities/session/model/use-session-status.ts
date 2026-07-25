import { useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import { useModels } from './use-models';
import {
  useSessionSettingsOverride,
  useSessionSettingsOverridesStore,
  type SessionSettingsOverrideKey,
} from './session-settings-overrides';
// Same-slice import via the sibling module (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { deriveContextPercent } from '../lib/context-health';
import type {
  Session,
  SessionStatusEvent,
  PermissionMode,
  EffortLevel,
  ModelOption,
  UpdateSessionRequest,
} from '@dorkos/shared/types';

export interface SessionStatusData {
  permissionMode: PermissionMode;
  model: string;
  effort: EffortLevel | null;
  fastMode: boolean;
  costUsd: number | null;
  contextPercent: number | null; // 0-100
  isStreaming: boolean;
  cwd: string | null;
}

/**
 * Computes derived session status data from streaming events, API data, and
 * optimistic overrides.
 *
 * Optimism is SHARED, not per-instance: the pending model / permission mode /
 * effort / fast-mode live in {@link useSessionSettingsOverridesStore} keyed by
 * session, so every component reading the same session sees a change in the same
 * tick. Two surfaces reading one session can no longer disagree for the length of
 * a PATCH round-trip.
 *
 * @param sessionId - The active session ID, or null when no session is selected.
 *   When null, the session query is disabled and no API requests are made.
 * @param streamingStatus - Live status events received during streaming.
 * @param isStreaming - Whether a stream is currently active.
 * @param runtime - The resolved runtime for this session (e.g. `'codex'`), or
 *   nullish to fall back to the server default. Threaded into the model query
 *   so the derived `defaultModel`, effort, fast-mode, and context-window come
 *   from the correct runtime's catalog even before the session has started
 *   (when there is no server-side row to resolve `sessionId` against).
 */
export function useSessionStatus(
  sessionId: string | null,
  streamingStatus: SessionStatusEvent | null,
  isStreaming: boolean,
  runtime?: string | null
) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const { data: models } = useModels({
    sessionId: sessionId ?? undefined,
    runtime: runtime ?? undefined,
  });

  // Optimistic overrides (applied immediately on user action), shared per session
  // so every reader of this session agrees on them.
  const overrides = useSessionSettingsOverride(sessionId ?? '');
  const applyOverrides = useSessionSettingsOverridesStore((s) => s.apply);
  const clearOverrides = useSessionSettingsOverridesStore((s) => s.clear);

  const { data: session } = useQuery({
    queryKey: ['session', sessionId, selectedCwd],
    queryFn: () => transport.getSession(sessionId!, selectedCwd ?? undefined),
    staleTime: 30_000,
    enabled: !!sessionId,
  });

  // Derive default model from useModels() data — no hardcoded fallback
  const defaultModel =
    models?.find((m: ModelOption) => m.isDefault)?.value ?? models?.[0]?.value ?? '';

  // Priority: local optimistic > streaming live data (only while streaming) > persisted session data > defaults
  // streamingStatus is never cleared after streaming ends, so streamingStatus?.model retains its
  // last value and would permanently shadow session?.model (the PATCH-confirmed value). Gate it
  // behind isStreaming so model changes via the dropdown are reflected immediately post-stream.
  const model =
    overrides.model ??
    (isStreaming ? streamingStatus?.model : null) ??
    session?.model ??
    defaultModel;

  // Context: derive from ModelOption.contextWindow (no hardcoded map)
  const selectedModel = models?.find((m: ModelOption) => m.value === model);
  const contextTokens = streamingStatus?.contextTokens ?? session?.contextTokens ?? null;
  const contextMaxTokens =
    streamingStatus?.contextMaxTokens ?? selectedModel?.contextWindow ?? null;

  const effort = overrides.effort ?? session?.effort ?? null;
  const fastMode = overrides.fastMode ?? session?.fastMode ?? false;

  const statusData: SessionStatusData = {
    permissionMode: overrides.permissionMode ?? session?.permissionMode ?? 'default',
    model,
    effort,
    fastMode,
    costUsd: streamingStatus?.costUsd ?? null,
    contextPercent: deriveContextPercent(contextTokens, contextMaxTokens),
    isStreaming,
    cwd: session?.cwd ?? null,
  };

  const updateSession = useCallback(
    async (opts: UpdateSessionRequest) => {
      // No-op when no session is active — the UI should only invoke this with a live session.
      if (!sessionId) return;

      // Apply optimistic update immediately, for every reader of this session
      const touched: SessionSettingsOverrideKey[] = [];
      if (opts.model) touched.push('model');
      if (opts.permissionMode) touched.push('permissionMode');
      if (opts.effort) touched.push('effort');
      if (opts.fastMode !== undefined) touched.push('fastMode');
      applyOverrides(sessionId, {
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
      });

      try {
        const updated = await transport.updateSession(sessionId, opts, selectedCwd ?? undefined);
        queryClient.setQueryData(
          ['session', sessionId, selectedCwd],
          (old: Session | undefined) => ({
            ...old,
            ...updated,
            // Preserve client-side model when not part of this PATCH request.
            // The PATCH response reads model from the disk transcript which may
            // use a different format (e.g. SDK ID "claude-opus-4-6") than the
            // option value the client selected (e.g. "default").
            ...(opts.model === undefined && old?.model !== undefined ? { model: old.model } : {}),
          })
        );
        // Optimistic state cleared by convergence effect below, not here.
        // This eliminates the render gap between setQueryData and useQuery re-render.
        return updated;
      } catch (err) {
        // Revert optimistic state on failure
        console.error('[useSessionStatus] updateSession failed for session', sessionId, err);
        clearOverrides(sessionId, touched);
      }
    },
    [transport, sessionId, selectedCwd, queryClient, applyOverrides, clearOverrides]
  );

  // Convergence effect: drop each optimistic override once server data confirms
  // it. This eliminates the render gap where the override is gone but the query
  // still holds the stale value. Idempotent across instances — `clear` returns
  // the same state when there is nothing to drop, so several `useSessionStatus`
  // instances running this effect notify the store at most once.
  useEffect(() => {
    if (!sessionId) return;
    const converged: SessionSettingsOverrideKey[] = [];
    if (overrides.model !== undefined && session?.model === overrides.model) {
      converged.push('model');
    }
    if (
      overrides.permissionMode !== undefined &&
      session?.permissionMode === overrides.permissionMode
    ) {
      converged.push('permissionMode');
    }
    if (overrides.effort !== undefined && session?.effort === overrides.effort) {
      converged.push('effort');
    }
    if (overrides.fastMode !== undefined && session?.fastMode === overrides.fastMode) {
      converged.push('fastMode');
    }
    if (converged.length > 0) clearOverrides(sessionId, converged);
  }, [
    sessionId,
    session?.model,
    session?.permissionMode,
    session?.effort,
    session?.fastMode,
    overrides,
    clearOverrides,
  ]);

  return { ...statusData, updateSession };
}
