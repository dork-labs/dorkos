import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import type { SessionStatusEvent, PermissionMode, UpdateSessionRequest } from '@dorkos/shared/types';

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

export function useSessionStatus(
  sessionId: string,
  streamingStatus: SessionStatusEvent | null,
  isStreaming: boolean,
) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const selectedCwd = useAppStore((s) => s.selectedCwd);

  // Optimistic local overrides (applied immediately on user action)
  const [localModel, setLocalModel] = useState<string | null>(null);
  const [localPermissionMode, setLocalPermissionMode] = useState<PermissionMode | null>(null);

  const { data: session } = useQuery({
    queryKey: ['session', sessionId, selectedCwd],
    queryFn: () => transport.getSession(sessionId, selectedCwd ?? undefined),
    staleTime: 30_000,
  });

  // Priority: local optimistic > streaming live data > persisted session data > defaults
  const model = localModel ?? streamingStatus?.model ?? session?.model ?? DEFAULT_MODEL;

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

  const updateSession = useCallback(async (opts: UpdateSessionRequest) => {
    // Apply optimistic update immediately
    if (opts.model) setLocalModel(opts.model);
    if (opts.permissionMode) setLocalPermissionMode(opts.permissionMode);

    try {
      const updated = await transport.updateSession(sessionId, opts, selectedCwd ?? undefined);
      queryClient.setQueryData(['session', sessionId, selectedCwd], updated);
      // Clear optimistic overrides — server data is now authoritative
      if (opts.model) setLocalModel(null);
      if (opts.permissionMode) setLocalPermissionMode(null);
      return updated;
    } catch {
      // Revert optimistic state on failure
      if (opts.model) setLocalModel(null);
      if (opts.permissionMode) setLocalPermissionMode(null);
    }
  }, [transport, sessionId, selectedCwd, queryClient]);

  return { ...statusData, updateSession };
}
