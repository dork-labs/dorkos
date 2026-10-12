/**
 * The tool calls a turn made, with their arguments parsed: the reading the
 * `heartbeat` and `unblock` suites' oracles are built on. Both ask "which
 * calls did the model choose, with what arguments", and the stream carries a
 * call more than once while its arguments are still arriving, so the folding
 * lives here once rather than in each suite.
 *
 * @module evals/oracles/tool-calls
 */
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import { toolNameMatches } from './stream.js';

/** The parsed arguments of one tool call. */
export interface SeenToolCall {
  /** The tool name as the stream carried it (possibly MCP-qualified). */
  toolName: string;
  /** Its arguments, or null when they did not parse. */
  input: Record<string, unknown> | null;
  /** The call's id, when the stream carried one (what a permission prompt names). */
  toolCallId?: string;
}

/** Parse one argument string to an object, or null. */
function parseArgs(text: string): Record<string, unknown> | null {
  if (text === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** What the stream has said about one call's arguments so far. */
interface ArgPieces {
  /** Every `tool_call` piece, joined in order (Claude Code streams them). */
  joined: string;
  /** Every argument string seen, each on its own (a self-contained send). */
  whole: string[];
}

/**
 * Every tool call on the stream, in order of first appearance, with its
 * arguments parsed.
 *
 * **The arguments arrive in pieces.** Claude Code streams a call's arguments
 * as JSON fragments, one `tool_call` frame each (`tool_call_delta`,
 * `stream-event-mapper.ts`), and re-sends them whole only when no fragment
 * arrived (`message-event-mapper.ts`). Codex and OpenCode send them whole, on
 * the call or on its result. So the pieces of one call (by `toolCallId`) are
 * joined in order and the joined text is parsed, the way the audit trail does
 * (`audit/record-tool-use.ts`); when that does not parse, the last single
 * argument string that does is used instead (a whole re-send, or a whole input
 * on a `tool_result`). Reading each frame alone, as an earlier version did,
 * left almost every real Claude Code call with no arguments at all.
 *
 * @param frames - The session's frames.
 * @returns The calls, in order.
 */
export function seenToolCalls(frames: SseFrame[]): SeenToolCall[] {
  const calls: SeenToolCall[] = [];
  const pieces = new Map<SeenToolCall, ArgPieces>();
  const byId = new Map<string, SeenToolCall>();
  for (const frame of frames) {
    const data = frame.data as {
      type?: string;
      toolName?: string;
      toolCallId?: string;
      input?: unknown;
    };
    const type = data?.type ?? frame.event;
    if (type !== 'tool_call' && type !== 'tool_result') continue;
    const id = typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
    let call = id === undefined ? undefined : byId.get(id);
    if (!call) {
      // A result for a call never seen starting still names one, if it has a name.
      if (typeof data.toolName !== 'string' || data.toolName === '') continue;
      call = {
        toolName: data.toolName,
        input: null,
        ...(id !== undefined ? { toolCallId: id } : {}),
      };
      if (id !== undefined) byId.set(id, call);
      calls.push(call);
      pieces.set(call, { joined: '', whole: [] });
    }
    if (typeof data.input !== 'string' || data.input === '') continue;
    const seen = pieces.get(call)!;
    if (type === 'tool_call') seen.joined += data.input;
    seen.whole.push(data.input);
  }
  for (const call of calls) {
    const seen = pieces.get(call)!;
    call.input =
      parseArgs(seen.joined) ??
      seen.whole.reduceRight<Record<string, unknown> | null>(
        (found, text) => found ?? parseArgs(text),
        null
      );
  }
  return calls;
}

/**
 * The calls that name any of `names`, qualified or bare (see
 * {@link toolNameMatches}).
 *
 * @param frames - The session's frames.
 * @param names - Unqualified tool names, e.g. `connectors.execute_write`.
 * @returns The matching calls, in order.
 */
export function callsTo(frames: SseFrame[], names: readonly string[]): SeenToolCall[] {
  return seenToolCalls(frames).filter((call) =>
    names.some((name) => toolNameMatches(call.toolName, name))
  );
}
