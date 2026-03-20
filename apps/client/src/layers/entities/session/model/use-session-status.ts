import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import type {
  Session,
  SessionStatusEvent,
  PermissionMode,
  UpdateSessionRequest,
} from '@dorkos/shared/types';

/** Default model for new sessions before any SDK interaction. */
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

/** Known context window sizes (tokens) by model ID prefix. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4': 200_000,
  'claude-sonnet-3': 200_000,
  'claude-haiku-3': 200_000,
};

function getContextWindowForModel(model: string): number | null {
  for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(prefix)) return size;
  }
  return null;
}

export interface SessionStatusData {
  permissionMode: PermissionMode;
  model: string;
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

  // Optimistic local overrides (applied immediately on user action)
  const [localModel, setLocalModel] = useState<string | null>(null);
  const [localPermissionMode, setLocalPermissionMode] = useState<PermissionMode | null>(null);

  const { data: session } = useQuery({
    queryKey: ['session', sessionId, selectedCwd],
    queryFn: () => transport.getSession(sessionId!, selectedCwd ?? undefined),
    staleTime: 30_000,
    enabled: !!sessionId,
  });

  // Priority: local optimistic > streaming live data (only while streaming) > persisted session data > defaults
  // streamingStatus is never cleared after streaming ends, so streamingStatus?.model retains its
  // last value and would permanently shadow session?.model (the PATCH-confirmed value). Gate it
  // behind isStreaming so model changes via the dropdown are reflected immediately post-stream.
  const model =
    localModel ?? (isStreaming ? streamingStatus?.model : null) ?? session?.model ?? DEFAULT_MODEL;

  // Context: prefer streaming max, fall back to known model context window
  const contextTokens = streamingStatus?.contextTokens ?? session?.contextTokens ?? null;
  const contextMaxTokens = streamingStatus?.contextMaxTokens ?? getContextWindowForModel(model);

  const statusData: SessionStatusData = {
    permissionMode: localPermissionMode ?? session?.permissionMode ?? 'default',
    model,
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

      try {
        const updated = await transport.updateSession(sessionId, opts, selectedCwd ?? undefined);
        queryClient.setQueryData(
          ['session', sessionId, selectedCwd],
          (old: Session | undefined) => ({ ...old, ...updated })
        );
        // Optimistic state cleared by convergence effect below, not here.
        // This eliminates the render gap between setQueryData and useQuery re-render.
        return updated;
      } catch (err) {
        // Revert optimistic state on failure
        console.error('[useSessionStatus] updateSession failed for session', sessionId, err);
        if (opts.model) setLocalModel(null);
        if (opts.permissionMode) setLocalPermissionMode(null);
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
  }, [session?.model, session?.permissionMode, localModel, localPermissionMode]);

  return { ...statusData, updateSession };
}
