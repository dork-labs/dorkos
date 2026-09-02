import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTransport, useAppStore } from '@/layers/shared/model';
import { useModels } from './use-models';
import { useSessionDetail } from './use-session-detail';
import {
  useSessionSettingsOverride,
  useSessionSettingsOverridesStore,
  type SessionSettingsOverride,
} from './session-settings-overrides';
// Same-slice imports via sibling modules (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../api/query-keys';
import { deriveContextPercent } from '../lib/context-health';
import { resolvePermissionMode } from '../lib/permission-mode';
import type {
  Session,
  SessionStatusEvent,
  EffortLevel,
  ModelOption,
  UpdateSessionRequest,
} from '@dorkos/shared/types';

/** Optional per-call reactions to a settings write. */
export interface UpdateSessionHandlers {
  /**
   * Called when the write failed, after the optimistic state has been rolled
   * back. Opt-in: a caller that does not pass one keeps today's behavior, where
   * the failure is logged and the UI simply returns to what the server says.
   *
   * The one caller that needs it is the Trust Dial: a refused Full-autonomy
   * change (`428 AUTONOMY_ACK_REQUIRED`) is not a fault to report but a question
   * to ask, so it opens the confirmation dialog instead of a red toast.
   */
  onError?: (error: unknown) => void;
}

export interface SessionStatusData {
  /**
   * Any id the session's own runtime reports (DOR-851; `test-mode`'s ids sit
   * outside the {@link PermissionMode} enum on purpose) — a display value read
   * off descriptors downstream, or through `isBypassPermissionMode`, never
   * compared against a literal. `string` rather than `PermissionMode` so
   * every reader states that honestly instead of narrowing with a cast
   * (DOR-820).
   */
  permissionMode: string;
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

  const { data: session } = useSessionDetail(sessionId);

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
    // `session.permissionMode` carries any id the session's own runtime
    // reports (DOR-851; `test-mode`'s ids sit outside the `PermissionMode`
    // enum on purpose), so `SessionStatusData.permissionMode` is `string`
    // (DOR-820) — a DISPLAY value read off descriptors downstream, or through
    // `isBypassPermissionMode` (bypass-alias-aware, e.g. `always-allow`). A
    // literal `=== 'bypassPermissions'` compare against it IS a bug (the
    // session's status strip used to have one) — use `isBypassPermissionMode`
    // for any bypass check, never a raw literal.
    permissionMode: resolvePermissionMode(overrides.permissionMode, session?.permissionMode),
    model,
    effort,
    fastMode,
    costUsd: streamingStatus?.costUsd ?? null,
    contextPercent: deriveContextPercent(contextTokens, contextMaxTokens),
    isStreaming,
    cwd: session?.cwd ?? null,
  };

  const updateSession = useCallback(
    async (opts: UpdateSessionRequest, handlers?: UpdateSessionHandlers) => {
      // No-op when no session is active — the UI should only invoke this with a live session.
      if (!sessionId) return;

      // Apply optimistic update immediately, for every reader of this session.
      // Held onto so the failure path can revert exactly these values — see the
      // `clear` contract: reverting by KEY would clobber a later writer.
      const applied: SessionSettingsOverride = {
        ...(opts.model ? { model: opts.model } : {}),
        // A request carries any id the session's runtime declares, which is
        // wider than the shared enum names (DOR-811) — the picker already hands
        // this hook descriptor ids verbatim. The override is a DISPLAY value
        // that rides the same rendering path as the runtime's own reported mode,
        // so the id passes through unchanged; nothing here reads meaning off the
        // name.
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
      };
      applyOverrides(sessionId, applied);

      // Say which runtime these settings are FOR. Before a session's first
      // message the server has no owner recorded for it, so it can only infer
      // one — and a model id belongs to exactly one runtime's namespace, so an
      // OpenCode model judged against Claude Code's catalog is refused every
      // time. This hook is already handed the resolved runtime (the same value
      // the chip displays and the model picker was filled from), so the request
      // carries it. The server treats it as a hint on an unbound session and
      // ignores it entirely on a bound one — it cannot bind or re-bind anything
      // (ADR-0255). An explicit `opts.runtime` from a caller still wins.
      const request: UpdateSessionRequest = { ...(runtime ? { runtime } : {}), ...opts };

      try {
        // The pending flag is a fact about THIS write, not about the session, so
        // it is split off before anything is cached: leaving it on the session
        // would keep saying "starts on your next reply" long after that reply
        // happened (DOR-1435).
        const { permissionModePendingUntilNextTurn, ...updated } = await transport.updateSession(
          sessionId,
          request,
          selectedCwd ?? undefined
        );
        if (permissionModePendingUntilNextTurn) {
          // The dial moves either way — the choice IS saved, and reverting it
          // would be the bigger lie. What the person is owed is the one thing
          // the dial cannot show: the reply already running did not get the
          // message, so it is still working under the looser setting.
          toast.warning('Saved · starts on your next message', {
            description: 'The reply already running keeps the permission setting it started with.',
          });
        }
        queryClient.setQueryData(
          sessionKeys.detail(sessionId, selectedCwd),
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
        // Revert our own optimistic state on failure — and only ours. If another
        // surface applied a newer value to the same key while this request was in
        // flight, that value is still pending and must survive this rollback.
        console.error('[useSessionStatus] updateSession failed for session', sessionId, err);
        clearOverrides(sessionId, applied);
        // Handed to the caller AFTER the rollback, so whatever it draws is drawn
        // over settled state. Swallowed when nobody asked for it — the reason
        // this is opt-in rather than a rethrow is that most callers here are
        // fire-and-forget, and rethrowing would turn every dropped connection
        // into an unhandled rejection.
        handlers?.onError?.(err);
      }
    },
    [transport, sessionId, runtime, selectedCwd, queryClient, applyOverrides, clearOverrides]
  );

  // Convergence effect: drop each optimistic override once server data confirms
  // it. This eliminates the render gap where the override is gone but the query
  // still holds the stale value. Idempotent across instances — `clear` returns
  // the same state when there is nothing to drop, so several `useSessionStatus`
  // instances running this effect notify the store at most once.
  useEffect(() => {
    if (!sessionId) return;
    const converged: SessionSettingsOverride = {};
    if (overrides.model !== undefined && session?.model === overrides.model) {
      converged.model = overrides.model;
    }
    if (
      overrides.permissionMode !== undefined &&
      session?.permissionMode === overrides.permissionMode
    ) {
      converged.permissionMode = overrides.permissionMode;
    }
    if (overrides.effort !== undefined && session?.effort === overrides.effort) {
      converged.effort = overrides.effort;
    }
    if (overrides.fastMode !== undefined && session?.fastMode === overrides.fastMode) {
      converged.fastMode = overrides.fastMode;
    }
    if (Object.keys(converged).length > 0) clearOverrides(sessionId, converged);
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
