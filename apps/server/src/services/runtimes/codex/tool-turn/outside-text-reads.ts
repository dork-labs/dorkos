/**
 * Codex output that reaches a turn other than the one its command ran in (DOR-5240): a background
 * command that finishes in a later turn, or in the wake it starts (`app-server/background-work.ts`), and what
 * the model types into a command that is still running (`terminalInteraction`). The stream marks a
 * command's own turn when it starts (`audit/outside-text-stream.ts`); these mark the turn the
 * output is handed to, by the same rules (`shell-outside-text.ts`).
 *
 * It also maps what a running tool says while it runs, for the turn mapper: a command's output, an
 * MCP server's progress message, and typing into a command, which shows nothing.
 *
 * @module services/runtimes/codex/tool-turn/outside-text-reads
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { homeOf, resolveAgentHome, turnAgentOf } from '../../../core/agent-identity/agent-home.js';
import { markRunningTurnOutsider } from '../../../core/turn-power/turn-levels.js';
import { markChatTurnOutsideText } from '../../../audit/outside-text-stream.js';
import { scriptTextFetches } from '../../shared/tools/shell-network-commands.js';
import { commandReadsOutsideText } from '../../shared/tools/shell-outside-text.js';
import type { CallPlace } from '../../shared/tools/outside-file-places.js';

/** The command and the turn options a finished background command carries. */
export interface FinishedCommand {
  /** A command or a helper agent; only a command is judged here. */
  readonly kind: 'bash' | 'agent';
  /** The command line. */
  readonly label: string;
  /** The starting turn's options (`{ opts }`), when it kept them. */
  readonly context?: unknown;
}

/** Where the command ran, and the agent it ran as, from its turn's options. */
function placeOf(context: unknown): { place: CallPlace; agentHome?: string } {
  const opts = (context as { opts?: MessageOpts } | undefined)?.opts;
  let agentHome: string | undefined;
  try {
    agentHome = homeOf(resolveAgentHome(opts?.cwd, turnAgentOf(opts)));
  } catch {
    // No agent to name: the chat's own turn is marked all the same.
  }
  return {
    place: {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(agentHome ? { agentHome } : {}),
    },
    ...(agentHome ? { agentHome } : {}),
  };
}

/** Whether a command's text reads outside words; one that cannot be judged does. */
function reads(command: string, place: CallPlace): boolean {
  try {
    return commandReadsOutsideText(command, place);
  } catch {
    return true;
  }
}

/**
 * Mark the session's running turn when a finished background command read outside words: its
 * output is what that turn, or the wake it starts, now hands the model.
 *
 * @param sessionId - The session the output goes to.
 * @param finished - What finished.
 */
export function markFinishedCommand(sessionId: string, finished: FinishedCommand): void {
  if (finished.kind !== 'bash') return;
  const { place, agentHome } = placeOf(finished.context);
  if (!reads(finished.label, place)) return;
  if (agentHome) markRunningTurnOutsider(sessionId, agentHome, { kind: 'tool' });
  else markChatTurnOutsideText(sessionId);
}

/**
 * Mark the session's running turn when what the model typed into a running command reads outside
 * words: a command line typed into a shell, or a script's network call typed into an interpreter.
 *
 * @param sessionId - The session the command runs in.
 * @param stdin - What was typed.
 */
export function markTerminalInput(sessionId: string, stdin: string): void {
  if (reads(stdin, {}) || scriptTextFetches(stdin)) markChatTurnOutsideText(sessionId);
}

/** The notifications a running tool sends. */
export type RunningToolMethod =
  | 'item/commandExecution/outputDelta'
  | 'item/commandExecution/terminalInteraction'
  | 'item/mcpToolCall/progress';

/**
 * The events one running tool's notification means.
 *
 * @param sessionId - The DorkOS session the turn runs in.
 * @param method - The notification.
 * @param params - Its params.
 */
export function runningToolProgress(
  sessionId: string,
  method: RunningToolMethod,
  params: Record<string, unknown>
): StreamEvent[] {
  const toolCallId = String(params.itemId);
  switch (method) {
    case 'item/commandExecution/outputDelta': {
      const delta = String(params.delta);
      return delta ? [{ type: 'tool_progress', data: { toolCallId, content: delta } }] : [];
    }
    case 'item/commandExecution/terminalInteraction':
      markTerminalInput(sessionId, String(params.stdin ?? ''));
      return [];
    case 'item/mcpToolCall/progress':
      return [{ type: 'tool_progress', data: { toolCallId, content: String(params.message) } }];
  }
}
