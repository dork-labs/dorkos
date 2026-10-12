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
}

/**
 * Every tool call on the stream, in order of first appearance, with its
 * arguments parsed. A call the stream carried more than once (its arguments
 * still streaming, then complete) is kept once, with the last arguments that
 * parse: the complete call, never a partial one.
 *
 * @param frames - The session's frames.
 * @returns The calls, in order.
 */
export function seenToolCalls(frames: SseFrame[]): SeenToolCall[] {
  const calls: SeenToolCall[] = [];
  const byId = new Map<string, SeenToolCall>();
  for (const frame of frames) {
    const data = frame.data as {
      type?: string;
      toolName?: string;
      toolCallId?: string;
      input?: unknown;
    };
    const type = data?.type ?? frame.event;
    if (type !== 'tool_call' || typeof data.toolName !== 'string') continue;
    const id = data.toolCallId ?? `${calls.length}`;
    let input: Record<string, unknown> | null = null;
    if (typeof data.input === 'string') {
      try {
        const parsed: unknown = JSON.parse(data.input);
        if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
      } catch {
        // Still streaming, or not JSON: no arguments this oracle can read.
      }
    }
    const known = byId.get(id);
    if (known) {
      if (input !== null) known.input = input;
      continue;
    }
    const call = { toolName: data.toolName, input };
    byId.set(id, call);
    calls.push(call);
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
