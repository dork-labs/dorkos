/**
 * Auto-open the diff review when the attached agent edits a file (DOR-212).
 *
 * Taps the shared StreamManager's per-session event side channel — the same seam
 * that dispatches `control_ui` commands — which is already gated to the ATTACHED
 * (foreground) session, so a background agent can never pop a diff over the
 * session the operator is watching. On a completed edit-family `tool_call` it
 * parses the file path and dispatches an `open_diff` at origin `'agent'`: the
 * canvas is revealed via the VIEW-ONLY tab setter, so it never overwrites the
 * operator's per-agent right-panel tab preference (DOR-227). Repeated edits to
 * one file coalesce onto a single diff document (the store dedups by path).
 *
 * Gated by `workbench.autoOpenDiff` (default on); the agent can still surface a
 * diff deliberately via the `open_diff` UI command regardless.
 *
 * @module features/diff-review/model/use-auto-open-diff
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { isEditFamilyTool, editToolFilePath } from '@dorkos/shared/diff-tools';
import { streamManager, executeUiCommand } from '@/layers/shared/lib';
import { useAppStore, useTransport } from '@/layers/shared/model';

/** Parse the `file_path` from a tool_call event's JSON `input`, or `null`. */
function filePathFromEvent(event: Extract<SessionEvent, { type: 'tool_call' }>): string | null {
  if (typeof event.input !== 'string' || event.input.length === 0) return null;
  try {
    const parsed = JSON.parse(event.input) as Record<string, unknown>;
    return editToolFilePath(parsed);
  } catch {
    return null;
  }
}

/**
 * Wire the auto-open-diff subscriber once, at the app shell. Renders nothing.
 * Reading the config flag reactively (via TanStack Query) keeps the toggle live
 * without a reload — the subscription re-binds when the flag flips, which is
 * rare.
 */
export function useAutoOpenDiff(): void {
  const transport = useTransport();
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 60_000,
  });
  const enabled = config?.workbench?.autoOpenDiff ?? true;

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = streamManager.subscribeSessionEvent((_sessionId, event) => {
      if (event.type !== 'tool_call' || event.status !== 'complete') return;
      if (!isEditFamilyTool(event.toolName)) return;
      const sourcePath = filePathFromEvent(event);
      if (!sourcePath) return;
      // Origin 'agent': reveal the canvas view-only so the operator's pinned tab
      // preference is untouched (DOR-227). The store coalesces repeated edits to
      // one diff document per path.
      executeUiCommand(
        { store: useAppStore.getState(), setTheme: () => {} },
        { action: 'open_diff', sourcePath },
        'agent'
      );
    });
    return unsubscribe;
  }, [enabled]);
}
