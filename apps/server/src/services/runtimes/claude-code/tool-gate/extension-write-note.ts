/**
 * Note each write a turn's file tools make inside a mini app folder, with who made it and the
 * exact bytes it was asked to leave, so path trust can tell an edit by its author's own unheld
 * turn from any other (DOR-4528, `extensions/pin/path-trust-writers.ts`).
 *
 * Rides the hooks for `Edit`, `Write`, `MultiEdit` and `NotebookEdit`: `PreToolUse` notes the
 * write before it runs, `PostToolUse` completes it, `PostToolUseFailure` drops it. They fire in
 * every permission mode, Bypass included, and for a helper agent's calls as well as the main
 * thread's. Observe-only: nothing here holds, changes or refuses a tool. A write whose result
 * cannot be worked out (a notebook cell, an edit whose text is not found exactly once) vouches for
 * nothing, so it can only make an edit wait.
 *
 * @module services/runtimes/claude-code/tool-gate/extension-write-note
 */
import path from 'node:path';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { editToolFilePath, isEditFamilyTool } from '@dorkos/shared/diff-tools';
import { resolveCanonicalPath } from '../../../../lib/boundary.js';
import { marksOf } from '../../../core/turn-power/turn-levels.js';
import { marksHold } from '../../../core/turn-power/turn-marks.js';
import {
  noteWriteDone,
  noteWriteFailed,
  noteWriteStarting,
  type ExpectedAfter,
} from '../../../extensions/pin/path-trust-writers.js';
import { heldToACeiling } from '../turn-permission.js';

/** The file tools whose writes are noted. */
const FILE_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit';

/** One text replacement, as `Edit` and each `MultiEdit` step make it; `null` when it would fail. */
function replaced(text: string | null, edit: unknown): string | null {
  if (typeof edit !== 'object' || edit === null) return null;
  const { old_string: from, new_string: to, replace_all: all } = edit as Record<string, unknown>;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  // An empty `old_string` makes a new file.
  if (text === null) return from === '' ? to : null;
  if (from === '') return null;
  if (all === true) return text.split(from).join(to);
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) return null;
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/**
 * How to work out the bytes a file tool's call should leave, from the bytes before it.
 *
 * @param toolName - The tool.
 * @param input - Its input.
 */
export function expectedAfterOf(toolName: string, input: Record<string, unknown>): ExpectedAfter {
  return (before) => {
    const text = before === null ? null : before.toString('utf8');
    let after: string | null = null;
    if (toolName === 'Write') after = typeof input.content === 'string' ? input.content : null;
    else if (toolName === 'Edit') after = replaced(text, input);
    else if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
      // Only the first step can meet no file; a step that fails ends it.
      after = text;
      for (const edit of input.edits) {
        after = replaced(after, edit);
        if (after === null) break;
      }
    }
    return after === null ? null : Buffer.from(after, 'utf8');
  };
}

/**
 * The hook body that notes one file-tool write as it starts, when it is aimed inside an
 * extensions folder.
 *
 * @param turn - The folder the turn stands in, its agent's home, and whether the turn is held now
 *   (a mark that holds, or a ceiling), read on each call.
 */
export function createExtensionWriteNote(turn: {
  cwd: string;
  agentHome: string | undefined;
  held: () => boolean;
}): (callId: string, toolName: string, input: Record<string, unknown>) => Promise<void> {
  return async (callId, toolName, input) => {
    if (!isEditFamilyTool(toolName)) return;
    const filePath = editToolFilePath(input);
    if (!filePath) return;
    const file = path.resolve(turn.cwd, filePath);
    const expect = expectedAfterOf(toolName, input);
    try {
      await noteWriteStarting(
        callId,
        {
          file: await resolveCanonicalPath(file),
          agentHome: turn.agentHome ? await resolveCanonicalPath(turn.agentHome) : undefined,
          held: turn.held(),
        },
        expect
      );
    } catch {
      // Unreadable: noted as no one's, so it vouches for nothing.
      await noteWriteStarting(callId, { file, agentHome: undefined, held: true }, expect);
    }
  };
}

/**
 * The `PreToolUse` matcher a launch adds: notes each file-tool write as it starts, with the
 * turn's agent and whether the turn is held right then (a ceiling, or a mark that holds, read
 * through the session's current id as the other hooks read it). Always answers `continue`.
 *
 * @param session - The session's ceilings and its runtime id once known.
 * @param turn - The launching session's id, the folder it stands in and its agent's home.
 */
export function noteWritesBefore(
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
    matcher: FILE_TOOLS,
    hooks: [
      async (hookInput, toolUseId) => {
        if (hookInput.hook_event_name === 'PreToolUse') {
          const input = (hookInput.tool_input ?? {}) as Record<string, unknown>;
          await note(hookInput.tool_use_id ?? toolUseId ?? '', hookInput.tool_name, input);
        }
        return { continue: true };
      },
    ],
  };
}

/**
 * The `PostToolUse` and `PostToolUseFailure` matcher a launch adds: completes a noted write that
 * succeeded, and drops one that failed. Always answers `continue`.
 */
export const NOTE_WRITES_AFTER: HookCallbackMatcher = {
  matcher: FILE_TOOLS,
  hooks: [
    async (hookInput, toolUseId) => {
      const callId = ('tool_use_id' in hookInput ? hookInput.tool_use_id : toolUseId) ?? '';
      if (hookInput.hook_event_name === 'PostToolUse') await noteWriteDone(callId);
      else if (hookInput.hook_event_name === 'PostToolUseFailure') noteWriteFailed(callId);
      return { continue: true };
    },
  ],
};
