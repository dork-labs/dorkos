/**
 * The refusal an agent reads when its own mini apps folder is read-only this turn (DOR-4851).
 *
 * A marked or ceilinged turn keeps the agent's file tools out of its own `.dork/extensions/`
 * (`ownExtensionsWritable`, Security S1 on #3280). That deny rule stays the guard; Claude Code
 * answers it with a bare "permission denied" that names no rule, so an agent building an app for
 * a person in a room guessed, and handed the person a Terminal copy (FB-76). This `PreToolUse`
 * hook refuses the same writes first, with the rule and the route that works
 * ({@link ownExtensionsReadOnlyMessage}). It only ever refuses, never allows: an unheld turn, a
 * file outside the folder, a home whose folder is the global one, or any other tool gets no
 * answer from it.
 *
 * Held is read at launch and again at each call (through the session's current id), so a write
 * is refused if either says so. That can refuse a little more than the rule, which is fixed at
 * launch: a mark that arrives after the process started. A narrowing, on purpose.
 *
 * @module services/runtimes/claude-code/tool-gate/own-extensions-hook
 */
import path from 'node:path';
import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { editToolFilePath, isEditFamilyTool } from '@dorkos/shared/diff-tools';
import {
  isInOwnExtensions,
  ownExtensionsDeniable,
  ownExtensionsReadOnlyMessage,
  ownExtensionsWritable,
} from '../folder-settings/agent-extensions-deny.js';

/** The session's ceilings and its runtime id once known, as `ownExtensionsWritable` reads them. */
type HookSession = Parameters<typeof ownExtensionsWritable>[0] & { sdkSessionId?: string };

/**
 * The hook body. Refuses a file-tool write into the agent's own mini apps folder while the
 * turn may not write there, with a reason that names the rule and the route that works.
 *
 * @param session - The session's ceilings and its runtime id once known.
 * @param turn - The launching session's id, the folder it stands in and its agent's home.
 */
export function createOwnExtensionsHook(
  session: HookSession,
  turn: { sessionId: string; cwd: string; agentHome: string | null | undefined }
): HookCallback {
  // A home whose folder is the global one (a home of `~`) is never denied, so never refused here.
  const home = turn.agentHome && ownExtensionsDeniable(turn.agentHome) ? turn.agentHome : undefined;
  const heldNow = (): boolean => {
    if (!home) return false;
    try {
      return (
        ownExtensionsWritable(session, session.sdkSessionId || turn.sessionId, home) === undefined
      );
    } catch {
      // Unreadable: the deny rule decides, as it would without this hook.
      return false;
    }
  };
  const heldAtLaunch = heldNow();
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse' || !home) return {};
    if (!isEditFamilyTool(hookInput.tool_name)) return {};
    const target = editToolFilePath((hookInput.tool_input ?? {}) as Record<string, unknown>);
    if (!target) return {};
    const file = path.resolve(turn.cwd, target);
    if (!isInOwnExtensions(file, home)) return {};
    if (!heldAtLaunch && !heldNow()) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: ownExtensionsReadOnlyMessage(
          path.join(path.resolve(home), '.dork', 'extensions')
        ),
      },
    };
  };
}

/**
 * The matcher a launch adds to its `PreToolUse` list. A pattern with an anchor, never a bare
 * name list: the CLI reads a matcher of word characters and `|` alone as exact tool names.
 *
 * @param session - The session's ceilings and its runtime id once known.
 * @param turn - The launching session's id, the folder it stands in and its agent's home.
 */
export function ownExtensionsMatcher(
  session: HookSession,
  turn: { sessionId: string; cwd: string; agentHome: string | null | undefined }
): HookCallbackMatcher {
  return {
    matcher: '^(?:Edit|Write|MultiEdit|NotebookEdit)$',
    hooks: [createOwnExtensionsHook(session, turn)],
  };
}
