/**
 * Mark the turn when a call that reads outside text shows in its stream (DOR-3969, DOR-5236): a web
 * search, a page fetch, another MCP server's tool, a shell command that fetches from the network, a
 * file read in a folder of outside files (`runtimes/shared/tools/outside-text-tools.ts` decides).
 * Codex, OpenCode and Doe have no hook that runs before a tool, so this is where they are seen, and
 * a send the model makes once the result is back is held. Claude Code is marked earlier, by its
 * `PreToolUse` hook, and again here, which changes nothing.
 *
 * A call is judged by its name as it starts, and again by its input once that is whole: Codex,
 * OpenCode and Doe send the input with the start, Claude Code streams it in pieces and closes it
 * with `tool_call_end`.
 *
 * A helper those runtimes start runs where this stream may not show its tools (Codex runs one in a
 * thread of its own), so starting one marks the turn too. Claude Code's hook sees a helper's calls.
 *
 * Not guarded like the audit recording: a mark that cannot be placed ends the turn rather than
 * letting it go on unmarked, and a call that cannot be judged counts as one that reads outside text.
 *
 * @module services/audit/outside-text-stream
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { homeOf, resolveAgentHome, turnAgentOf } from '../core/agent-identity/agent-home.js';
import { markRunningTurnOutsider } from '../core/turn-power/turn-levels.js';
import type { CallPlace } from '../runtimes/shared/tools/outside-file-places.js';
import { toolReadsOutsideText } from '../runtimes/shared/tools/outside-text-tools.js';

/** The most of a call's streamed input kept; past it the input no longer parses, and a command marks. */
const MAX_STREAMED_INPUT = 200_000;

/**
 * A safety bound on running turns' markers, for streams nobody closed: far above how many turns
 * one computer runs at once, so a running chat is not dropped.
 */
const MAX_TURN_MARKERS = 10_000;
/** Each chat's running turn's mark, which knows the agent the turn acts as; dropped at its end. */
const turnMarkers = new Map<string, () => void>();

/**
 * Mark a chat's running turn as one that read outside text, from a runtime's own notice that is
 * not a tool call (what Codex is typed into a running command): with the agent its latest turn
 * acts as, so callers that name only the agent see the mark too.
 *
 * @param sessionId - The chat.
 */
export function markChatTurnOutsideText(sessionId: string): void {
  const mark = turnMarkers.get(sessionId);
  if (mark) mark();
  else markRunningTurnOutsider(sessionId, undefined, { kind: 'tool' });
}

/** A turn's watcher: hand it each event, and end it when the turn's stream ends. */
export type OutsideTextMarker = ((event: StreamEvent) => void) & {
  /** The turn's stream ended: the chat's running-turn mark no longer names this turn. */
  end: () => void;
};

/** A call seen in this turn and not yet judged by its whole input. */
interface OpenCall {
  name: string;
  input: string;
}

/** Read a tool event's id, name and input defensively. */
function fieldsOf(event: StreamEvent): { id: string; name: string; input?: string } {
  const data = (event.data ?? {}) as Record<string, unknown>;
  return {
    id: typeof data.toolCallId === 'string' ? data.toolCallId : '',
    name: typeof data.toolName === 'string' ? data.toolName : '',
    ...(typeof data.input === 'string' ? { input: data.input } : {}),
  };
}

/**
 * A watcher for one turn's stream that marks the turn when a call in it reads outside text.
 *
 * @param runtime - The runtime's type.
 * @param sessionId - The chat the turn runs in.
 * @param opts - The turn's options: its working folder and the agent it acts as.
 * @returns A function to hand each event to, before it is passed on, and `end` to call when the
 *   turn's stream ends.
 */
export function outsideTextMarker(
  runtime: string,
  sessionId: string,
  opts: MessageOpts | undefined
): OutsideTextMarker {
  const open = new Map<string, OpenCall>();
  /** Calls already judged by their whole input, or marked: neither is judged again. */
  const settled = new Set<string>();
  let agentHome: string | undefined;
  let place: CallPlace | undefined;
  const placeOf = (): CallPlace => {
    if (place) return place;
    agentHome = homeOf(resolveAgentHome(opts?.cwd, turnAgentOf(opts)));
    place = {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(agentHome ? { agentHome } : {}),
    };
    return place;
  };
  const mark = (): void => {
    placeOf();
    markRunningTurnOutsider(sessionId, agentHome, { kind: 'tool' });
  };
  turnMarkers.delete(sessionId);
  turnMarkers.set(sessionId, mark);
  if (turnMarkers.size > MAX_TURN_MARKERS) turnMarkers.delete(turnMarkers.keys().next().value!);
  const reads = (name: string, input: string | undefined): boolean => {
    try {
      return toolReadsOutsideText(runtime, name, input === '' ? undefined : input, placeOf());
    } catch {
      return true;
    }
  };

  const watch = (event: StreamEvent): void => {
    if (event.type === 'background_task_started') {
      if (runtime === 'claude-code') return;
      if ((event.data as { taskType?: unknown } | undefined)?.taskType === 'agent') mark();
      return;
    }
    if (
      event.type !== 'tool_call_start' &&
      event.type !== 'tool_call_delta' &&
      event.type !== 'tool_call_end' &&
      event.type !== 'tool_result'
    ) {
      return;
    }
    const fields = fieldsOf(event);
    if (!fields.id) {
      if (event.type === 'tool_call_start' && reads(fields.name, fields.input)) mark();
      return;
    }
    if (settled.has(fields.id)) return;
    let call = open.get(fields.id);
    if (!call) {
      if (!fields.name) return;
      call = { name: fields.name, input: '' };
      open.set(fields.id, call);
    }
    if (fields.input !== undefined) {
      call.input = (
        event.type === 'tool_call_delta' ? call.input + fields.input : fields.input
      ).slice(0, MAX_STREAMED_INPUT);
    }
    // Mid-stream pieces wait for the whole input; the start is judged by its name, and by its input
    // when it came whole.
    if (event.type === 'tool_call_delta') return;
    const readsOutside = reads(call.name, call.input);
    // Claude Code's start may carry only the first piece; its input is whole at `tool_call_end`.
    const whole =
      call.input !== '' && (runtime !== 'claude-code' || event.type !== 'tool_call_start');
    if (readsOutside || whole || event.type === 'tool_result') {
      settled.add(fields.id);
      open.delete(fields.id);
    }
    if (readsOutside) mark();
  };
  return Object.assign(watch, {
    end: () => {
      if (turnMarkers.get(sessionId) === mark) turnMarkers.delete(sessionId);
    },
  });
}
