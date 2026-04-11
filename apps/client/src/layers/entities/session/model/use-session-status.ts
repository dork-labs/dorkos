import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import { useModels } from './use-models';
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
  autoMode: boolean;
  costUsd: number | null;
  contextPercent: number | null; // 0-100
  isStreaming: boolean;
  cwd: string | null;
}

/**
 * Computes derived session status data from streaming events, API data, and
 * optimistic local overrides.
 *
 * @param sessionId - The active session ID, or null when no session is selected.
 *   When null, the session query is disabled and no API requests are made.
 * @param streamingStatus - Live status events received during streaming.
 * @param isStreaming - Whether a stream is currently active.
 */
export function useSessionStatus(
  sessionId: string | null,
  streamingStatus: SessionStatusEvent | null,
  isStreaming: boolean
) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const { data: models } = useModels();

  // Optimistic local overrides (applied immediately on user action)
  const [localModel, setLocalModel] = useState<string | null>(null);
  const [localPermissionMode, setLocalPermissionMode] = useState<PermissionMode | null>(null);
  const [localEffort, setLocalEffort] = useState<EffortLevel | null>(null);
  const [localFastMode, setLocalFastMode] = useState<boolean | null>(null);
  const [localAutoMode, setLocalAutoMode] = useState<boolean | null>(null);

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
    localModel ?? (isStreaming ? streamingStatus?.model : null) ?? session?.model ?? defaultModel;

  // Context: derive from ModelOption.contextWindow (no hardcoded map)
  const selectedModel = models?.find((m: ModelOption) => m.value === model);
  const contextTokens = streamingStatus?.contextTokens ?? session?.contextTokens ?? null;
  const contextMaxTokens =
    streamingStatus?.contextMaxTokens ?? selectedModel?.contextWindow ?? null;

  const effort = localEffort ?? session?.effort ?? null;
  const fastMode = localFastMode ?? session?.fastMode ?? false;
  const autoMode = localAutoMode ?? session?.autoMode ?? false;

  const statusData: SessionStatusData = {
    permissionMode: localPermissionMode ?? session?.permissionMode ?? 'default',
    model,
    effort,
    fastMode,
    autoMode,
    costUsd: streamingStatus?.costUsd ?? null,
    contextPercent:
      contextTokens && contextMaxTokens
        ? Math.min(100, Math.round((contextTokens / contextMaxTokens) * 100))
        : null,
    isStreaming,
    cwd: session?.cwd ?? null,
  };

  const updateSession = useCallback(
    async (opts: UpdateSessionRequest) => {
      // No-op when no session is active — the UI should only invoke this with a live session.
      if (!sessionId) return;

      // Apply optimistic update immediately
      if (opts.model) setLocalModel(opts.model);
      if (opts.permissionMode) setLocalPermissionMode(opts.permissionMode);
      if (opts.effort) setLocalEffort(opts.effort);
      if (opts.fastMode !== undefined) setLocalFastMode(opts.fastMode);
      if (opts.autoMode !== undefined) setLocalAutoMode(opts.autoMode);

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
        if (opts.model) setLocalModel(null);
        if (opts.permissionMode) setLocalPermissionMode(null);
        if (opts.effort) setLocalEffort(null);
        if (opts.fastMode !== undefined) setLocalFastMode(null);
        if (opts.autoMode !== undefined) setLocalAutoMode(null);
      }
    },
    [transport, sessionId, selectedCwd, queryClient]
  );

  // Convergence effect: clear optimistic overrides once server data confirms the value.
  // This eliminates the render gap where localModel is null but session?.model is stale.
  useEffect(() => {
    if (localModel !== null && session?.model === localModel) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing optimistic override once server confirms the value
      setLocalModel(null);
    }
    if (localPermissionMode !== null && session?.permissionMode === localPermissionMode) {
      setLocalPermissionMode(null);
    }
    if (localEffort !== null && session?.effort === localEffort) {
      setLocalEffort(null);
    }
    if (localFastMode !== null && session?.fastMode === localFastMode) {
      setLocalFastMode(null);
    }
    if (localAutoMode !== null && session?.autoMode === localAutoMode) {
      setLocalAutoMode(null);
    }
  }, [
    session?.model,
    session?.permissionMode,
    session?.effort,
    session?.fastMode,
    session?.autoMode,
    localModel,
    localPermissionMode,
    localEffort,
    localFastMode,
    localAutoMode,
  ]);

  return { ...statusData, updateSession };
}
