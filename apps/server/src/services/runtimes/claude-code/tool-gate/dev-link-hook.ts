/**
 * The refusal an agent reads when a dev-linked folder is read-only this turn (DOR-4896).
 *
 * A held turn's file tools may not write a dev-linked folder, whose edits run with no click
 * (`folder-settings/dev-link-deny.ts`). The launch's deny rules hold that for a turn held at
 * launch; this `PreToolUse` hook re-reads the turn and the links at each call, so a mark that
 * lands after the process started, or a link made since, is covered too, and the agent is told
 * why instead of a bare "permission denied". It only ever refuses, never allows: an unheld turn,
 * a file outside every dev-linked folder, or any other tool gets no answer from it.
 *
 * @module services/runtimes/claude-code/tool-gate/dev-link-hook
 */
import path from 'node:path';
import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { editToolFilePath, isEditFamilyTool } from '@dorkos/shared/diff-tools';
import { expandTilde } from '../../../../lib/boundary.js';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { isInsideAnyFolder } from '../folder-settings/agent-extensions-deny.js';
import {
  devLinkFolderNames,
  devLinkReadOnlyMessage,
  devLinksHeld,
} from '../folder-settings/dev-link-deny.js';
import { ownExtensionsMatcher } from './own-extensions-hook.js';

/** The session's ceilings and its runtime id once known, as `devLinksHeld` reads them. */
type HookSession = Parameters<typeof devLinksHeld>[0] & { sdkSessionId?: string };

/** What the hook knows about the launching turn. */
export interface DevLinkHookTurn {
  /** The launching session's id. */
  sessionId: string;
  /** The folder the turn stands in, for relative paths. */
  cwd: string;
  /** The turn's agent's home, when it runs as one. */
  agentHome: string | null | undefined;
  /** Every spelling of every dev-linked folder, read at each call. */
  devLinkFolders: () => Promise<readonly string[]>;
}

/**
 * The hook body. Refuses a file-tool write into a dev-linked folder while the turn is held.
 *
 * @param session - The session's ceilings and its runtime id once known.
 * @param turn - The launching turn, and how to read the dev-linked folders.
 */
export function createDevLinkHook(session: HookSession, turn: DevLinkHookTurn): HookCallback {
  const home = turn.agentHome ?? undefined;
  const heldNow = (): boolean => {
    try {
      return devLinksHeld(session, session.sdkSessionId || turn.sessionId, home);
    } catch {
      // Unreadable: it is asked only for a write into a dev-linked folder, so refuse that one.
      return true;
    }
  };
  const heldAtLaunch = heldNow();
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    if (!isEditFamilyTool(hookInput.tool_name)) return {};
    const target = editToolFilePath((hookInput.tool_input ?? {}) as Record<string, unknown>);
    if (!target) return {};
    // The CLI opens `~` itself, so the hook reads the path the same way.
    const file = path.resolve(turn.cwd, expandTilde(target));
    const folders = await turn.devLinkFolders();
    const folder = folders.find((name) => isInsideAnyFolder(file, [name]));
    if (folder === undefined) return {};
    if (!heldAtLaunch && !heldNow()) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: devLinkReadOnlyMessage(folder),
      },
    };
  };
}

/**
 * The matcher a launch adds to its `PreToolUse` list. A pattern with an anchor, never a bare
 * name list: the CLI reads a matcher of word characters and `|` alone as exact tool names.
 *
 * @param session - The session's ceilings and its runtime id once known.
 * @param turn - The launching turn, and how to read the dev-linked folders.
 */
export function devLinkMatcher(session: HookSession, turn: DevLinkHookTurn): HookCallbackMatcher {
  return {
    matcher: '^(?:Edit|Write|MultiEdit|NotebookEdit)$',
    hooks: [createDevLinkHook(session, turn)],
  };
}

/**
 * The `PreToolUse` matchers for the folders a held turn may not write: its own mini apps
 * (`own-extensions-hook.ts`) and every dev-linked folder ({@link devLinkMatcher}).
 *
 * @param session - The session's ceilings and its runtime id once known.
 * @param turn - The launching session's id, the folder it stands in and its agent's home.
 */
export function heldFolderMatchers(
  session: HookSession,
  turn: Omit<DevLinkHookTurn, 'devLinkFolders'>
): HookCallbackMatcher[] {
  return [
    ownExtensionsMatcher(session, turn),
    devLinkMatcher(session, {
      ...turn,
      devLinkFolders: () => devLinkFolderNames(resolveDorkHome()),
    }),
  ];
}
