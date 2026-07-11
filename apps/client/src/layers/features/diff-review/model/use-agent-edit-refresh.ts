/**
 * Live-refresh an open diff when the agent edits its file again (DOR-212).
 *
 * A repeated agent edit re-activates the existing diff document (the store
 * dedups by `diff:<sourcePath>`) WITHOUT remounting it, so nothing would
 * otherwise refetch — the operator would be judging a stale "after". This hook
 * taps the same attached-session event seam the auto-open subscriber uses and
 * fires the caller's refresh when a completed edit-family `tool_call` lands on
 * THIS file: the text surface revalidates its baseline query, the image
 * surface bumps its cache-busting layer version. Bursts of edits coalesce
 * through a short debounce so one agent loop doesn't refetch per keystroke.
 *
 * @module features/diff-review/model/use-agent-edit-refresh
 */
import { useEffect, useRef } from 'react';
import { isEditFamilyTool, editToolFilePath } from '@dorkos/shared/diff-tools';
import { streamManager } from '@/layers/shared/lib';

/** Debounce for agent-edit bursts (matches the renderer-refresh spirit of the spec). */
const AGENT_EDIT_REFRESH_DEBOUNCE_MS = 400;

/**
 * Whether an edit event's path and an open diff's `sourcePath` refer to the
 * same file. The auto-open dispatch uses the tool input's path VERBATIM as the
 * document's `sourcePath`, so the common case is exact equality; normalizing
 * both against the session cwd additionally matches an absolute event path to
 * a relative document path (or vice versa).
 */
function sameFile(eventPath: string, sourcePath: string, cwd: string | null): boolean {
  if (eventPath === sourcePath) return true;
  if (cwd === null) return false;
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  const rel = (p: string) => {
    let s = p.replace(/\\/g, '/');
    if (s.startsWith(root)) s = s.slice(root.length);
    return s.replace(/^\.\//, '');
  };
  return rel(eventPath) === rel(sourcePath);
}

/**
 * Subscribe an open diff surface to the attached session's edit events and
 * invoke `onAgentEdit` (debounced) whenever the agent edits `sourcePath` again,
 * so the visible diff always reflects the latest disk state.
 *
 * @param cwd - Session working directory (for absolute↔relative path matching).
 * @param sourcePath - The file the open diff reviews.
 * @param onAgentEdit - Refresh callback (revalidate the query / bump the image
 *   version). Read through a ref, so a changing identity never re-subscribes.
 */
export function useAgentEditRefresh(
  cwd: string | null,
  sourcePath: string,
  onAgentEdit: () => void
): void {
  const onAgentEditRef = useRef(onAgentEdit);
  useEffect(() => {
    onAgentEditRef.current = onAgentEdit;
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = streamManager.subscribeSessionEvent((_sessionId, event) => {
      if (event.type !== 'tool_call' || event.status !== 'complete') return;
      if (!isEditFamilyTool(event.toolName)) return;
      if (typeof event.input !== 'string' || event.input.length === 0) return;
      let eventPath: string | null;
      try {
        eventPath = editToolFilePath(JSON.parse(event.input) as Record<string, unknown>);
      } catch {
        return;
      }
      if (!eventPath || !sameFile(eventPath, sourcePath, cwd)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onAgentEditRef.current();
      }, AGENT_EDIT_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [cwd, sourcePath]);
}
