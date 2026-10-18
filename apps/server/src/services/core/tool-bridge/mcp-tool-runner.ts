/**
 * The live {@link BridgedToolRunner}: runs a bridged tool on the hub's own
 * external MCP server, built for the calling agent, over an in-memory link.
 *
 * That server is the one `/mcp` builds per request (`routes/mcp.ts`), so a
 * bridged call meets exactly the gate an agent's own MCP call meets: every
 * hand-registered tool through `mcp-tool-gate.ts`, every capability through
 * `registry.invoke`, the agent's permission areas, and its Blocked tools left
 * out of the list. It is built as that agent and as nobody else: no signed-in
 * person (`userId` is never set) and an agent identity always presented, so
 * nothing downstream can read the call as the owner's.
 *
 * A tool's ordinary answer (an approval it needs included, which is a step
 * rather than a failure) is `ok: true` with its JSON. An `isError` answer is
 * `ok: false` with its code only: its own sentence can carry a path or a raw
 * error from inside the hub, so it stays here.
 *
 * Every call runs in its own audit scope: the agent, in the bridged session.
 * The computer is not part of the audit actor (the audit schema has no field
 * for it); the relay records which computer each call came from.
 *
 * Gap, for part 5: the external server has no invoking session, so a
 * capability that reads `sessionId` (its own chat) does not get the bridged
 * one yet.
 *
 * @module services/core/tool-bridge/mcp-tool-runner
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  RelayToolCallOutcome,
  RelayToolSummary,
} from '@dorkos/shared/session-relay-agent-computer';
import type { McpServerFactory } from '../../../routes/mcp.js';
import { runAsAgent } from '../../audit/audit-trail.js';
import type { BridgedToolRun, BridgedToolRunner } from './bridged-tool-call.js';

/**
 * The code a failed tool result carries: `denied` for the gate's refusal, the
 * handler's own code when it gave one, else `tool_error`. Its sentence never
 * crosses (the bridge says every failure in fixed words), so nothing else is
 * read from it.
 */
function codeOf(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return 'tool_error';
  const { code, status } = payload as { code?: unknown; status?: unknown };
  if (status === 'denied') return 'denied';
  return typeof code === 'string' && /^[\w.:-]{1,64}$/.test(code) ? code : 'tool_error';
}

/** A text block's JSON, or the text itself. */
function parsedText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The tool result shape the client returns, narrowed to what is read here. */
interface ToolResult {
  content?: readonly { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * A result, as the relay carries it.
 *
 * @param result - The MCP tool result.
 */
export function outcomeOfToolResult(result: ToolResult): RelayToolCallOutcome {
  const text = (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
  const payload = result.structuredContent ?? parsedText(text);
  // The gate's refusal arrives as an ordinary answer, naming areas and
  // settings: it is a failure, and crosses as one.
  if (result.isError || codeOf(payload) === 'denied') {
    return { ok: false, code: codeOf(payload), message: 'The tool could not finish.' };
  }
  return { ok: true, output: payload as Extract<RelayToolCallOutcome, { ok: true }>['output'] };
}

/**
 * The live runner over the hub's external MCP server factory.
 *
 * @param serverFactory - The factory `/mcp` uses.
 */
export function createMcpBridgedToolRunner(serverFactory: McpServerFactory): BridgedToolRunner {
  /** Connect a client to a server built for this agent, run `use`, and close both. */
  async function withAgentServer<T>(
    run: BridgedToolRun,
    use: (client: Client) => Promise<T>
  ): Promise<T> {
    // The agent, and never a person: no `userId`, a machine is calling, and
    // the caller kind rides along so the gate knows a bridged call.
    const server = await serverFactory({
      identity: run.identity,
      agentIdentityPresented: true,
      callerKind: run.caller,
    });
    const client = new Client({ name: `dorkos-${run.caller}`, version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
    try {
      // Its own audit scope, as the agent in the bridged session: never the
      // scope of whatever relay frame or request happened to deliver the call.
      return await runAsAgent(run.identity, run.sessionId, () => use(client));
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  return {
    list: (run) =>
      withAgentServer(run, async (client) => {
        const { tools } = await client.listTools();
        return tools.map((tool): RelayToolSummary => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema as RelayToolSummary['inputSchema'],
        }));
      }),
    call: (run) =>
      withAgentServer(run, async (client) => {
        const args =
          typeof run.input === 'object' && run.input !== null && !Array.isArray(run.input)
            ? (run.input as Record<string, unknown>)
            : {};
        const result = await client.callTool({ name: run.tool, arguments: args });
        return outcomeOfToolResult(result as ToolResult);
      }),
  };
}
