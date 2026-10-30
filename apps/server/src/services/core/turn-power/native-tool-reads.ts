/**
 * A runtime's own tools that read from outside (DOR-3291): a web search, a web fetch, a tool from
 * an MCP server DorkOS does not run. Seen at the registration seam, on every runtime, the moment
 * the runtime says the tool started, so the turn is marked before the tool's result exists.
 *
 * What it cannot see: a shell command that fetches a page or reads a file (Codex reads files
 * through its shell), which the shell's own hold covers on a turn already marked, and a file read
 * outside the agent's folders on Claude Code, which its after-the-tool hook marks
 * (`claude-code/tool-gate/tool-read-hook.ts`).
 *
 * @module services/core/turn-power/native-tool-reads
 */
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { markToolRead } from './tool-read-marks.js';

/** The runtimes' own web tools, lower-cased: Claude Code's and Codex's, and OpenCode's. */
const WEB_TOOLS: ReadonlySet<string> = new Set(['webfetch', 'websearch', 'web_search']);

/** DorkOS's own MCP servers, whose actions mark through the capability registry instead. */
const OWN_SERVERS: ReadonlySet<string> = new Set(['dorkos', 'dorkos_connections']);

/**
 * Whether a runtime's tool hands the turn a third party's text: one of the web tools, or a tool
 * of an MCP server DorkOS does not run (`mcp__<server>__<tool>` on Claude Code and Codex,
 * `<server>_<tool>` on OpenCode, whose own tools carry no underscore).
 *
 * @param toolName - The tool's name as the runtime reports it.
 */
export function nativeToolReadsOutside(toolName: string): boolean {
  const name = toolName.toLowerCase();
  if (WEB_TOOLS.has(name)) return true;
  const mcp = /^mcp__(.+?)__/.exec(toolName);
  if (mcp) return !OWN_SERVERS.has(mcp[1]!);
  if (!toolName.includes('_')) return false;
  return ![...OWN_SERVERS].some((server) => toolName.startsWith(`${server}_`));
}

/** A turn's events, marking its session the moment an outside-reading tool starts. */
async function* watched(
  sessionId: string,
  events: AsyncIterable<StreamEvent>
): AsyncGenerator<StreamEvent> {
  for await (const event of events) {
    if (event.type === 'tool_call_start') {
      const name = (event.data as { toolName?: unknown }).toolName;
      if (typeof name === 'string' && nativeToolReadsOutside(name)) markToolRead({ sessionId });
    }
    yield event;
  }
}

/** A turn start: `sendMessage`'s and `executeCommandIntent`'s shape. */
type AnyTurnStart = (
  sessionId: string,
  input: unknown,
  opts?: MessageOpts
) => AsyncGenerator<StreamEvent>;

/**
 * Wrap a runtime so its own outside-reading tools mark the turn running them: every turn sent
 * through it, and every turn it starts on its own. Applied at the registration seam just outside
 * the level record, so the turn is recorded before any of its tools can mark it.
 *
 * @param runtime - The runtime, already recording levels.
 */
export function markNativeReads(runtime: AgentRuntime): AgentRuntime {
  return new Proxy(runtime, {
    get(target, prop) {
      if (
        (prop === 'sendMessage' || prop === 'executeCommandIntent') &&
        typeof target[prop] === 'function'
      ) {
        const start = (target[prop] as AnyTurnStart).bind(target);
        return (sessionId: string, input: unknown, opts?: MessageOpts) =>
          watched(sessionId, start(sessionId, input, opts));
      }
      if (prop === 'onRuntimeTurn' && typeof target.onRuntimeTurn === 'function') {
        const subscribe = target.onRuntimeTurn.bind(target);
        return (listener: (sessionId: string, events: AsyncIterable<StreamEvent>) => void) =>
          subscribe((sessionId, events) => listener(sessionId, watched(sessionId, events)));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
