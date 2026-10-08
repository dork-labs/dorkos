import { randomUUID } from 'node:crypto';
import {
  McpClient,
  McpTimeoutError,
  StdioTransport,
  StreamableHttpTransport,
} from '@earendil-works/pi-mcp';
import type { JsonValue, ToolDescriptor, ToolRegistry, ToolResult } from '../contracts.js';
import { mcpAlias } from '../registry/registry.js';
/** Explicit transport configuration; no vendor settings or ambient secrets are consulted. */
export type McpTransportConfig =
  | {
      kind: 'stdio';
      command: string;
      args?: readonly string[];
      cwd?: string;
      environment: Readonly<Record<string, string>>;
    }
  | {
      kind: 'http';
      url: string;
      headers?: Readonly<Record<string, string>>;
      fetch?: typeof globalThis.fetch;
    };
/** Hard resource bounds applied to connections, requests and discovery. */
export interface McpLimits {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  maxMessageBytes?: number;
  maxDiscoveryBytes?: number;
  maxTools?: number;
  maxPages?: number;
}
interface RemoteTool {
  name: string;
  description?: string;
  inputSchema: ToolDescriptor['schema'];
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function positive(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error('Invalid MCP limit');
  return value;
}
/** Explicit endpoint fetch rejects redirects and caps JSON, errors and SSE bytes before parsing. */
export function boundedMcpFetch(
  endpoint: string,
  maxBytes: number,
  fetch_: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid MCP endpoint');
  positive(maxBytes, 16777216);
  return async (input, init) => {
    const target = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    if (target.href !== url.href) throw new Error('MCP endpoint changed');
    const response = await fetch_(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('MCP redirects refused');
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          bytes += next.value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel();
            throw new Error('MCP response exceeds byte limit');
          }
          controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
/** Standalone pinned Pi MCP connection; construction is inert and close is idempotent. */
export class McpConnection {
  private readonly client: McpClient;
  private readonly limits: Required<McpLimits>;
  private readonly transport: StdioTransport | StreamableHttpTransport;
  private closing?: Promise<void>;
  private connected = false;
  /** Configure only caller-supplied transports and explicit resource bounds. */
  constructor(
    private readonly server: string,
    config: McpTransportConfig,
    limits: McpLimits = {}
  ) {
    if (typeof server !== 'string' || !server || server.length > 512)
      throw new Error('Invalid MCP server identity');
    this.limits = {
      connectTimeoutMs: positive(limits.connectTimeoutMs ?? 10000, 300000),
      callTimeoutMs: positive(limits.callTimeoutMs ?? 30000, 300000),
      maxMessageBytes: positive(limits.maxMessageBytes ?? 1048576, 16777216),
      maxDiscoveryBytes: positive(limits.maxDiscoveryBytes ?? 4194304, 33554432),
      maxTools: positive(limits.maxTools ?? 2000, 10000),
      maxPages: positive(limits.maxPages ?? 100, 1000),
    };
    this.client = new McpClient({
      name: 'doe',
      version: '0.0.0',
      requestTimeoutMs: this.limits.callTimeoutMs,
    });
    if (config.kind === 'stdio') {
      if (
        !config.environment ||
        Object.values(config.environment).some((v) => typeof v !== 'string')
      )
        throw new Error('Explicit MCP environment required');
      this.transport = new StdioTransport({
        command: config.command,
        ...(config.args ? { args: config.args } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        env: { ...config.environment },
        inheritEnv: false,
        stderr: 'pipe',
        maxMessageBytes: this.limits.maxMessageBytes,
        maxStderrBytes: 16384,
        closeTimeoutMs: 100,
      });
    } else
      this.transport = new StreamableHttpTransport({
        url: config.url,
        headers: { ...config.headers },
        fetch: boundedMcpFetch(config.url, this.limits.maxMessageBytes, config.fetch),
        openGetStream: false,
        maxMessageBytes: this.limits.maxMessageBytes,
        reconnect: { maxRetries: 0, initialDelayMs: 10, maxDelayMs: 10 },
      });
  }
  /** Connect with an external abort/deadline wrapper because pinned connect has no signal argument. */
  async connect(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    const connecting = this.client.connect(this.transport);
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => {
        void this.close().catch(() => {});
        reject(new Error('MCP connect aborted'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => {
        void this.close().catch(() => {});
        reject(new Error('MCP connect timed out'));
      }, this.limits.connectTimeoutMs);
    });
    try {
      await Promise.race([connecting, cancelled]);
      this.connected = true;
    } catch (error) {
      void connecting.catch(() => {});
      await this.close();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  /** Discover bounded pages, validate fully, then register deferred exact aliases. */
  async registerTools(registry: ToolRegistry, signal?: AbortSignal): Promise<readonly string[]> {
    if (!this.connected) throw new Error('MCP not connected');
    const tools: RemoteTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    for (let page = 0; ; page++) {
      if (page >= this.limits.maxPages) throw new Error('MCP page limit exceeded');
      const result = await this.client.request<unknown>('tools/list', cursor ? { cursor } : {}, {
        signal,
        timeoutMs: this.limits.callTimeoutMs,
      });
      bytes += Buffer.byteLength(JSON.stringify(result));
      if (bytes > this.limits.maxDiscoveryBytes)
        throw new Error('MCP discovery byte limit exceeded');
      if (!object(result) || !Array.isArray(result.tools)) throw new Error('Invalid MCP tool page');
      for (const tool of result.tools) {
        if (
          !object(tool) ||
          typeof tool.name !== 'string' ||
          !tool.name ||
          tool.name.length > 1024 ||
          !object(tool.inputSchema) ||
          (tool.description !== undefined && typeof tool.description !== 'string')
        )
          throw new Error('Invalid MCP tool');
        tools.push(tool as unknown as RemoteTool);
        if (tools.length > this.limits.maxTools) throw new Error('MCP tool limit exceeded');
      }
      if (result.nextCursor === undefined || result.nextCursor === null || result.nextCursor === '')
        break;
      if (
        typeof result.nextCursor !== 'string' ||
        result.nextCursor.length > 4096 ||
        cursors.has(result.nextCursor)
      )
        throw new Error('Invalid or repeated MCP cursor');
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    const aliases = tools.map((t) => mcpAlias(this.server, t.name));
    if (new Set(aliases).size !== aliases.length) throw new Error('Duplicate MCP tool name');
    tools.forEach((tool, index) =>
      registry.register({
        name: aliases[index]!,
        description: (tool.description ?? tool.name).slice(0, 8192),
        searchHint: `${this.server} ${tool.name}`,
        schema: tool.inputSchema,
        execute: async (args, context) => {
          const callId = context.callId ?? randomUUID();
          return this.call(tool.name, args, context.signal, (message) =>
            context.emit({
              type: 'tool-progress',
              name: aliases[index]!,
              callId,
              scope: context.scope,
              progress: message,
            })
          );
        },
      })
    );
    return aliases;
  }
  /** Preserve results; abort/deadline closes this connection to stop underlying work. Hosts reconnect explicitly. */
  async call(
    name: string,
    args: JsonValue,
    signal: AbortSignal,
    onProgress?: (message: string) => void
  ): Promise<ToolResult> {
    try {
      if (!object(args)) throw new Error('MCP arguments must be an object');
      const result = await this.client.callTool(name, args, {
        signal,
        timeoutMs: this.limits.callTimeoutMs,
        ...(onProgress
          ? {
              onProgress: (p) =>
                onProgress(
                  typeof p.message === 'string' ? p.message.slice(0, 1024) : String(p.progress)
                ),
            }
          : {}),
      });
      return {
        content: result.content as unknown as JsonValue[],
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent as JsonValue }),
        isError: result.isError === true,
      };
    } catch (error) {
      // Pinned HTTP cancellation settles RPC only. Close the connection to abort its fetches.
      // The host must create a new connection after any aborted or timed-out call.
      if (signal.aborted || error instanceof McpTimeoutError) await this.close();
      return {
        content: [
          { type: 'text', text: signal.aborted ? 'MCP call aborted.' : 'MCP call failed.' },
        ],
        isError: true,
      };
    }
  }
  /** Close only this connection and its owned process; drain all pending client requests. */
  close(): Promise<void> {
    this.connected = false;
    return (this.closing ??= this.client.close());
  }
}
