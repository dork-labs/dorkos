/**
 * A Claude Code tool call that reads outside text marks its turn before it runs (DOR-3969, spec
 * §4.7): `WebFetch`, `WebSearch`, any MCP server's tool but DorkOS's own, a `Bash` command that
 * fetches from the network, and a `Read` or `Grep` in a folder of outside files (DOR-5236;
 * `shared/tools/outside-text-tools.ts` decides which).
 *
 * A `PreToolUse` hook, because it fires in every mode, `bypassPermissions` included, for a helper's
 * calls as well as the turn's own, and before the tool runs. So the page is never in the model's
 * hands before the mark is, and a send the model makes after reading it is already held. The hook
 * only marks: it never asks or changes the call. A later hook may still refuse the call; the mark
 * stays, which is the safer side. A mark that cannot be placed refuses the call instead, since a
 * hook that throws would let the tool run unmarked.
 *
 * @module services/runtimes/claude-code/tool-gate/outside-text-hook
 */
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { markRunningTurnOutsider } from '../../../core/turn-power/turn-levels.js';
import {
  CLAUDE_CODE_OUTSIDE_TEXT_MATCHER,
  toolReadsOutsideText,
} from '../../shared/tools/outside-text-tools.js';

/** What the model is told when the turn could not be marked, so the read did not run. */
export const UNMARKED_REFUSAL =
  'DorkOS could not record that this turn reads outside text, so this tool did not run.';

/**
 * The `PreToolUse` entry for one launch.
 *
 * @param sessionId - The chat's current id, read at call time: the CLI may rename it mid-turn.
 * @param agentPath - The agent the turn acts as, from its verified identity, if any.
 */
export function outsideTextHookMatcher(
  sessionId: () => string,
  agentPath?: string | null
): HookCallbackMatcher {
  return {
    matcher: CLAUDE_CODE_OUTSIDE_TEXT_MATCHER,
    hooks: [
      async (hookInput) => {
        if (hookInput.hook_event_name !== 'PreToolUse') return {};
        const place = {
          ...(typeof hookInput.cwd === 'string' ? { cwd: hookInput.cwd } : {}),
          ...(agentPath ? { agentHome: agentPath } : {}),
        };
        const input = 'tool_input' in hookInput ? hookInput.tool_input : undefined;
        let reads: boolean;
        try {
          reads = toolReadsOutsideText('claude-code', hookInput.tool_name, input, place);
        } catch {
          // A call that could not be read counts as one that reads outside text.
          reads = true;
        }
        if (!reads) return {};
        try {
          markRunningTurnOutsider(sessionId(), agentPath ?? undefined, { kind: 'tool' });
          return {};
        } catch {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: UNMARKED_REFUSAL,
            },
          };
        }
      },
    ],
  };
}
