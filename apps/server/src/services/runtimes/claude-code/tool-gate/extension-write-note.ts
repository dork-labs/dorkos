/**
 * Note each write a turn's file tools aim inside a mini app folder, with who made it, so path
 * trust can tell an edit by its author's own unheld turn from any other (DOR-4528,
 * `extensions/pin/path-trust-writers.ts`).
 *
 * Rides the `PreToolUse` hook for `Edit`, `Write`, `MultiEdit` and `NotebookEdit`, which fires in
 * every permission mode, Bypass included, and for a helper agent's calls as well as the main
 * thread's. Observe-only: it never holds, changes or refuses the tool. A write it could not read
 * is noted as held, so it can only make an edit wait.
 *
 * @module services/runtimes/claude-code/tool-gate/extension-write-note
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { editToolFilePath, isEditFamilyTool } from '@dorkos/shared/diff-tools';
import { marksOf } from '../../../core/turn-power/turn-levels.js';
import { marksHold } from '../../../core/turn-power/turn-marks.js';
import { noteExtensionWrite } from '../../../extensions/pin/path-trust-writers.js';
import { heldToACeiling } from '../turn-permission.js';

/** The real path of `target`, resolved through its nearest parent that exists. */
function realPathAsFarAsItExists(target: string): string {
  const rest: string[] = [];
  let at = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync.native(at), ...rest.reverse());
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return path.resolve(target);
      rest.push(path.basename(at));
      at = parent;
    }
  }
}

/**
 * The hook body that notes one file-tool write, when it is aimed inside an extensions folder.
 *
 * @param turn - The folder the turn stands in, its agent's home, and whether the turn is held now
 *   (a mark that holds, or a ceiling), read on each call.
 */
export function createExtensionWriteNote(turn: {
  cwd: string;
  agentHome: string | undefined;
  held: () => boolean;
}): (toolName: string, input: Record<string, unknown>) => void {
  return (toolName, input) => {
    if (!isEditFamilyTool(toolName)) return;
    const filePath = editToolFilePath(input);
    if (!filePath) return;
    const file = path.resolve(turn.cwd, filePath);
    try {
      noteExtensionWrite({
        file: realPathAsFarAsItExists(file),
        agentHome: turn.agentHome ? realPathAsFarAsItExists(turn.agentHome) : undefined,
        held: turn.held(),
      });
    } catch {
      // Unreadable: noted as no one's, so the edit waits.
      noteExtensionWrite({ file, agentHome: undefined, held: true });
    }
  };
}

/**
 * The `PreToolUse` matcher a launch adds: notes each file-tool write with the turn's agent, and
 * whether the turn is held right then (a ceiling, or a mark that holds, read through the session's
 * current id as the other hooks read it). Always answers `continue`.
 *
 * @param session - The session's ceilings and its runtime id once known.
 * @param turn - The launching session's id, the folder it stands in and its agent's home.
 */
export function extensionWriteMatcher(
  session: Parameters<typeof heldToACeiling>[0] & { sdkSessionId?: string },
  turn: { sessionId: string; cwd: string; agentHome: string | null | undefined }
): HookCallbackMatcher {
  const agentHome = turn.agentHome ?? undefined;
  const note = createExtensionWriteNote({
    cwd: turn.cwd,
    agentHome,
    held: () =>
      heldToACeiling(session) ||
      marksHold(marksOf(session.sdkSessionId || turn.sessionId, agentHome)),
  });
  return {
    matcher: 'Edit|Write|MultiEdit|NotebookEdit',
    hooks: [
      async (hookInput) => {
        if (hookInput.hook_event_name === 'PreToolUse') {
          note(hookInput.tool_name, (hookInput.tool_input ?? {}) as Record<string, unknown>);
        }
        return { continue: true };
      },
    ],
  };
}
