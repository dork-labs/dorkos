/**
 * Stream oracles: assert on the collected SSE frames — that a specific MCP tool
 * actually ran, that a `ui_command` the agent issued appears, or that a
 * return-value tool result carried the expected payload (the one legitimate
 * "return-value" oracle, for `marketplace-search`, which writes no state). These
 * read the tool/command frames, never assistant prose.
 *
 * {@link toolResultPayloads} is the shared primitive for a case whose outcome
 * lives in the STRUCTURE of a tool result rather than a substring — the
 * governance case has to tell one gating payload apart from another, which a
 * `contains` check cannot do.
 *
 * ## TOOL NAMES ON THE WIRE ARE FULLY QUALIFIED
 *
 * Every oracle here matches through {@link toolNameMatches}, never by `===`. An
 * in-session DorkOS tool is registered on an SDK MCP server called `dorkos`
 * (`createSdkMcpServer({ name: 'dorkos' })`), so the model's `tool_use` block is
 * named `mcp__dorkos__<tool>` — and that RAW name is what lands on the durable
 * stream: both projections assign `toolName: block.name` verbatim
 * (`claude-code/sessions/transcript-parser.ts`,
 * `claude-code/sdk/event-mappers/stream-event-mapper.ts`) and nothing downstream
 * strips the prefix. An eval that compared the bare `marketplace_uninstall`
 * therefore reported "the agent never called the tool" on a turn where the agent
 * called it and the gate worked — a false red that reads like model behavior.
 * Matching the suffix keeps the eval honest without changing what the server
 * emits (other consumers depend on the qualified name).
 *
 * @module evals/oracles/stream
 */
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { Oracle } from '../types.js';

/** A durable tool frame's data payload (reuses the `ToolCallEvent` shape). */
interface ToolFrameData {
  type?: string;
  toolName?: string;
  result?: string;
}

/** A durable `ui_command` frame's data payload. */
interface UiCommandFrameData {
  type?: string;
  command?: unknown;
}

/** A durable `turn_start` frame's data payload — carries the trigger `userMessage` (ADR-0264). */
interface TurnStartFrameData {
  type?: string;
  userMessage?: string;
}

/** All frames of a given SessionEvent `type` from the collected stream. */
function framesOfType(frames: SseFrame[], type: string): SseFrame[] {
  return frames.filter((f) => f.event === type || (f.data as { type?: string })?.type === type);
}

/**
 * Whether a durable frame's `toolName` names the tool `name`, tolerating the MCP
 * server qualification the SDK puts on it (`mcp__dorkos__<name>`).
 *
 * Matches the exact name or any `…__<name>` suffix. The separator is part of the
 * comparison on purpose: `marketplace_install` must NOT match
 * `mcp__dorkos__marketplace_uninstall`, and a bare `install` must not match
 * `mcp__dorkos__marketplace_install`. The widening does mean a DIFFERENT MCP
 * server exposing the same tool name would also match — acceptable here, because
 * an eval sandbox boots exactly one MCP server (`dorkos`).
 *
 * @param observed - The `toolName` a durable frame carried.
 * @param name - The unqualified tool name the eval asserts on.
 * @returns True when `observed` names that tool.
 */
export function toolNameMatches(observed: string | undefined, name: string): boolean {
  if (observed === undefined) return false;
  return observed === name || observed.endsWith(`__${name}`);
}

/** Every frame of `type` whose `toolName` names `toolName` (qualified or bare). */
function toolFramesFor(frames: SseFrame[], type: string, toolName: string): SseFrame[] {
  return framesOfType(frames, type).filter((f) =>
    toolNameMatches((f.data as ToolFrameData).toolName, toolName)
  );
}

/** Every distinct `toolName` the stream carried, for failure evidence. */
function observedToolNames(frames: SseFrame[], type: string): string[] {
  const names = framesOfType(frames, type)
    .map((f) => (f.data as ToolFrameData).toolName)
    .filter((n): n is string => typeof n === 'string' && n !== '');
  return [...new Set(names)];
}

/**
 * Oracle: a `tool_call` for `toolName` appears in the collected stream (the
 * model chose and invoked that tool). The unqualified name is enough — see
 * {@link toolNameMatches}.
 *
 * @param toolName - The MCP tool that must have run (e.g. `marketplace_install`).
 * @param label - Human-readable label; defaults to `tool <name> invoked`.
 * @returns An {@link Oracle}.
 */
export function toolInvokedInStream(toolName: string, label?: string): Oracle {
  return async (ctx) => {
    const matches = toolFramesFor(ctx.frames, 'tool_call', toolName);
    const passed = matches.length > 0;
    return {
      label: label ?? `tool ${toolName} invoked`,
      passed,
      evidence: {
        toolName,
        invocations: matches.length,
        // The names actually on the stream, so "never called" can be told apart
        // from "called under a name this oracle failed to match".
        observedToolNames: observedToolNames(ctx.frames, 'tool_call'),
      },
      detail: passed ? undefined : `no tool_call frame for ${toolName}`,
    };
  };
}

/**
 * Oracle: a `tool_result` for `toolName` carries a `result` string containing
 * `needle` — the return-value oracle for a stateless tool (`marketplace_search`
 * returns matches but writes no state).
 *
 * @param toolName - The tool whose result is inspected.
 * @param needle - Substring the tool result must contain.
 * @param label - Human-readable label; defaults to a contains message.
 * @returns An {@link Oracle}.
 */
export function toolResultContains(toolName: string, needle: string, label?: string): Oracle {
  return async (ctx) => {
    const results = toolFramesFor(ctx.frames, 'tool_result', toolName);
    const passed = results.some((f) => (f.data as ToolFrameData).result?.includes(needle));
    return {
      label: label ?? `tool ${toolName} result contains "${needle}"`,
      passed,
      evidence: {
        toolName,
        needle,
        resultCount: results.length,
        observedToolNames: observedToolNames(ctx.frames, 'tool_result'),
      },
      detail: passed ? undefined : `no ${toolName} tool_result contained "${needle}"`,
    };
  };
}

/** Longest prefix of an unparsable result kept as failure evidence. */
const UNPARSED_EVIDENCE_CHARS = 200;

/** Parsed and unparsable `tool_result` texts for one tool, in stream order. */
export interface ToolResultPayloads {
  /** Result texts that parsed as JSON. */
  payloads: unknown[];
  /** Result texts that did NOT parse as JSON, truncated for evidence. */
  unparsed: string[];
  /**
   * Every distinct `toolName` the stream's `tool_result` frames carried, matched
   * or not. Lets a caller's failure evidence distinguish "the tool returned
   * nothing" from "the tool ran under a name this collector did not match".
   */
  observedToolNames: string[];
}

/**
 * Parse one result text into a JSON value, tolerating surrounding text.
 *
 * A capability's MCP result is `JSON.stringify(payload, null, 2)`, but the text a
 * runtime records around it is not guaranteed to be exactly that string (the
 * claude-code mapper, for example, prefixes an embedded-resource marker onto a
 * `ui://` result). So a strict parse is tried first, then the outermost
 * `{ … }` span. Returns `undefined` when neither yields JSON.
 */
function parseResultJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the embedded-object attempt.
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Every `tool_result` payload `toolName` returned, parsed as JSON.
 *
 * Use this when an outcome is decided by the SHAPE of a result rather than a
 * substring of it — two different gating protocols can both mention the same
 * words, and only their fields tell them apart. Callers own the discrimination;
 * this only collects and parses.
 *
 * @param frames - The collected SSE frames.
 * @param toolName - The tool whose results to collect, unqualified (the MCP
 *   server prefix on the wire is tolerated — see {@link toolNameMatches}).
 * @returns The parsed payloads, any result text that was not JSON, and every
 *   tool name the stream carried.
 */
export function toolResultPayloads(frames: SseFrame[], toolName: string): ToolResultPayloads {
  const texts = toolFramesFor(frames, 'tool_result', toolName)
    .map((f) => (f.data as ToolFrameData).result)
    .filter((r): r is string => typeof r === 'string' && r.length > 0);

  const payloads: unknown[] = [];
  const unparsed: string[] = [];
  for (const text of texts) {
    const parsed = parseResultJson(text);
    if (parsed === undefined) unparsed.push(text.slice(0, UNPARSED_EVIDENCE_CHARS));
    else payloads.push(parsed);
  }
  return { payloads, unparsed, observedToolNames: observedToolNames(frames, 'tool_result') };
}

/**
 * Oracle: a `ui_command` frame whose `command` satisfies `predicate` appears —
 * proof the agent issued the expected imperative UI command (e.g. open the
 * tasks panel, switch agent).
 *
 * @param predicate - Tests the frame's `command` payload.
 * @param label - Human-readable label; defaults to `ui_command emitted`.
 * @returns An {@link Oracle}.
 */
export function uiCommandEmitted(predicate: (command: unknown) => boolean, label?: string): Oracle {
  return async (ctx) => {
    const commands = framesOfType(ctx.frames, 'ui_command')
      .map((f) => (f.data as UiCommandFrameData).command)
      .filter((c) => c !== undefined);
    const passed = commands.some((c) => predicate(c));
    return {
      label: label ?? 'ui_command emitted',
      passed,
      evidence: { commandCount: commands.length },
      detail: passed ? undefined : 'no ui_command frame matched the predicate',
    };
  };
}

/**
 * Oracle: a `turn_start` frame's injected trigger content (`userMessage`) is the
 * `<ui_action>` block for `actionId` — proof a widget action POSTed to
 * `/api/sessions/:id/ui-action` started a real NEW turn carrying that exact
 * action (the `widget-round-trip` structural eval, §6 note 7). Asserts the
 * runtime-neutral injected user message (`formatUiActionMessage`, which rides
 * `turn_start.userMessage`, ADR-0264), NEVER the assistant's prose.
 *
 * @param actionId - The widget action id that must appear in the trigger block.
 * @param label - Human-readable label; defaults to a round-trip message.
 * @returns An {@link Oracle}.
 */
export function uiActionTriggerObserved(actionId: string, label?: string): Oracle {
  return async (ctx) => {
    const triggers = framesOfType(ctx.frames, 'turn_start')
      .map((f) => (f.data as TurnStartFrameData).userMessage)
      .filter((m): m is string => typeof m === 'string');
    const matched = triggers.find(
      (m) => m.includes('<ui_action>') && m.includes(`Action: ${actionId}`)
    );
    const passed = matched !== undefined;
    return {
      label: label ?? `widget action "${actionId}" started a new turn`,
      passed,
      evidence: { actionId, turnStarts: triggers.length, matched },
      detail: passed ? undefined : `no turn_start carried a <ui_action> trigger for "${actionId}"`,
    };
  };
}
